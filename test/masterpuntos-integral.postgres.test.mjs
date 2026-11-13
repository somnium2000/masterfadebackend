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
  pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 6 });
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
    await pool.query('INSERT INTO citas_detalles VALUES(gen_random_uuid(),$1,$2,100)', [id, owner.member ? memberService : service]);
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
  await t.test('titular, dos acompañantes registrados e invitado: identidad propia, nunca titular sustituto', async () => {
    const owners = await Promise.all([createClient(), createClient(true), createClient()]), group = randomUUID();
    await pool.query('INSERT INTO citas_grupos VALUES($1,$2)', [group, owners[0].id]);
    const ids = await Promise.all([...owners, null].map((owner, i) => insert(owner, { group, order: i + 1 })));
    await Promise.all(ids.map(complete));
    for (const owner of owners) assert.equal(await balance(owner.id), 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_transactions WHERE id_cita=ANY($1::uuid[])', [ids])).rows[0].n, 3);
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
  app = Fastify(); app.decorate('db', db); app.decorate('config', { adminDataEntryMode: false, paymentProvider: 'disabled', privateCommercePilot: { enabled: false, userIds: [], ips: [], proxies: [] } });
  await app.register(fp(async () => {}, { name: 'env-plugin' }));
  await app.register(cookie); await app.register(auth); await app.register(privateCommerce);
  await app.register(operationalRoutes, { prefix: '/v1/admin/citas' });
  await app.register(clientePointsRoutes, { prefix: '/v1/cliente/puntos' });
  await app.ready();
  await t.test('Finalizar atención y PATCH estado Completada acreditan a través de los controladores reales', async () => {
    for (const member of [false, true]) for (const patch of [false, true]) {
      const owner = await createClient(member), id = await insert(owner, { state: 'en_atencion' });
      if (member) await pool.query('INSERT INTO citas_detalles VALUES(gen_random_uuid(),$1,$2,0)', [id, memberService]);
      const token = access(await createClient(), ['super_admin']);
      const response = await app.inject({ method: patch ? 'PATCH' : 'POST', url: `/v1/admin/citas/${id}/${patch ? 'estado' : 'finalizar-atencion'}`, headers: { cookie: `mf_session=${token}` }, payload: patch ? { estado_cita_codigo: 'completada' } : {} });
      assert.equal(response.statusCode, 200, response.body + ' ' + errors.at(-1)?.message);
      assert.equal(await balance(owner.id), 1);
      const replay = await app.inject({ method: 'POST', url: `/v1/admin/citas/${id}/finalizar-atencion`, headers: { cookie: `mf_session=${token}` }, payload: {} });
      assert.equal(replay.statusCode, 409); assert.equal(await balance(owner.id), 1);
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
