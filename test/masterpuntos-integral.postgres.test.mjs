import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';
import auth from '../src/plugins/auth.js';
import privateCommerce from '../src/plugins/privateCommerce.js';
import operationalRoutes from '../src/routes/v1/admin/citas.js';
import clientePointsRoutes from '../src/routes/v1/clientePoints.js';
import publicCitasRoutes from '../src/routes/v1/public/citas.js';
import {
  addManualPointsAdjustment, applyRewardRedeemForConfirmedGroup, getClientePointsSummary, redeemReward,
  resolveRedeemContextForHold, resolveRewardRedeemGateForCliente,
} from '../src/services/pointsService.js';

const BIN = process.env.MASTERFADE_PHASE02_PG_BIN;
const migration = new URL('../db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql', import.meta.url);
const sqlFile = name => readFile(new URL(`./sql/${name}`, import.meta.url), 'utf8');

test('MasterPuntos integral: PostgreSQL real aislado, ciclos, controladores y canjes', { skip: !BIN, timeout: 180000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mf-points-integral-')), data = path.join(dir, 'data');
  let started = false, pool, app;
  const binary = (name, args) => {
    const result = spawnSync(path.join(BIN, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  t.after(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (started) binary('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('mf-points-integral-'));
    await rm(dir, { recursive: true, force: true });
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  binary('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C', '--no-sync']);
  binary('pg_ctl', ['-D', data, '-l', path.join(dir, 'pg.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  started = true;
  pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 6, options: '-c timezone=UTC' });
  await pool.query(await sqlFile('masterpuntos-integral-fixture.sql'));
  await pool.query(await sqlFile('masterpuntos-legacy-functions.sql'));
  await pool.query(await sqlFile('mf118-points-fixture.sql'));
  await pool.query(await readFile(new URL('../db/migrations/20261030010000_masterpuntos_readonly_expiration_v1.sql', import.meta.url), 'utf8'));
  await pool.query(`
    CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo,id_cita,origen_punto_codigo ON points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final();
    CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo,puntos ON points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign();
    CREATE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita();
  `);
  const branch = randomUUID(), otherBranch = randomUUID(), barber = randomUUID(), barberPerson = randomUUID();
  const service = randomUUID(), memberService = randomUUID(), plan = randomUUID();
  await pool.query("INSERT INTO sucursales VALUES($1,'Centro',NULL,true),($2,'Otra',NULL,true)", [branch, otherBranch]);
  await pool.query("INSERT INTO personas VALUES($1,'Barbero','Sintetico',NULL)", [barberPerson]);
  await pool.query('INSERT INTO empleados VALUES($1,$2)', [barber, barberPerson]);
  await pool.query("INSERT INTO servicios(id_servicio,nombre_servicio) VALUES($1,'Corte autorizado'),($2,'Beneficio VIP')", [service, memberService]);
  await pool.query('INSERT INTO servicios_tarifas(id_servicio,id_sucursal) VALUES($1,$3),($2,$3)', [service, memberService, branch]);
  await pool.query("INSERT INTO points_rule_services SELECT id_rule,$1,'sin_membresia',true,true,1 FROM points_rules", [service]);
  await pool.query("INSERT INTO points_rule_services SELECT id_rule,$1,'con_membresia',true,true,1 FROM points_rules", [memberService]);
  await pool.query("INSERT INTO membership_plans VALUES($1,'VIP fixture','Sintetico','mensual',1)", [plan]);
  const createClient = async (member = false) => {
    const id = randomUUID(), person = randomUUID(), user = randomUUID();
    await pool.query("INSERT INTO personas VALUES($1,'Cliente','Sintetico',NULL)", [person]);
    await pool.query('INSERT INTO clientes(id_cliente,id_usuario,id_persona,id_sucursal_origen) VALUES($1,$2,$3,$4)', [id, user, person, branch]);
    await pool.query('INSERT INTO usuarios(id_usuario,id_persona) VALUES($1,$2)', [user, person]);
    if (member) await pool.query(`INSERT INTO subscriptions(id_suscripcion,id_cliente,id_plan,estado_suscripcion_codigo,inicio_at,fin_at,id_sucursal_contratada,beneficios_snapshot)
      VALUES(gen_random_uuid(),$1,$2,'activa',now()-interval '1 day',now()+interval '1 year',$3,$4)`,
    [id, plan, branch, { version: 1, items: [{ tipo: 'servicio', id_servicio: memberService, nombre: 'VIP', cantidad: 100 }] }]);
    return { id, person, user, member };
  };
  const insert = async (owner, { group = null, order = 1, reward = false, state = 'confirmada', amount = 0, start = new Date(Date.now() - 3600000), atBranch = branch } = {}) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO citas(id_cita,id_cliente,id_persona_cliente,id_grupo_cita,id_sucursal,id_empleado_barbero,
      orden_integrante,es_canje_recompensa,estado_cita_codigo,total_pagar_hnl,inicio_at,fin_at,contacto_nombre)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11::timestamptz+interval '30 minutes','Invitado fixture')`,
    [id, owner?.id || null, owner?.person || null, group, atBranch, barber, order, reward, state, amount, start]);
    return id;
  };
  const balance = async id => Number((await pool.query('SELECT balance_puntos FROM vw_points_balance WHERE id_cliente=$1', [id])).rows[0]?.balance_puntos || 0);
  const complete = id => pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1", [id]);
  const tx = async action => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const credit = async (owner, count) => { for (let i = 0; i < count; i++) await complete(await insert(owner)); };
  const makeReward = async (owner, status = 'confirmada') => {
    const group = randomUUID();
    await pool.query('INSERT INTO citas_grupos VALUES($1,$2)', [group, owner.id]);
    const id = await insert(owner, { group, reward: true, state: status });
    await pool.query('INSERT INTO citas_detalles(id_cita_detalle,id_cita,id_servicio,subtotal_hnl) VALUES(gen_random_uuid(),$1,$2,100)', [id, owner.member ? memberService : service]);
    return { group, id };
  };
  const prepare = owner => redeemReward({ db: pool }, { idCliente: owner.id, idSucursal: branch, idServicioCanje: owner.member ? memberService : service });
  const confirm = (owner, reward, token) => tx(client => applyRewardRedeemForConfirmedGroup(client, { idGrupoCita: reward.group, idCliente: owner.id, canjeContextToken: token }));

  await t.test('reproduce ambas versiones de ciclo: sin vencimiento y NULL convertido en un mes', async () => {
    const a = await createClient(), b = await createClient();
    await tx(async client => {
      const two = (await client.query('SELECT * FROM fn_points_get_or_create_active_cycle($1::uuid,now())', [a.id])).rows[0];
      assert.equal(two.vence_at, null);
      const three = (await client.query('SELECT * FROM fn_points_get_or_create_active_cycle($1::uuid,NULL::int,now())', [b.id])).rows[0];
      assert.equal((await client.query("SELECT $1::timestamptz = $2::timestamptz+interval '1 month' AS wrong", [three.vence_at, three.primer_acumulado_at])).rows[0].wrong, true);
    });
    await pool.query('DELETE FROM points_cycles WHERE id_cliente=ANY($1::uuid[])', [[a.id, b.id]]);
  });
  const migrationSql = await readFile(migration, 'utf8');
  await t.test('reproduce doble vencimiento al omitir el ciclo del débito de canje', async () => {
    const owner = await createClient();
    await tx(async client => {
      const cycle = (await client.query("INSERT INTO points_cycles(id_cliente,primer_acumulado_at,vence_at) VALUES($1,now()-interval '13 months',now()-interval '1 month') RETURNING id_cycle", [owner.id])).rows[0].id_cycle;
      await client.query("INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos) VALUES($1,$2,'acumular',10),($1,NULL,'canjear',-10)", [owner.id, cycle]);
    });
    assert.equal(await balance(owner.id), -10);
    await pool.query('DELETE FROM points_transactions WHERE id_cliente=$1', [owner.id]);
    await pool.query('DELETE FROM points_cycles WHERE id_cliente=$1', [owner.id]);
  });
  await t.test('ACOMPANANTES-01: preflight exige metadatos autoritativos de grupo', async () => {
    const guard = migrationSql.slice(migrationSql.indexOf('DO $preflight$'), migrationSql.indexOf('$preflight$;') + '$preflight$;'.length);
    await assert.rejects(tx(async client => {
      await client.query('ALTER TABLE citas_grupos RENAME COLUMN origen_codigo TO origen_ausente_fixture');
      await client.query(guard);
    }), /MASTERPUNTOS_PREFLIGHT_GROUP_METADATA_REQUIRED/);
    assert.ok((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='citas_grupos' AND column_name='origen_codigo'")).rowCount);
  });
  await t.test('PREFLIGHT-02: historia cerrada anterior al ciclo, sin cambios de datos', async suite => {
    const readOnlySql = await readFile(new URL('../db/manual/masterpuntos_integral_preflight.sql', import.meta.url), 'utf8');
    const proof = sql => sql.replace(/\r\n/g, '\n').split('-- AM: BEGIN HISTORICAL_DEBITS_PROOF\n')[1].split('-- AM: END HISTORICAL_DEBITS_PROOF')[0];
    assert.equal(proof(migrationSql), proof(readOnlySql), 'Diagnostico y bloqueo utilizan exactamente la misma prueba');
    const guard = migrationSql.slice(migrationSql.indexOf('DO $preflight$'), migrationSql.indexOf('$preflight$;') + '$preflight$;'.length);
    const oldGuard = `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM public.points_transactions debit
        WHERE debit.puntos < 0 AND debit.tipo_puntos_codigo <> 'vencimiento' AND debit.id_cycle IS NULL
          AND EXISTS (SELECT 1 FROM public.points_cycles pc
            JOIN public.points_transactions credit ON credit.id_cycle = pc.id_cycle AND credit.puntos > 0
            WHERE pc.id_cliente = debit.id_cliente AND pc.estado_ciclo_codigo = 'activo')) THEN
        RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED';
      END IF; END $$;`;
    const snapshot = async () => (await pool.query(`SELECT jsonb_build_object(
      'movimientos', (SELECT jsonb_agg(to_jsonb(pt) ORDER BY pt.id_points_tx) FROM public.points_transactions pt),
      'ciclos', (SELECT jsonb_agg(to_jsonb(pc) ORDER BY pc.id_cycle) FROM public.points_cycles pc),
      'saldos', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id_cliente) FROM public.vw_points_balance v)
    ) AS data`)).rows[0].data;
    const definitions = async () => (await pool.query(`SELECT p.oid::regprocedure::text AS firma, pg_get_functiondef(p.oid) AS definicion
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('fn_points_get_or_create_active_cycle','fn_points_tx_guard_acumular_final',
        'fn_trg_otorgar_puntos_por_cita','fn_trg_otorgar_puntos_plan_confirmada') ORDER BY firma`)).rows;
    const seed = async () => {
      const owner = await createClient(), cycle = randomUUID(), plus = randomUUID(), minus = randomUUID(), current = randomUUID();
      const anchor = new Date(Date.now() - 86400000), first = new Date(anchor.getTime() - 4 * 86400000), second = new Date(first.getTime() + 3600000);
      await pool.query(`INSERT INTO public.points_cycles(id_cycle,id_cliente,primer_acumulado_at,vence_at,created_at,updated_at)
        VALUES($1,$2,$3,$3::timestamptz+interval '12 months',$3,$3)`, [cycle, owner.id, anchor]);
      await pool.query(`INSERT INTO public.points_transactions(id_points_tx,id_cliente,id_cycle,tipo_puntos_codigo,puntos,created_at,updated_at)
        VALUES($1,$4,NULL,'ajustar',10,$5,$5),($2,$4,NULL,'canjear',-10,$6,$6),($3,$4,$7,'acumular',1,$8,$8)`,
      [plus, minus, current, owner.id, first, second, cycle, anchor]);
      return { ...owner, cycle, plus, minus, current, anchor, first, second };
    };
    // AM: Limpieza exclusiva de fixtures aleatorios en el cluster efimero; nunca registros remotos.
    const clear = async owners => {
      await pool.query('DELETE FROM public.points_transactions WHERE id_cliente=ANY($1::uuid[])', [owners.map(o => o.id)]);
      await pool.query('DELETE FROM public.points_cycles WHERE id_cliente=ANY($1::uuid[])', [owners.map(o => o.id)]);
    };
    const inspect = async owner => {
      const results = await pool.query(readOnlySql);
      return results.find(result => result.fields.some(field => field.name === 'historico_compensado_seguro')).rows.find(row => row.id_cliente === owner.id);
    };
    await suite.test('caso observado +10/-10 anteriores y +1 vigente: pasa en UTC/Honduras, sin recalcular', async () => {
      const owner = await seed();
      try {
        const before = await snapshot(), priorDefinitions = await definitions();
        await assert.rejects(pool.query(oldGuard), /MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED/);
        for (const zone of ['UTC', 'America/Tegucigalpa']) {
          const connection = await pool.connect();
          try {
            await connection.query("SELECT set_config('TimeZone',$1,false)", [zone]);
            await connection.query(guard);
          } finally { await connection.query("SET TimeZone='UTC'"); connection.release(); }
        }
        const report = await inspect(owner);
        assert.equal(report.historico_compensado_seguro, true);
        assert.deepEqual(report.motivos_revision, []);
        assert.equal(Number(report.neto_historico), 0); assert.equal(Number(report.saldo_ciclo), 1);
        assert.equal(Number(report.saldo_ledger), 1); assert.equal(report.saldo_efectivo, 1);
        await pool.query(migrationSql.replace(/COMMIT;\s*$/, 'ROLLBACK;'));
        assert.deepEqual(await definitions(), priorDefinitions, 'Reversion transaccional de DDL conserva las definiciones previas');
        assert.deepEqual(await snapshot(), before);
        await pool.query(migrationSql);
        assert.deepEqual(await snapshot(), before, 'Incluso la aplicacion completa conserva cada fecha, punto y ciclo');
      } finally { await clear([owner]); }
    });
    await suite.test('varios bloques historicos conocidos y totalmente compensados conservan saldo 1', async () => {
      const owner = await seed();
      try {
        await pool.query(`INSERT INTO public.points_transactions(id_cliente,tipo_puntos_codigo,puntos,created_at,updated_at)
          VALUES($1,'ajustar',3,$2::timestamptz+interval '2 hours',$2::timestamptz+interval '2 hours'),
          ($1,'ajuste_resta',-3,$2::timestamptz+interval '3 hours',$2::timestamptz+interval '3 hours')`, [owner.id, owner.second]);
        const before = await snapshot(); await pool.query(guard);
        assert.equal((await inspect(owner)).historico_compensado_seguro, true);
        assert.deepEqual(await snapshot(), before);
      } finally { await clear([owner]); }
    });
    const negativeCases = [
      ['diferencia positiva', o => pool.query('UPDATE points_transactions SET puntos=11 WHERE id_points_tx=$1', [o.plus]), 'historial_no_compensado'],
      ['diferencia negativa', o => pool.query('UPDATE points_transactions SET puntos=9 WHERE id_points_tx=$1', [o.plus]), 'historial_no_compensado'],
      ['neto cero con canje distinto de diez', o => pool.query('UPDATE points_transactions SET puntos=CASE WHEN id_points_tx=$1 THEN 11 ELSE -11 END WHERE id_points_tx=ANY($2::uuid[])', [o.plus, [o.plus, o.minus]]), 'tipos_o_signos_ambiguos'],
      ['debito anterior al credito', o => pool.query(`UPDATE points_transactions SET created_at=$2::timestamptz-interval '1 hour',updated_at=$2::timestamptz-interval '1 hour' WHERE id_points_tx=$1`, [o.minus, o.first]), 'debito_sin_credito_previo'],
      ['fechas empatadas', o => pool.query('UPDATE points_transactions SET created_at=$2,updated_at=$2 WHERE id_points_tx=$1', [o.minus, o.first]), 'orden_historico_ambiguo'],
      ['debito dentro del ciclo', o => pool.query(`UPDATE points_transactions SET created_at=$2::timestamptz+interval '1 hour',updated_at=$2::timestamptz+interval '1 hour' WHERE id_points_tx=$1`, [o.minus, o.anchor]), 'periodos_superpuestos'],
      ['limite exacto al inicio del ciclo', o => pool.query('UPDATE points_transactions SET created_at=$2,updated_at=$2 WHERE id_points_tx=$1', [o.minus, o.anchor]), 'periodos_superpuestos'],
      ['edicion posterior de movimiento antiguo', o => pool.query(`UPDATE points_transactions SET updated_at=$2::timestamptz+interval '1 hour' WHERE id_points_tx=$1`, [o.plus, o.anchor]), 'periodos_superpuestos'],
      ['fecha de creacion ausente', o => pool.query('UPDATE points_transactions SET created_at=NULL WHERE id_points_tx=$1', [o.plus]), 'fechas_no_verificables'],
      ['fecha de modificacion ausente', o => pool.query('UPDATE points_transactions SET updated_at=NULL WHERE id_points_tx=$1', [o.plus]), 'fechas_no_verificables'],
      ['modificacion anterior a creacion', o => pool.query(`UPDATE points_transactions SET updated_at=created_at-interval '1 second' WHERE id_points_tx=$1`, [o.plus]), 'fechas_no_verificables'],
      ['fecha no finita', o => pool.query("UPDATE points_transactions SET created_at='-infinity' WHERE id_points_tx=$1", [o.plus]), 'fechas_no_verificables'],
      ['tipo desconocido', o => pool.query('UPDATE points_transactions SET tipo_puntos_codigo=NULL WHERE id_points_tx=$1', [o.plus]), 'tipos_o_signos_ambiguos'],
      ['tipo del debito desconocido', o => pool.query('UPDATE points_transactions SET tipo_puntos_codigo=NULL WHERE id_points_tx=$1', [o.minus]), 'tipos_o_signos_ambiguos'],
      ['debito por vencimiento sin ciclo no se omite', o => pool.query("UPDATE points_transactions SET tipo_puntos_codigo='vencimiento' WHERE id_points_tx=$1", [o.minus]), 'tipos_o_signos_ambiguos'],
      ['vencimiento individual sin ciclo', o => pool.query("UPDATE points_transactions SET vence_at=now()+interval '1 year' WHERE id_points_tx=$1", [o.plus]), 'vencimientos_historicos_ambiguos'],
      ['credito del ciclo anterior a su inicio', o => pool.query(`UPDATE points_transactions SET created_at=$2::timestamptz-interval '1 second',updated_at=$2::timestamptz-interval '1 second' WHERE id_points_tx=$1`, [o.current, o.anchor]), 'movimientos_del_ciclo_inconsistentes'],
      ['saldo actual negativo', o => pool.query("INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos,created_at,updated_at) VALUES($1,$2,'ajuste_resta',-2,$3,$3)", [o.id, o.cycle, o.anchor]), 'saldo_inconsistente'],
      ['movimientos de otro ciclo incluso con neto cero', o => pool.query(`WITH old_cycle AS (
          INSERT INTO points_cycles(id_cliente,primer_acumulado_at,vence_at,estado_ciclo_codigo)
          VALUES($1,$2::timestamptz-interval '2 years',$2::timestamptz-interval '1 year','cerrado') RETURNING id_cycle
        ) INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos,created_at,updated_at)
        SELECT $1,old_cycle.id_cycle,v.tipo,v.puntos,$2::timestamptz-interval '2 years',$2::timestamptz-interval '2 years'
        FROM old_cycle CROSS JOIN (VALUES('ajustar',5),('ajuste_resta',-5)) v(tipo,puntos)`, [o.id, o.anchor]), 'otros_ciclos_requieren_revision'],
      ['vencimiento ambiguo sin ciclo aunque neto cero', o => pool.query("INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos,created_at,updated_at) VALUES($1,'ajustar',1,$2::timestamptz+interval '2 hours',$2::timestamptz+interval '2 hours'),($1,'vencimiento',-1,$2::timestamptz+interval '3 hours',$2::timestamptz+interval '3 hours')", [o.id, o.second]), 'tipos_o_signos_ambiguos'],
    ];
    for (const [name, mutate, reason] of negativeCases) await suite.test('bloquea ' + name + ' sin modificar datos', async () => {
      const owner = await seed();
      try {
        await mutate(owner); const before = await snapshot();
        const report = await inspect(owner); assert.equal(report.historico_compensado_seguro, false);
        assert.ok(report.motivos_revision.includes(reason), JSON.stringify(report.motivos_revision));
        await assert.rejects(pool.query(guard), /MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED/);
        assert.deepEqual(await snapshot(), before);
      } finally { await clear([owner]); }
    });
    await suite.test('no compensa saldos entre Clientes ni permite que un Cliente seguro oculte otro inconsistente', async () => {
      const a = await seed(), b = await seed();
      try {
        await pool.query('UPDATE points_transactions SET puntos=11 WHERE id_points_tx=$1', [a.plus]);
        await pool.query('UPDATE points_transactions SET puntos=9 WHERE id_points_tx=$1', [b.plus]);
        assert.equal((await inspect(a)).historico_compensado_seguro, false);
        assert.equal((await inspect(b)).historico_compensado_seguro, false);
        await assert.rejects(pool.query(guard), /MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED/);
        await pool.query('UPDATE points_transactions SET puntos=10 WHERE id_points_tx=$1', [a.plus]);
        assert.equal((await inspect(a)).historico_compensado_seguro, true);
        await assert.rejects(pool.query(guard), /MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED/);
      } finally { await clear([a, b]); }
    });
    await suite.test('movimientos de otro ciclo o de otro Cliente no se asignan ni se compensan arbitrariamente', async () => {
      const a = await seed(), b = await seed();
      try {
        await pool.query('UPDATE points_transactions SET id_cycle=$2 WHERE id_points_tx=$1', [b.current, a.cycle]);
        const before = await snapshot();
        const report = await inspect(a); assert.equal(report.historico_compensado_seguro, false);
        assert.ok(report.motivos_revision.includes('movimientos_del_ciclo_inconsistentes'));
        await assert.rejects(pool.query(guard), /MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED/);
        assert.deepEqual(await snapshot(), before);
      } finally { await clear([a, b]); }
    });
    await suite.test('rechaza una diferencia entre la vista efectiva y el ledger; no corrige la vista ni el saldo', async () => {
      const owner = await seed(), connection = await pool.connect();
      const before = await snapshot(), priorDefinitions = await definitions();
      try {
        await connection.query('BEGIN');
        // AM: Vista inconsistente sintetica, revertida junto con toda la transaccion local.
        await connection.query('CREATE OR REPLACE VIEW public.vw_points_balance AS SELECT id_cliente,(sum(puntos)+1)::int AS balance_puntos FROM public.points_transactions GROUP BY id_cliente');
        const report = (await connection.query(proof(migrationSql) + 'SELECT * FROM historical_debits_evaluation WHERE id_cliente=$1', [owner.id])).rows[0];
        assert.ok(report.motivos_revision.includes('saldo_inconsistente'));
        await assert.rejects(connection.query(guard), /MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED/);
      } finally {
        await connection.query('ROLLBACK'); connection.release();
        assert.deepEqual(await snapshot(), before); assert.deepEqual(await definitions(), priorDefinitions);
        await clear([owner]);
      }
    });
    await suite.test('la comprobacion definitiva espera escrituras concurrentes y revisa el saldo ya confirmado', async () => {
      const owner = await seed(), writer = await pool.connect(), applying = await pool.connect();
      let attempt;
      try {
        const priorDefinitions = await definitions();
        await writer.query('BEGIN');
        await writer.query("INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos) VALUES($1,'ajustar',1)", [owner.id]);
        attempt = applying.query(migrationSql).then(() => null, error => error);
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          waiting = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND relation='public.points_transactions'::regclass) waiting", [applying.processID])).rows[0].waiting;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'La migracion espera el lock del ledger');
        await writer.query('COMMIT');
        const before = await snapshot(), error = await attempt;
        assert.match(error?.message || '', /MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED/);
        await applying.query('ROLLBACK');
        assert.deepEqual(await snapshot(), before); assert.deepEqual(await definitions(), priorDefinitions);
      } finally {
        await writer.query('ROLLBACK');
        if (attempt) await attempt;
        await applying.query('ROLLBACK'); writer.release(); applying.release(); await clear([owner]);
      }
    });
  });
  await pool.query(migrationSql);

  await t.test('solo completar acredita un punto, importe cero o positivo, membresía o sin membresía', async () => {
    for (const member of [false, true]) for (const amount of [0, 300]) {
      const owner = await createClient(member), id = await insert(owner, { amount });
      await pool.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1", [id]);
      assert.equal(await balance(owner.id), 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [owner.id])).rows[0].n, 0);
      await complete(id); await complete(id);
      assert.equal(await balance(owner.id), 1);
      const cycle = (await pool.query("SELECT pc.*,pc.vence_at=pc.primer_acumulado_at+interval '12 months' annual,abs(extract(epoch FROM pc.primer_acumulado_at-now()))<10 recent FROM points_cycles pc WHERE id_cliente=$1", [owner.id])).rows[0];
      assert.equal(cycle.annual, true); assert.equal(cycle.recent, true);
    }
  });
  await t.test('grupo publico: titular, registrados e invitado conservan su atribucion anterior', async () => {
    const owners = await Promise.all([createClient(), createClient(true), createClient()]), group = randomUUID();
    await pool.query('INSERT INTO citas_grupos VALUES($1,$2)', [group, owners[0].id]);
    const ids = await Promise.all([...owners, null].map((owner, i) => insert(owner, { group, order: i + 1 })));
    await Promise.all(ids.map(complete));
    for (const owner of owners) assert.equal(await balance(owner.id), 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_transactions WHERE id_cita=ANY($1::uuid[])', [ids])).rows[0].n, 3);
  });
  await t.test('ACOMPANANTES-01: todos los puntos de grupos autenticados pertenecen al titular', async suite => {
    const identities = async ids => (await pool.query(`SELECT id_cita,id_cliente,id_persona_cliente,id_grupo_cita,
      orden_integrante,id_empleado_barbero,id_sucursal,contacto_nombre,contacto_email,inicio_at,fin_at
      FROM citas WHERE id_cita=ANY($1::uuid[]) ORDER BY id_cita`, [ids])).rows;
    const authGroup = async owner => {
      const group = randomUUID();
      await pool.query("INSERT INTO citas_grupos(id_grupo_cita,id_cliente_titular,origen_codigo) VALUES($1,$2,'cliente_autenticado')", [group, owner?.id || null]);
      return group;
    };
    for (const member of [false, true]) for (const count of [1, 2, 3, 4]) for (const kind of ['registrados', 'invitados', 'mixtos']) {
      await suite.test(`${count} acompanantes ${kind}, membresia titular=${member}: +${count + 1} solo al titular`, async () => {
        const owner = await createClient(member), group = await authGroup(owner), companions = [], ids = [await insert(owner, { group })];
        for (let i = 0; i < count; i++) {
          const registered = kind === 'registrados' || (kind === 'mixtos' && i % 2 === 0);
          const companion = registered ? await createClient(!member) : null;
          companions.push(companion); ids.push(await insert(companion, { group, order: i + 2, amount: i % 2 ? 300 : 0 }));
        }
        const before = await identities(ids);
        assert.equal(await balance(owner.id), 0);
        await Promise.all(ids.map(complete)); await Promise.all([...ids, ...ids].map(complete));
        assert.equal(await balance(owner.id), count + 1);
        for (const companion of companions.filter(Boolean)) {
          assert.equal(await balance(companion.id), 0);
          assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [companion.id])).rows[0].n, 0);
        }
        assert.deepEqual(await identities(ids), before);
        const points = (await pool.query('SELECT id_cliente,id_cita,puntos,origen_punto_codigo,id_cycle FROM points_transactions WHERE id_cita=ANY($1::uuid[])', [ids])).rows;
        assert.equal(points.length, ids.length); assert.equal(new Set(points.map(row => row.id_cycle)).size, 1);
        for (const row of points) { assert.equal(row.id_cliente, owner.id); assert.equal(row.puntos, 1); }
        assert.equal(points.filter(row => row.origen_punto_codigo === 'integrante').length, count);
        assert.equal((await pool.query("SELECT vence_at=primer_acumulado_at+interval '12 months' anual FROM points_cycles WHERE id_cliente=$1", [owner.id])).rows[0].anual, true);
      });
    }
    await suite.test('guardia rechaza atribuir a un acompanante o tercero; permite solo al titular del grupo', async () => {
      const owner = await createClient(), companion = await createClient(), third = await createClient(), group = await authGroup(owner);
      const id = await insert(companion, { group, order: 2 }); await complete(id);
      for (const target of [companion.id, third.id]) {
        const changed = await pool.query("UPDATE points_transactions SET id_cliente=$1,tipo_puntos_codigo='acumular' WHERE id_cita=$2 RETURNING *", [target, id]);
        assert.equal(changed.rowCount, 0);
      }
      const same = await pool.query("UPDATE points_transactions SET id_cliente=$1,tipo_puntos_codigo='acumular',puntos=9 WHERE id_cita=$2 RETURNING *", [owner.id, id]);
      assert.equal(same.rowCount, 1); assert.equal(same.rows[0].puntos, 1);
      assert.equal(await balance(owner.id), 1); assert.equal(await balance(companion.id), 0); assert.equal(await balance(third.id), 0);
    });
    await suite.test('cancelaciones, inasistencias, pendientes y canje del titular conservan exclusiones', async () => {
      const owner = await createClient(true), companion = await createClient(), group = await authGroup(owner);
      const reward = await insert(owner, { group, reward: true }); await complete(reward);
      for (const state of ['confirmada','cancelada','cancelada_por_cliente','no_show','expirada','anulada','en_espera','pendiente_pago']) await insert(companion, { group, order: 2, state });
      assert.equal(await balance(owner.id), 0); assert.equal(await balance(companion.id), 0);
      const guest = await insert(null, { group, order: 3 }); await complete(guest);
      assert.equal(await balance(owner.id), 1);
    });
    await suite.test('grupo autenticado sin titular valido nunca usa al acompanante como reemplazo', async () => {
      const companion = await createClient(), group = await authGroup(null);
      await complete(await insert(companion, { group, order: 2 }));
      assert.equal(await balance(companion.id), 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1', [companion.id])).rows[0].n, 0);
    });
    await suite.test('no se transfieren ni duplican puntos historicos al aplicar o repetir la migracion', async () => {
      const owner = await createClient(), companion = await createClient(), group = randomUUID();
      await pool.query("INSERT INTO citas_grupos(id_grupo_cita,id_cliente_titular,origen_codigo) VALUES($1,$2,'publico')", [group, owner.id]);
      const id = await insert(companion, { group, order: 2 }); await complete(id);
      const before = (await pool.query('SELECT to_jsonb(pt) data FROM points_transactions pt WHERE id_cita=$1', [id])).rows;
      // AM: El cambio de origen sintetico simula un registro historico previo a esta politica, no una migracion de datos.
      await pool.query("UPDATE citas_grupos SET origen_codigo='cliente_autenticado' WHERE id_grupo_cita=$1", [group]);
      await pool.query(migrationSql); await complete(id);
      assert.deepEqual((await pool.query('SELECT to_jsonb(pt) data FROM points_transactions pt WHERE id_cita=$1', [id])).rows, before);
      assert.equal(await balance(owner.id), 0); assert.equal(await balance(companion.id), 1);
    });
  });
  await t.test('confirmadas, canceladas, vencidas, no_show, soft-delete y titular de recompensa no acreditan', async () => {
    const owner = await createClient();
    for (const state of ['en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion', 'cancelada', 'cancelada_por_cliente', 'expirada', 'no_show', 'anulada']) await insert(owner, { state });
    const reward = await insert(owner, { reward: true }); await complete(reward);
    const deleted = await insert(owner); await pool.query('UPDATE citas SET deleted_at=now() WHERE id_cita=$1', [deleted]); await complete(deleted);
    assert.equal(await balance(owner.id), 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [owner.id])).rows[0].n, 0);
  });
  await t.test('concurrencia: misma cita acredita una vez; citas distintas del mismo cliente comparten ciclo', async () => {
    const owner = await createClient(), first = await insert(owner), second = await insert(owner);
    await Promise.all([complete(first), complete(first), complete(second), complete(second)]);
    assert.equal(await balance(owner.id), 2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [owner.id])).rows[0].n, 1);
  });
  await t.test('ciclo vacío se ancla al primer punto, overloads comparten ciclo y NULL equivale a 12', async () => {
    const owner = await createClient();
    await pool.query("INSERT INTO points_cycles(id_cliente,primer_acumulado_at) VALUES($1,now()-interval '3 months')", [owner.id]);
    await credit(owner, 1);
    const two = (await pool.query('SELECT * FROM fn_points_get_or_create_active_cycle($1::uuid,now())', [owner.id])).rows[0];
    const three = (await pool.query('SELECT * FROM fn_points_get_or_create_active_cycle($1::uuid,NULL::int,now())', [owner.id])).rows[0];
    assert.equal(two.id_cycle, three.id_cycle); assert.ok(two.primer_acumulado_at > new Date(Date.now() - 10000));
    assert.equal((await pool.query("SELECT $1::timestamptz=$2::timestamptz+interval '12 months' annual", [two.vence_at, two.primer_acumulado_at])).rows[0].annual, true);
  });
  await t.test('saldos 0,9,10,11,20; preparación conserva saldo; miembros y servicios por sucursal', async () => {
    for (const member of [false, true]) for (const count of [0, 9, 10, 11, 20]) {
      const owner = await createClient(member); await credit(owner, count);
      const summary = await getClientePointsSummary({ db: pool }, owner.id, { includeRedeemableServices: true });
      assert.equal(summary.saldo_total, count); assert.equal(summary.puede_canjear, count >= 10);
      assert.equal(summary.recompensas_disponibles, Math.floor(count / 10));
      assert.deepEqual(summary.servicios_redimibles.map(row => row.id_servicio), [member ? memberService : service]);
      assert.deepEqual(summary.servicios_redimibles[0].sucursales_disponibles, [branch]);
      if (count >= 10) assert.equal((await prepare(owner)).canje_preparado, true);
      else await assert.rejects(prepare(owner), { code: 'POINTS_REDEEM_INSUFFICIENT_BALANCE' });
      assert.equal(await balance(owner.id), count);
    }
  });
  await t.test('canje confirmado, duplicado y concurrente: exactamente -10, sin borrar historial', async () => {
    const owner = await createClient(); await credit(owner, 20);
    const prepared = await prepare(owner), reward = await makeReward(owner);
    const results = await Promise.all([confirm(owner, reward, prepared.canje_context_token), confirm(owner, reward, prepared.canje_context_token)]);
    assert.equal(results.filter(row => row.aplicada).length, 1); assert.equal(results.filter(row => row.ya_aplicada).length, 1);
    assert.equal(await balance(owner.id), 10);
    const ledger = (await pool.query('SELECT * FROM points_transactions WHERE id_cita=$1', [reward.id])).rows;
    assert.equal(ledger.length, 1); assert.equal(ledger[0].puntos, -10); assert.ok(ledger[0].id_cycle);
    await complete(reward.id); assert.equal(await balance(owner.id), 10);
    const before = (await pool.query('SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1', [owner.id])).rows[0].n;
    assert.equal(before, 21);
  });
  await t.test('dos canjes distintos concurrentes con saldo 10: solo uno puede consumir', async () => {
    const owner = await createClient(); await credit(owner, 10);
    const prepared = await prepare(owner), a = await makeReward(owner), b = await makeReward(owner);
    const results = await Promise.allSettled([confirm(owner, a, prepared.canje_context_token), confirm(owner, b, prepared.canje_context_token)]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.find(row => row.status === 'rejected').reason.code, 'POINTS_REDEEM_INSUFFICIENT_BALANCE_CONFIRM');
    assert.equal(await balance(owner.id), 0);
  });
  await t.test('token inválido, vencido, ajeno; grupo ajeno, servicio y sucursal no autorizados', async () => {
    const a = await createClient(), b = await createClient(); await credit(a, 10); await credit(b, 10);
    const prepared = await prepare(a), reward = await makeReward(a);
    await assert.rejects(confirm(a, reward, 'invalid'), { code: 'POINTS_REDEEM_CONTEXT_INVALID' });
    await assert.rejects(confirm(a, reward, prepared.canje_context_token + '.extra'), { code: 'POINTS_REDEEM_CONTEXT_INVALID' });
    await assert.rejects(confirm(b, reward, prepared.canje_context_token), { code: 'POINTS_REDEEM_CONTEXT_FORBIDDEN' });
    await assert.rejects(confirm(b, reward), { code: 'POINTS_REDEEM_GROUP_FORBIDDEN' });
    await assert.rejects(redeemReward({ db: pool }, { idCliente: a.id, idSucursal: branch, idServicioCanje: memberService }), { code: 'POINTS_REDEEM_SERVICE_FORBIDDEN' });
    await assert.rejects(redeemReward({ db: pool }, { idCliente: a.id, idSucursal: otherBranch, idServicioCanje: service }), { code: 'POINTS_REDEEM_SERVICE_BRANCH_UNAVAILABLE' });
    await pool.query('UPDATE citas SET id_sucursal=$1 WHERE id_cita=$2', [otherBranch, reward.id]);
    await assert.rejects(confirm(a, reward, prepared.canje_context_token), { code: 'POINTS_REDEEM_CONTEXT_BRANCH_MISMATCH' });
    await pool.query('UPDATE citas SET id_sucursal=$1 WHERE id_cita=$2', [branch, reward.id]);
    const originalNow = Date.now; Date.now = () => originalNow() + 86400000;
    try { await assert.rejects(confirm(a, reward, prepared.canje_context_token), { code: 'POINTS_REDEEM_CONTEXT_EXPIRED' }); }
    finally { Date.now = originalNow; }
    assert.equal(await balance(a.id), 10); assert.equal(await balance(b.id), 10);
  });
  await t.test('intento sin confirmar y rollback no consumen; vencimiento no vuelve a descontar canjes', async () => {
    const owner = await createClient(); await credit(owner, 10);
    const prepared = await prepare(owner), pending = await makeReward(owner, 'pendiente_pago');
    await assert.rejects(confirm(owner, pending, prepared.canje_context_token), { code: 'POINTS_REDEEM_APPOINTMENT_NOT_CONFIRMED' });
    assert.equal(await balance(owner.id), 10);
    const confirmed = await makeReward(owner);
    await assert.rejects(tx(async client => { await applyRewardRedeemForConfirmedGroup(client, { idGrupoCita: confirmed.group, idCliente: owner.id }); throw new Error('rollback fixture'); }), /rollback fixture/);
    assert.equal(await balance(owner.id), 10);
    await confirm(owner, confirmed, prepared.canje_context_token);
    await pool.query("UPDATE points_cycles SET primer_acumulado_at=now()-interval '13 months',vence_at=now()-interval '1 month' WHERE id_cliente=$1", [owner.id]);
    assert.equal(await balance(owner.id), 0);
    await pool.query('SELECT fn_points_materialize_expired_cycles($1)', [owner.id]);
    assert.equal(await balance(owner.id), 0);
    await credit(owner, 1); assert.equal(await balance(owner.id), 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [owner.id])).rows[0].n, 2);
  });
  await t.test('preflight no corrige saldos/ciclos históricos; bloquea inconsistencias sin escribir', async () => {
    const owner = await createClient(); await credit(owner, 1);
    await pool.query('UPDATE points_cycles SET vence_at=NULL WHERE id_cliente=$1', [owner.id]);
    const preflight = migrationSql.slice(migrationSql.indexOf('DO $preflight$'), migrationSql.indexOf('$preflight$;') + '$preflight$;'.length);
    await assert.rejects(pool.query(preflight), /MASTERPUNTOS_PREFLIGHT_HISTORICAL_CYCLES_REVIEW_REQUIRED/);
    assert.equal(await balance(owner.id), 1);
    assert.equal((await pool.query('SELECT vence_at FROM points_cycles WHERE id_cliente=$1', [owner.id])).rows[0].vence_at, null);
    await pool.query(await readFile(new URL('../db/manual/masterpuntos_integral_preflight.sql', import.meta.url), 'utf8'));
    assert.equal(await balance(owner.id), 1);
  });

  await t.test('rollback al completar no deja puntos ni ciclo vacío; vigencia no depende de fecha de reserva', async () => {
    const owner = await createClient(), id = await insert(owner, { start: '2020-01-01T14:00:00-06:00' });
    await assert.rejects(tx(async client => {
      await client.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1", [id]);
      throw new Error('rollback finalizacion fixture');
    }), /rollback finalizacion fixture/);
    assert.equal(await balance(owner.id), 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [owner.id])).rows[0].n, 0);
    await complete(id); assert.equal(await balance(owner.id), 1);
    assert.ok((await pool.query('SELECT primer_acumulado_at FROM points_cycles WHERE id_cliente=$1', [owner.id])).rows[0].primer_acumulado_at > new Date(Date.now() - 10000));
  });

  await t.test('ajustes nuevos conservan signo, idempotencia e historial y vencen solo su remanente', async () => {
    const owner = await createClient(), admin = randomUUID(), key = randomUUID();
    const args = { idCliente: owner.id, accion: 'sumar', puntos: 9, motivo: 'Ajuste sintetico autorizado',
      usuarioAdmin: { id_usuario: admin }, claims: { roles: ['super_admin'], user: { id_usuario: admin } }, idempotencyKey: key };
    const added = await addManualPointsAdjustment({ db: pool }, args);
    assert.equal(added.saldo_actual, 9);
    const replay = await addManualPointsAdjustment({ db: pool }, args); assert.equal(replay.idempotent_replay, true);
    const subtracted = await addManualPointsAdjustment({ db: pool }, { ...args, accion: 'restar', puntos: 4, idempotencyKey: randomUUID() });
    assert.equal(subtracted.saldo_actual, 5); assert.equal(subtracted.puntos, -4);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1 AND id_cycle IS NOT NULL', [owner.id])).rows[0].n, 2);
    await pool.query("UPDATE points_cycles SET primer_acumulado_at=now()-interval '13 months',vence_at=now()-interval '1 month' WHERE id_cliente=$1", [owner.id]);
    assert.equal(await balance(owner.id), 0);
    await pool.query('SELECT fn_points_materialize_expired_cycles($1)', [owner.id]);
    assert.equal(await balance(owner.id), 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1', [owner.id])).rows[0].n, 3);
  });

  // AM: Solo las identidades y sesiones se simulan; permisos reales, SQL operacional y ledger reales.
  const profiles = new Map(); process.env.JWT_SECRET = randomBytes(48).toString('hex');
  const errors = [];
  const db = { async query(sql, params) {
    if (sql.includes('WITH base_user')) return { rows: profiles.has(params[0]) ? [profiles.get(params[0])] : [] };
    if (sql.includes('token_jti_hash = $3')) return { rows: [{ estado: 'activa', ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 3600000), revocada_at: null }] };
    return pool.query(sql, params);
  }, async connect() {
    const client = await pool.connect();
    return { query(sql, params) {
      // AM: Mantenimiento de reservas/pagos fuera de alcance; nunca se invoca una pasarela.
      if (sql.includes('UPDATE public.citas_holds') || sql.includes('WITH target_intents') || sql.includes('no_show_at = COALESCE')) return { rows: [], rowCount: 0 };
      return client.query(sql, params).catch(error => { errors.push(error); throw error; });
    }, release() { client.release(); } };
  } };
  const access = (owner, roles = ['cliente'], scope = branch) => {
    const user = owner.user; profiles.set(user, { id_usuario: user, roles, cliente_id: owner.id, id_persona: owner.person, branch_ids: [scope], empleado_id: barber });
    return jwt.sign({ sub: user, sid: randomUUID(), jti: randomUUID(), token_type: 'app' }, process.env.JWT_SECRET, { issuer: 'masterfade-api', audience: 'masterfade-app', expiresIn: '1h' });
  };
  app = Fastify(); app.decorate('db', db); app.decorate('config', { adminDataEntryMode: false, paymentProvider: 'disabled', qaPaymentSimulation: { enabled: true }, privateCommercePilot: { enabled: false, userIds: [], ips: [], proxies: [] } });
  await app.register(fp(async () => {}, { name: 'env-plugin' }));
  await app.register(cookie); await app.register(auth); await app.register(privateCommerce);
  await app.register(operationalRoutes, { prefix: '/v1/admin/citas' });
  await app.register(clientePointsRoutes, { prefix: '/v1/cliente/puntos' });
  await app.register(publicCitasRoutes, { prefix: '/v1/public/citas' });
  await app.ready();
  await t.test('ACOMPANANTES-01: correos registrados y nuevos, 1-4 contactos, aviso uniforme sin enumeracion', async () => {
    const companion = await createClient(), registered = 'registered@example.test';
    await pool.query('INSERT INTO correos VALUES(gen_random_uuid(),$1,$2,NULL,true,true)', [companion.person, registered]);
    const snapshot = async () => (await pool.query('SELECT row_to_json(c) datos FROM correos c ORDER BY id_correo')).rows;
    const before = await snapshot();
    let expected;
    for (const count of [1, 2, 3, 4]) for (const email of [registered, 'new@example.test']) {
      const contactos = Array.from({ length: count }, (_, i) => ({ blockIndex: i + 1, rol_integrante_codigo: 'acompanante',
        email: i === 0 ? email : `guest${i}@example.test`, nombre: `Invitado ${i}` }));
      const response = await app.inject({ method: 'POST', url: '/v1/public/citas/validar-contactos', payload: { contactos } });
      assert.equal(response.statusCode, 200, response.body);
      const data = response.json(); assert.equal(data.valido, true);
      assert.equal(data.warnings.length, 1); assert.equal(data.warnings[0].code, 'COMPANION_POINTS_POLICY');
      expected ??= data.warnings; assert.deepEqual(data.warnings, expected);
      assert.doesNotMatch(JSON.stringify(data.warnings), /@|id_cliente|registrado|existe/);
    }
    const invalid = await app.inject({ method: 'POST', url: '/v1/public/citas/validar-contactos', payload: { contactos: [{ blockIndex: 1, email: 'bad-email' }] } });
    assert.equal(invalid.statusCode, 400);
    for (const field of ['email', 'telefono', 'dni']) {
      const value = { email: registered, telefono: '99999999', dni: '0801199000001' }[field];
      const duplicate = await app.inject({ method: 'POST', url: '/v1/public/citas/validar-contactos',
        payload: { contactos: [{ blockIndex: 1, [field]: value }, { blockIndex: 2, [field]: field === 'email' ? value.toUpperCase() : value }] } });
      assert.equal(duplicate.statusCode, 409, duplicate.body);
      assert.equal(duplicate.json().error.code, 'PUBLIC_CITAS_CONTACT_DUPLICATE_CONFLICT');
    }
    assert.deepEqual(await snapshot(), before); assert.equal(await balance(companion.id), 0);
  });
  await t.test('Finalizar atención y PATCH estado Completada acreditan a través de los controladores reales', async () => {
    for (const member of [false, true]) for (const patch of [false, true]) {
      const owner = await createClient(member), id = await insert(owner, { state: 'en_atencion' });
      if (member) await pool.query('INSERT INTO citas_detalles(id_cita_detalle,id_cita,id_servicio,subtotal_hnl) VALUES(gen_random_uuid(),$1,$2,0)', [id, memberService]);
      const token = access(await createClient(), ['super_admin']);
      const response = await app.inject({ method: patch ? 'PATCH' : 'POST', url: `/v1/admin/citas/${id}/${patch ? 'estado' : 'finalizar-atencion'}`, headers: { cookie: `mf_session=${token}` }, payload: patch ? { estado_cita_codigo: 'completada' } : {} });
      assert.equal(response.statusCode, 200, response.body + ' ' + errors.at(-1)?.message);
      assert.equal(await balance(owner.id), 1);
      const replay = await app.inject({ method: 'POST', url: `/v1/admin/citas/${id}/finalizar-atencion`, headers: { cookie: `mf_session=${token}` }, payload: {} });
      assert.equal(replay.statusCode, 409); assert.equal(await balance(owner.id), 1);
    }
  });
  await t.test('ACOMPANANTES-01: finalizar y cambio administrativo acreditan invitados y registrados al titular', async () => {
    for (const patch of [false, true]) for (const member of [false, true]) {
      const owner = await createClient(member), companion = await createClient(!member), group = randomUUID();
      await pool.query("INSERT INTO citas_grupos(id_grupo_cita,id_cliente_titular,origen_codigo) VALUES($1,$2,'cliente_autenticado')", [group, owner.id]);
      const token = access(await createClient(), ['super_admin']);
      for (const [index, person] of [companion, null].entries()) {
        const id = await insert(person, { group, order: index + 2, state: 'en_atencion' });
        const response = await app.inject({ method: patch ? 'PATCH' : 'POST', url: `/v1/admin/citas/${id}/${patch ? 'estado' : 'finalizar-atencion'}`,
          headers: { cookie: `mf_session=${token}` }, payload: patch ? { estado_cita_codigo: 'completada' } : {} });
        assert.equal(response.statusCode, 200, response.body + ' ' + errors.at(-1)?.message);
        const replay = await app.inject({ method: 'POST', url: `/v1/admin/citas/${id}/finalizar-atencion`, headers: { cookie: `mf_session=${token}` }, payload: {} });
        assert.equal(replay.statusCode, 409);
      }
      assert.equal(await balance(owner.id), 2); assert.equal(await balance(companion.id), 0);
    }
  });
  await t.test('Cliente solo consulta sus puntos; rol/sucursal invalidos no completan ni acreditan', async () => {
    const a = await createClient(), b = await createClient(); await credit(a, 1); await credit(b, 9);
    for (const owner of [a, b]) {
      const response = await app.inject({ url: '/v1/cliente/puntos/resumen', headers: { cookie: `mf_session=${access(owner)}` } });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().data.saldo_total, owner === a ? 1 : 9);
      assert.equal(response.json().data.id_cliente, owner.id);
    }
    const id = await insert(a, { state: 'en_atencion' });
    for (const [roles, scope, status] of [[['cliente'], branch, 403], [['admin'], otherBranch, 404]]) {
      const response = await app.inject({ method: 'POST', url: `/v1/admin/citas/${id}/finalizar-atencion`, headers: { cookie: `mf_session=${access(b, roles, scope)}` }, payload: {} });
      assert.equal(response.statusCode, status, response.body);
    }
    assert.equal(await balance(a.id), 1);
    assert.equal((await pool.query('SELECT estado_cita_codigo FROM citas WHERE id_cita=$1', [id])).rows[0].estado_cita_codigo, 'en_atencion');
  });
  await t.test('gate de recompensa conserva obligación a 10; confirmación no contiene acreditaciones prematuras', async () => {
    const owner = await createClient(); await credit(owner, 10);
    const gate = await tx(client => resolveRewardRedeemGateForCliente(client, { idCliente: owner.id, idSucursal: branch }));
    assert.equal(gate.reward_redeem_required, true);
    for (const file of ['../src/routes/v1/citas.js', '../src/routes/v1/public/pagos.js']) assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), /grant(?:Engagement|Companion)PointsForConfirmedGroup/);
    const prepared = await prepare(owner);
    const resolved = await tx(client => resolveRedeemContextForHold(client, { idCliente: owner.id, idSucursal: branch, canjeContextToken: prepared.canje_context_token }));
    assert.equal(resolved.id_cliente, owner.id); assert.equal(await balance(owner.id), 10);
  });
});
