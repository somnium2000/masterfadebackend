import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMasterpuntosRelease10Fixture } from './helpers/masterpuntosRelease10Fixture.mjs';
import { addManualPointsAdjustment, applyRewardRedeemForConfirmedGroup } from '../src/services/pointsService.js';

test('Release10: carga manual legitima, ciclos anuales y debitos certificados con PostgreSQL17', {
  skip: !process.env.MASTERFADE_TEST_PG_BIN, timeout: 240000,
}, async t => {
  const f = await createMasterpuntosRelease10Fixture(); t.after(f.close);
  const owners = await Promise.all(Array.from({ length: 12 }, () => f.owner()));
  const amounts = [2, 5, 5, 6, 10, 6, 9, 10, 2, 1, 9, 4];
  for (const [i, actor] of owners.entries()) {
    await f.pool.query(`INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos,creado_por_usuario_id,created_at,updated_at)
      VALUES($1,'ajustar',$2,$3,now()-interval '4 days'+$4*interval '1 hour',now()-interval '4 days'+$4*interval '1 hour')`,
    [actor.id, amounts[i], actor.user, i]);
  }
  await f.pool.query(`INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos,creado_por_usuario_id,created_at,updated_at)
    SELECT $1,v.tipo,v.puntos,$2,min(created_at)+v.delta,min(created_at)+v.delta
    FROM points_transactions CROSS JOIN (VALUES('ajustar',4,interval '10 minutes'),('ajuste_resta',4,interval '20 minutes')) v(tipo,puntos,delta)
    WHERE id_cliente=$1 GROUP BY v.tipo,v.puntos,v.delta`, [owners[3].id, owners[3].user]);
  const initial = await f.snapshot();
  const allZero = result => {
    const rows = (Array.isArray(result) ? result : [result]).flatMap(r => r.rows).filter(r => 'affected' in r);
    assert.ok(rows.length); assert.deepEqual(rows.filter(r => Number(r.affected) !== 0), []);
  };
  const preflight = async client => client.query((await f.sql('00-preflight.sql'))
    .replace(/^BEGIN ISOLATION[^\n]+\n/m, '').replace(/^COMMIT;\s*$/m, ''));
  const preserved = async () => {
    const ids = initial[0].ledger.map(r => r.id_points_tx);
    const rows = (await f.pool.query('SELECT jsonb_agg(to_jsonb(t) ORDER BY id_points_tx) ledger FROM points_transactions t WHERE id_points_tx=ANY($1::uuid[])', [ids])).rows;
    assert.deepEqual(rows[0].ledger, initial[0].ledger);
  };
  const adjust = (actor, accion, puntos, key = randomUUID()) => addManualPointsAdjustment({ db: f.pool }, {
    idCliente: actor.id, accion, puntos, motivo: 'Certificacion aislada de ciclos', usuarioAdmin: { id_usuario: actor.user },
    claims: { roles: ['super_admin'] }, idempotencyKey: key,
  });
  let baselineHashes;
  await t.test('14 movimientos y 69 puntos: preflight demuestra carga manual fechada, sin retirar controles', async () => {
    assert.equal(initial[0].ledger.length, 14);
    assert.equal(initial[0].ledger.reduce((sum, r) => sum + r.puntos, 0), 69);
    const result = await f.run('00-preflight.sql'); allZero(result);
    baselineHashes = result.flatMap(r => r.rows).find(r => r.ledger_md5);
    assert.deepEqual(await f.snapshot(), initial);
  });
  for (const [name, mutation, actor] of [
    ['autor sin evidencia', 'creado_por_usuario_id=NULL', owners[0]],
    ['carga ya vencida', "created_at=created_at-interval '14 months',updated_at=updated_at-interval '14 months'", owners[0]],
    ['saldo negativo', 'puntos=-2,tipo_puntos_codigo=\'ajuste_resta\'', owners[0]],
    ['fecha futura', "created_at=now()+interval '1 day',updated_at=now()+interval '1 day'", owners[0]],
    ['vencimiento historico ambiguo', "vence_at=now()+interval '1 month'", owners[0]],
  ]) await t.test('preflight rechaza '+name+' sin modificar el ledger', async () => {
    const c = await f.pool.connect();
    try {
      await c.query('BEGIN'); await c.query(`UPDATE points_transactions SET ${mutation} WHERE id_cliente=$1`, [actor.id]);
      const rows = (await preflight(c)).flatMap(r => r.rows);
      assert.ok(Number(rows.find(r => r.code === 'HISTORICAL_UNCYCLED_REVIEW').affected) > 0);
      await assert.rejects(c.query(await f.sql('10-apply.sql')), name === 'saldo negativo' ? /CLIENT_NEGATIVE_OR_OVERFLOW_BALANCE/ : /HISTORICAL_UNCYCLED_REVIEW|TRANSACTION_SIGN/);
      await c.query('ROLLBACK');
    } finally { await c.query('ROLLBACK'); c.release(); }
    assert.deepEqual(await f.snapshot(), initial);
  });
  await t.test('aplicacion atomica crea 12 ciclos con la fecha de primera carga y conserva cada byte del ledger', async () => {
    await f.run('10-apply.sql'); await preserved(); allZero(await f.run('20-postflight.sql'));
    const rows = (await f.pool.query(`SELECT pc.id_cliente,pc.primer_acumulado_at=min(pt.created_at) FILTER(WHERE pt.puntos>0) exact_anchor,
      pc.vence_at=pc.primer_acumulado_at+interval '12 months' annual
      FROM points_cycles pc JOIN points_transactions pt ON pt.id_cliente=pc.id_cliente
      GROUP BY pc.id_cycle`)).rows;
    assert.equal(rows.length, 12); assert.ok(rows.every(r => r.exact_anchor && r.annual));
    for (const [i, actor] of owners.entries()) assert.equal(await f.balance(actor), amounts[i]);
  });
  for (const mutation of [
    "UPDATE app_private.release10_cycle_bootstrap_backup SET seal=''",
    'DELETE FROM app_private.release10_cycle_bootstrap_backup',
    'GRANT SELECT ON app_private.release10_cycle_bootstrap_backup TO anon',
  ]) await t.test('respaldo del bootstrap rechaza deriva: '+mutation, async () => {
    const c = await f.pool.connect(); const before = await f.snapshot();
    try {
      await c.query('BEGIN'); await c.query(mutation);
      await assert.rejects(c.query(await f.sql('10-apply.sql')), /CYCLE_BOOTSTRAP_BACKUP_DRIFT/);
    } finally { await c.query('ROLLBACK'); c.release(); }
    assert.deepEqual(await f.snapshot(), before);
  });
  await t.test('reaplicar conserva ciclos, respaldo y ledger; backup y vista no amplian permisos', async () => {
    const before = await f.snapshot(); await f.run('10-apply.sql'); assert.deepEqual(await f.snapshot(), before);
    const backup = (await f.pool.query(`SELECT * FROM app_private.release10_cycle_bootstrap_backup`)).rows;
    await f.run('10-apply.sql'); assert.deepEqual((await f.pool.query('SELECT * FROM app_private.release10_cycle_bootstrap_backup')).rows, backup);
    assert.equal((await f.pool.query(`SELECT has_table_privilege('anon','app_private.release10_cycle_bootstrap_backup','SELECT') allowed`)).rows[0].allowed, false);
    const c = await f.pool.connect(); try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE mf_audit_readonly');
      assert.equal(Number((await c.query('SELECT sum(balance_puntos) n FROM vw_points_balance')).rows[0].n), 69);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });
  await t.test('rollback antes de trafico restaura ciclos y funciones, conserva los 14 movimientos y SEGURIDAD-02', async () => {
    const c = await f.pool.connect(); try {
      await c.query("SELECT set_config('masterfade.release10_expected_ledger',$1,false),set_config('masterfade.release10_expected_cycles',$2,false)", [baselineHashes.ledger_md5, baselineHashes.cycles_md5]);
      await c.query(await f.sql('31-restore-before-traffic.sql'));
    } finally { await c.query('ROLLBACK'); c.release(); }
    assert.deepEqual(await f.snapshot(), initial); allZero(await f.run('00-preflight.sql'));
    await f.run('10-apply.sql'); await preserved();
  });
  const actor = owners[10]; let originalCycle;
  await t.test('novena carga historica y cinco nuevos puntos comparten ciclo sin vencimiento extendido', async () => {
    originalCycle = (await f.pool.query('SELECT * FROM points_cycles WHERE id_cliente=$1', [actor.id])).rows[0];
    for (let i = 0; i < 5; i++) await f.paid(actor, await f.appointment(actor));
    assert.equal(await f.balance(actor), 14);
    const credits = (await f.pool.query("SELECT vence_at FROM points_transactions WHERE id_cliente=$1 AND tipo_puntos_codigo='acumular'", [actor.id])).rows;
    assert.equal(credits.length, 5); assert.ok(credits.every(r => r.vence_at.toISOString() === originalCycle.vence_at.toISOString()));
    await preserved();
  });
  await t.test('canje real mixto concurrente: un solo -10, saldo 4 y ciclo efectivo no negativo', async () => {
    const catalog = await f.source('test/sql/security-supabase-02-fixture.sql');
    const a = catalog.indexOf('CREATE TABLE public.servicios_tarifas (');
    await f.pool.query(catalog.slice(a, catalog.indexOf('\n);', a) + 3));
    await f.pool.query(`INSERT INTO servicios_tarifas(id_servicio,id_sucursal,vigente_desde) VALUES($1,$2,(now() AT TIME ZONE 'America/Tegucigalpa')::date)`, [f.service, f.branch]);
    await f.pool.query(`INSERT INTO points_rule_services(id_rule,id_servicio,cliente_condicion_codigo,habilitado,visible_cliente)
      SELECT id_rule,$1,'sin_membresia',true,true FROM points_rules`, [f.service]);
    const group = randomUUID();
    await f.pool.query(`INSERT INTO citas_grupos(id_grupo_cita,id_cliente_titular,id_sucursal,codigo_reserva,origen_codigo)
      VALUES($1,$2,$3,$4,'cliente_autenticado')`, [group, actor.id, f.branch, randomUUID()]);
    const cita = await f.appointment(actor, { state: 'confirmada', reward: true, group });
    await f.pool.query(`INSERT INTO citas_detalles(id_cita,id_servicio,duracion_min,precio_unitario_hnl,subtotal_hnl,nombre_servicio_snapshot,line_key,orden_linea)
      VALUES($1,$2,30,300,300,'Servicio sintetico','servicio',1)`, [cita, f.service]);
    const redeem = async () => {
      const c = await f.pool.connect(); try {
        await c.query('BEGIN'); const result = await applyRewardRedeemForConfirmedGroup(c, { idGrupoCita: group, idCliente: actor.id });
        await c.query('COMMIT'); return result;
      } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
    };
    const results = await Promise.all([redeem(), redeem()]);
    assert.equal(results.filter(r => r.aplicada).length, 1); assert.equal(results.filter(r => r.ya_aplicada).length, 1);
    assert.equal(await f.balance(actor), 4);
    assert.equal((await f.pool.query('SELECT id_cycle FROM fn_points_get_or_create_active_cycle($1,12,now())', [actor.id])).rows[0].id_cycle, originalCycle.id_cycle);
    allZero(await f.run('20-postflight.sql')); await preserved();
  });
  await t.test('restas concurrentes no consumen dos veces; un reintento conserva el movimiento', async () => {
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(keys.map(key => adjust(actor, 'restar', 4, key)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'POINTS_INSUFFICIENT_BALANCE');
    const winner = results.findIndex(r => r.status === 'fulfilled');
    assert.equal((await adjust(actor, 'restar', 4, keys[winner])).id_points_tx, results[winner].value.id_points_tx);
    assert.equal(await f.balance(actor), 0); await preserved();
  });
  await t.test('primer punto tras agotar el saldo abre otro ciclo de 12 meses; el siguiente conserva ese plazo', async () => {
    await adjust(actor, 'sumar', 1);
    const active = (await f.pool.query("SELECT * FROM points_cycles WHERE id_cliente=$1 AND estado_ciclo_codigo='activo'", [actor.id])).rows[0];
    assert.notEqual(active.id_cycle, originalCycle.id_cycle);
    assert.equal((await f.pool.query(`SELECT vence_at=primer_acumulado_at+interval '12 months' annual FROM points_cycles WHERE id_cycle=$1`, [active.id_cycle])).rows[0].annual, true);
    assert.equal((await f.pool.query('SELECT estado_ciclo_codigo FROM points_cycles WHERE id_cycle=$1', [originalCycle.id_cycle])).rows[0].estado_ciclo_codigo, 'cerrado');
    await adjust(actor, 'sumar', 1);
    assert.equal((await f.pool.query('SELECT vence_at FROM points_cycles WHERE id_cycle=$1', [active.id_cycle])).rows[0].vence_at.toISOString(), active.vence_at.toISOString());
    assert.equal(await f.balance(actor), 2); await preserved(); allZero(await f.run('20-postflight.sql'));
  });
  await t.test('SQL rechaza sobregiro y asignacion a un ciclo ajeno antes de insertar el debito', async () => {
    const before = await f.snapshot();
    const ownCycle = (await f.pool.query("SELECT id_cycle FROM points_cycles WHERE id_cliente=$1 AND estado_ciclo_codigo='activo'", [actor.id])).rows[0].id_cycle;
    const otherCycle = (await f.pool.query("SELECT id_cycle FROM points_cycles WHERE id_cliente=$1 AND estado_ciclo_codigo='activo'", [owners[0].id])).rows[0].id_cycle;
    for (const [cycle, amount] of [[ownCycle, 3], [otherCycle, 1]]) {
      await assert.rejects(f.pool.query(`INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos)
        VALUES($1,$2,'ajuste_resta',$3)`, [actor.id, cycle, amount]), { code: '23514', constraint: 'masterpuntos_cycle_balance' });
    }
    assert.deepEqual(await f.snapshot(), before); await preserved();
  });
  for (const status of ['cerrado', 'expirado']) await t.test('un ciclo inactivo con saldo de un Cliente activo exige revision: '+status, async () => {
    const before = await f.snapshot(), c = await f.pool.connect();
    try {
      await c.query('BEGIN'); await c.query("UPDATE points_cycles SET estado_ciclo_codigo=$2 WHERE id_cliente=$1 AND estado_ciclo_codigo='activo'", [actor.id, status]);
      const rows = (await preflight(c)).flatMap(r => r.rows);
      assert.equal(Number(rows.find(r => r.code === 'INACTIVE_CYCLE_BALANCE_REVIEW').affected), 1);
    } finally { await c.query('ROLLBACK'); c.release(); }
    assert.deepEqual(await f.snapshot(), before);
  });
  await t.test('sexto punto manual conserva el aniversario del primero aunque se acredite seis meses despues', async () => {
    const owner = await f.owner();
    const cycle = (await f.pool.query(`INSERT INTO points_cycles(id_cliente,primer_acumulado_at,vence_at)
      VALUES($1,now()-interval '6 months',now()-interval '6 months'+interval '12 months') RETURNING *`, [owner.id])).rows[0];
    await f.pool.query(`INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos,created_at,updated_at)
      SELECT $1,$2,'ajustar',5,primer_acumulado_at,primer_acumulado_at FROM points_cycles WHERE id_cycle=$2`, [owner.id, cycle.id_cycle]);
    const result = await adjust(owner, 'sumar', 1);
    const credit = (await f.pool.query('SELECT vence_at FROM points_transactions WHERE id_points_tx=$1', [result.id_points_tx])).rows[0];
    assert.equal(credit.vence_at.toISOString(), cycle.vence_at.toISOString());
    assert.equal(await f.balance(owner), 6); await preserved();
  });
  for (const zone of ['UTC', 'America/Tegucigalpa', 'Asia/Tokyo']) await t.test('aniversario y bisiesto conservan calendario Honduras desde '+zone, async () => {
    const c = await f.pool.connect(); try {
      await c.query('BEGIN'); await c.query("SELECT set_config('TimeZone',$1,true)", [zone]);
      for (const [anchor, expiry] of [['2024-02-29T12:00:00-06:00', '2025-02-28T18:00:00.000Z'], ['2025-01-31T12:00:00-06:00', '2026-01-31T18:00:00.000Z']]) {
        const owner = await f.owner();
        const cycle = (await c.query('SELECT * FROM fn_points_get_or_create_active_cycle($1,12,$2::timestamptz)', [owner.id, anchor])).rows[0];
        assert.equal(cycle.vence_at.toISOString(), expiry);
      }
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });
  await t.test('ocho puntos vencen exactamente al alcanzar el aniversario y se materializan una sola vez', async () => {
    const owner = await f.owner(), c = await f.pool.connect(); let cycle;
    try {
      await c.query('BEGIN');
      cycle = (await c.query(`INSERT INTO points_cycles(id_cliente,primer_acumulado_at,vence_at)
        VALUES($1,now()-interval '12 months',now()) RETURNING *`, [owner.id])).rows[0];
      await c.query(`INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos,created_at,updated_at)
        SELECT $1,$2,'ajustar',8,primer_acumulado_at,primer_acumulado_at FROM points_cycles WHERE id_cycle=$2`, [owner.id, cycle.id_cycle]);
      assert.equal(Number((await c.query('SELECT balance_puntos FROM vw_points_balance WHERE id_cliente=$1', [owner.id])).rows[0].balance_puntos), 0);
      await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
    await Promise.all([f.pool.query('SELECT fn_points_materialize_expired_cycles($1)', [owner.id]), f.pool.query('SELECT fn_points_materialize_expired_cycles($1)', [owner.id])]);
    assert.deepEqual((await f.pool.query("SELECT puntos FROM points_transactions WHERE id_cycle=$1 AND tipo_puntos_codigo='vencimiento'", [cycle.id_cycle])).rows, [{ puntos: -8 }]);
    await adjust(owner, 'sumar', 1); assert.equal(await f.balance(owner), 1); await preserved();
  });
  await t.test('tras nuevos movimientos el rollback antiguo se bloquea sin perder datos', async () => {
    const before = await f.snapshot(), c = await f.pool.connect(); try {
      await c.query("SELECT set_config('masterfade.release10_expected_ledger',$1,false),set_config('masterfade.release10_expected_cycles',$2,false)", [baselineHashes.ledger_md5, baselineHashes.cycles_md5]);
      await assert.rejects(c.query(await f.sql('31-restore-before-traffic.sql')), /RESTORE_REQUIRES_UNCHANGED_BASELINE/); await c.query('ROLLBACK');
    } finally { c.release(); }
    assert.deepEqual(await f.snapshot(), before); await preserved();
  });
});
