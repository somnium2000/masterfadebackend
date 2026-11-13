import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { confirmCanonicalPaidReservation } from '../src/services/bookingCanonicalReservationService.js';
import { applyRewardRedeemForConfirmedGroup, getClientePointsSummary, redeemReward } from '../src/services/pointsService.js';
import { expireStaleAppointmentReservations } from '../src/services/agendaService.js';

const BIN = process.env.MASTERFADE_PHASE02_PG_BIN;
const source = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const migration = 'db/manual/20261113161929_masterpuntos_paid_confirmation_v1.sql';

test('PAGO-CONFIRMADO-01: pago real sintetico, transacciones y concurrencia PostgreSQL aislado', { skip: !BIN, timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mf-points-paid-')), data = path.join(directory, 'data');
  let pool, started = false;
  const binary = (name, args) => {
    const result = spawnSync(path.join(BIN, name + (process.platform === 'win32' ? '.exe' : '')), args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  t.after(async () => {
    if (pool) await pool.end();
    if (started) binary('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mf-points-paid-'));
    await rm(directory, { recursive: true, force: true });
  });
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  binary('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C', '--no-sync']);
  binary('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']); started = true;
  pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 8 });
  await pool.query(await source('test/sql/masterpuntos-integral-fixture.sql'));
  await pool.query(await source('test/sql/masterpuntos-legacy-functions.sql'));
  await pool.query(await source('test/sql/mf118-points-fixture.sql'));
  await pool.query(await source('db/migrations/20261030010000_masterpuntos_readonly_expiration_v1.sql'));
  await pool.query(`CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo,id_cita,origen_punto_codigo ON points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final();
    CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo,puntos ON points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign();
    CREATE TRIGGER tr_points_cita_confirmada AFTER INSERT OR UPDATE ON citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita();`);
  await pool.query(await source('db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql'));
  // AM: Contrato de pagos verificado en dump local/migraciones; solo datos sinteticos en loopback.
  await pool.query(`ALTER TABLE payment_intents ADD COLUMN id_intent uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ADD COLUMN id_grupo_cita uuid, ADD COLUMN id_provider uuid, ADD COLUMN id_membership_order uuid,
    ADD COLUMN origen_pago_codigo text DEFAULT 'cita', ADD COLUMN monto_hnl numeric,
    ADD COLUMN moneda_codigo text DEFAULT 'HNL', ADD COLUMN paid_at timestamptz,
    ADD COLUMN referencia_externa text, ADD COLUMN id_hold uuid, ADD COLUMN updated_at timestamptz;
    ALTER TABLE citas_grupos ADD COLUMN total_hnl numeric;
    ALTER TABLE citas_holds ADD COLUMN id_hold uuid DEFAULT gen_random_uuid(), ADD COLUMN updated_at timestamptz;
    CREATE TABLE payment_providers(id_provider uuid PRIMARY KEY DEFAULT gen_random_uuid(),codigo text);
    CREATE TABLE payments(id_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(),id_intent uuid REFERENCES payment_intents,
      estado_pago_codigo text,monto_hnl numeric,moneda_codigo text DEFAULT 'HNL',paid_at timestamptz,
      provider_tx_id text UNIQUE,pago_tardio boolean DEFAULT false,updated_at timestamptz DEFAULT now());
    CREATE TABLE payment_events(id_intent uuid,evento_tipo text,payload_esencial jsonb);
    CREATE TABLE subscription_payments(id_payment uuid,id_suscripcion uuid,estado text,monto_hnl numeric,moneda_codigo text,paid_at timestamptz);
    CREATE TABLE membership_purchase_orders(id_order uuid PRIMARY KEY,id_suscripcion uuid,id_cliente uuid,
      estado_orden_codigo text,total_hnl numeric,moneda_codigo text,paid_at timestamptz);`);
  const canonical = await source('db/migrations/pixel/20260924010000_pixelpay_reconciliation_window.sql');
  const start = canonical.indexOf('CREATE OR REPLACE FUNCTION app_private.confirmar_reserva_pagada_v1(');
  await pool.query(canonical.slice(start, canonical.indexOf('$mf$;', start) + 5));
  const branch = randomUUID(), service = randomUUID(), provider = randomUUID(), mockProvider = randomUUID(), plan = randomUUID();
  await pool.query("INSERT INTO sucursales(id_sucursal,nombre_sucursal,estado) VALUES($1,'QA local',true)", [branch]);
  await pool.query("INSERT INTO servicios(id_servicio,nombre_servicio) VALUES($1,'Corte QA local')", [service]);
  await pool.query('INSERT INTO servicios_tarifas(id_servicio,id_sucursal) VALUES($1,$2)', [service, branch]);
  await pool.query("INSERT INTO payment_providers VALUES($1,'pixelpay'),($2,'mock')", [provider, mockProvider]);
  await pool.query("INSERT INTO membership_plans(id_plan,nombre_plan) VALUES($1,'VIP local')", [plan]);
  await pool.query("INSERT INTO points_rule_services SELECT id_rule,$1,c,true,true,1 FROM points_rules CROSS JOIN (VALUES('sin_membresia'),('con_membresia')) v(c)", [service]);
  const owner = async (points = 0) => {
    const id = randomUUID(), user = randomUUID(), person = randomUUID();
    await pool.query("INSERT INTO personas(id_persona,nombres,apellidos) VALUES($1,'Cliente','Sintetico')", [person]);
    await pool.query('INSERT INTO usuarios(id_usuario,id_persona) VALUES($1,$2)', [user, person]);
    await pool.query('INSERT INTO clientes(id_cliente,id_usuario,id_persona,id_sucursal_origen) VALUES($1,$2,$3,$4)', [id, user, person, branch]);
    if (points) await pool.query("INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos,id_cycle) SELECT $1,'ajustar',$2,id_cycle FROM fn_points_get_or_create_active_cycle($1,12,now())", [id, points]);
    return { id, user };
  };
  const balance = async (actor, client = pool) => Number((await client.query('SELECT balance_puntos FROM vw_points_balance WHERE id_cliente=$1', [actor.id])).rows[0]?.balance_puntos || 0);
  const group = async (actor, count = 0, { kind = 'invitados', reward = false, vip = false, free = false, individual = false } = {}) => {
    const id = individual ? null : randomUUID(), citas = [], companions = [];
    if (id) await pool.query("INSERT INTO citas_grupos(id_grupo_cita,id_cliente_titular,origen_codigo) VALUES($1,$2,'cliente_autenticado')", [id, actor.id]);
    for (let i = 0; i <= count; i++) {
      const contact = i === 0 ? actor : (kind === 'registrados' || (kind === 'mixtos' && i % 2) ? await owner() : null);
      if (i && contact) companions.push(contact);
      const cita = randomUUID(), total = free || (i === 0 && (reward || vip)) ? 0 : 300;
      await pool.query("INSERT INTO citas(id_cita,id_grupo_cita,id_sucursal,id_cliente,estado_cita_codigo,orden_integrante,inicio_at,total_pagar_hnl,moneda_codigo,es_canje_recompensa,descuento_hnl,creada_por_usuario_id) VALUES($1,$2,$3,$4,'en_espera',$5,now()+interval '1 day',$6,'HNL',$7,$8,$9)", [cita, id, branch, contact?.id || null, i + 1, total, i === 0 && reward, i === 0 && reward ? 300 : 0, actor.user]);
      await pool.query('INSERT INTO citas_detalles(id_cita_detalle,id_cita,id_servicio,subtotal_hnl,descuento_hnl) VALUES(gen_random_uuid(),$1,$2,300,$3)', [cita, service, i === 0 && reward ? 300 : 0]);
      await pool.query("INSERT INTO citas_holds(id_cita,estado_hold_codigo,expires_at,created_at) VALUES($1,'activo',now()+interval '15 minutes',now())", [cita]);
      citas.push(cita);
    }
    const total = Number((await pool.query('SELECT sum(total_pagar_hnl) total FROM citas WHERE id_cita=ANY($1::uuid[])', [citas])).rows[0].total);
    if (id) await pool.query('UPDATE citas_grupos SET total_hnl=$2 WHERE id_grupo_cita=$1', [id, total]);
    return { id, citas, companions, total };
  };
  const intent = async (g, { code = 'creado', providerId = provider, amount = g.total } = {}) => (await pool.query("INSERT INTO payment_intents(id_cita,id_grupo_cita,id_provider,estado_intent_codigo,monto_hnl,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes') RETURNING *", [g.citas[0], g.id, providerId, code, amount])).rows[0];
  const capture = async (pi, client = pool, { state = 'capturado', tx = randomUUID(), amount = pi.monto_hnl, currency = 'HNL', late = false, paidAt = new Date() } = {}) => (await client.query('INSERT INTO payments(id_intent,estado_pago_codigo,monto_hnl,moneda_codigo,paid_at,provider_tx_id,pago_tardio) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [pi.id_intent, state, amount, currency, paidAt, tx, late])).rows[0];
  const confirm = async (g, pi, client = pool) => g.id
    ? confirmCanonicalPaidReservation(client, { idIntent: pi.id_intent, pagadoAt: new Date().toISOString() })
    : client.query("UPDATE payment_intents SET estado_intent_codigo='confirmado' WHERE id_intent=$1;", [pi.id_intent]).then(() => client.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1", [g.citas[0]]));
  const paid = async (g, pi, { actor, redeem = false } = {}) => {
    const client = await pool.connect();
    try { await client.query('BEGIN');
      // AM: Mismo orden del controlador: lock del intent antes de insertar el pago con FK.
      await client.query('SELECT id_intent FROM payment_intents WHERE id_intent=$1 FOR UPDATE', [pi.id_intent]);
      await capture(pi, client); await confirm(g, pi, client);
      if (redeem) await applyRewardRedeemForConfirmedGroup(client, { idGrupoCita: g.id, idCliente: actor.id });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const vipCoverage = async (actor, cita, { funded = true, simulated = false } = {}, client = pool) => {
    const sub = randomUUID(), order = randomUUID();
    await client.query("INSERT INTO subscriptions(id_suscripcion,id_cliente,id_plan,estado_suscripcion_codigo,inicio_at,fin_at,id_sucursal_contratada) VALUES($1,$2,$3,'activa',now()-interval '1 day',now()+interval '1 year',$4)", [sub, actor.id, plan, branch]);
    if (funded) {
      await client.query("INSERT INTO membership_purchase_orders VALUES($1,$2,$3,'pagada',1000,'HNL',now())", [order, sub, actor.id]);
      const pi = (await client.query("INSERT INTO payment_intents(id_membership_order,id_provider,origen_pago_codigo,estado_intent_codigo,monto_hnl) VALUES($1,$2,'membership','confirmado',1000) RETURNING *", [order, provider])).rows[0];
      const p = await capture(pi, client);
      await client.query("INSERT INTO subscription_payments VALUES($1,$2,'pagado',1000,'HNL',now())", [p.id_payment, sub]);
      if (simulated) await client.query("INSERT INTO payment_events VALUES($1,'membership.simulated.result','{\"mode\":\"preprod_simulated\"}')", [pi.id_intent]);
    }
    await client.query("INSERT INTO subscription_consumptions(id_suscripcion,id_cliente,id_cita,id_servicio,item_tipo,coverage_status) VALUES($1,$2,$3,$4,'servicio','cubierto_plan')", [sub, actor.id, cita, service]);
    return sub;
  };

  const historical = await owner(), old = await group(historical);
  await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1", [old.citas[0]]);
  const snapshot = async () => (await pool.query("SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id_points_tx) FROM points_transactions t) tx,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id_cycle) FROM points_cycles c) cycles")).rows;
  const before = await snapshot();
  await t.test('nueva migracion repetible conserva byte a byte historial y ciclos previos', async () => {
    await pool.query(await source('db/manual/masterpuntos_paid_confirmation_checks.sql'));
    await pool.query(await source(migration)); await pool.query(await source(migration)); assert.deepEqual(await snapshot(), before);
    await pool.query(await source('db/manual/masterpuntos_paid_confirmation_checks.sql'));
  });
  for (const individual of [true, false]) await t.test(`pago exitoso individual=${individual}: +1 inmediato, sin asistencia; no_show y completada conservan`, async () => {
    const actor = await owner(), g = await group(actor, 0, { individual }), pi = await intent(g);
    assert.equal(await balance(actor), 0); await paid(g, pi); assert.equal(await balance(actor), 1);
    const credit = (await pool.query('SELECT * FROM points_transactions WHERE id_cita=$1', [g.citas[0]])).rows;
    for (const state of ['no_show', 'completada', 'completada']) { await pool.query('UPDATE citas SET estado_cita_codigo=$1 WHERE id_cita=$2', [state, g.citas[0]]); assert.equal(await balance(actor), 1); }
    assert.deepEqual((await pool.query('SELECT * FROM points_transactions WHERE id_cita=$1', [g.citas[0]])).rows, credit);
  });
  for (const vip of [false, true]) for (const kind of ['registrados', 'invitados', 'mixtos']) for (const count of [1, 2, 3, 4]) await t.test(`grupo ${count} ${kind} VIP=${vip}: +${count + 1} exclusivo al titular al pagar`, async () => {
    const actor = await owner(), g = await group(actor, count, { kind, vip });
    if (vip) await vipCoverage(actor, g.citas[0]);
    const pi = await intent(g); await paid(g, pi);
    assert.equal(await balance(actor), count + 1);
    for (const companion of g.companions) assert.equal(await balance(companion), 0);
    const summary = await getClientePointsSummary({ db: pool }, actor.id, { includeRedeemableServices: false });
    assert.equal(summary.saldo_total, count + 1); assert.equal(summary.historial.length, count + 1);
  });
  for (const points of [10, 20]) for (const vip of [false, true]) for (const count of [1, 2, 3, 4]) await t.test(`canje saldo=${points}, VIP=${vip}, ${count} acompanantes: -10 una vez, +${count} inmediato`, async () => {
    const actor = await owner(points), g = await group(actor, count, { reward: true, kind: 'mixtos' });
    if (vip) await vipCoverage(actor, g.citas[0]);
    const pi = await intent(g); await paid(g, pi, { actor, redeem: true }); assert.equal(await balance(actor), points - 10 + count);
    await Promise.all([paid(g, pi, { actor, redeem: true }), paid(g, pi, { actor, redeem: true })]);
    await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_grupo_cita=$1", [g.id]);
    assert.equal(await balance(actor), points - 10 + count);
    assert.equal((await pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cita=$1 AND tipo_puntos_codigo='canjear'", [g.citas[0]])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cita=$1 AND tipo_puntos_codigo='acumular'", [g.citas[0]])).rows[0].n, 0);
  });
  for (const status of ['creado', 'pendiente_confirmacion', 'fallido', 'expirado']) await t.test(`intent ${status} y reserva confirmada no acreditan`, async () => {
    const actor = await owner(), g = await group(actor), pi = await intent(g, { code: status }); await capture(pi);
    await pool.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1", [g.citas[0]]); assert.equal(await balance(actor), 0);
  });
  for (const invalid of ['sin_pago', 'sin_confirmacion', 'mock', 'simulacion', 'fallido', 'tardio', 'monto', 'moneda', 'sin_fecha', 'sin_referencia', 'total_cero']) await t.test(`evidencia invalida ${invalid}: sin puntos ni ciclo vacio`, async () => {
    const actor = await owner(), g = await group(actor, 0, { free: invalid === 'total_cero' });
    const pi = await intent(g, { providerId: invalid === 'mock' ? mockProvider : provider });
    if (invalid !== 'sin_pago') await capture(pi, pool, { state: invalid === 'fallido' ? 'fallido' : 'capturado', amount: invalid === 'monto' ? g.total + 1 : g.total, currency: invalid === 'moneda' ? 'USD' : 'HNL', late: invalid === 'tardio', paidAt: invalid === 'sin_fecha' ? null : new Date(), tx: invalid === 'sin_referencia' ? null : randomUUID() });
    if (invalid === 'simulacion') await pool.query("INSERT INTO payment_events VALUES($1,'payment.simulated.result','{\"mode\":\"preprod_simulated\"}')", [pi.id_intent]);
    if (invalid !== 'sin_confirmacion') await confirm(g, pi);
    assert.equal(await balance(actor), 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [actor.id])).rows[0].n, 0);
  });
  for (const funded of [false, true]) for (const simulated of [false, true]) await t.test(`VIP total cero: membresia pagada=${funded} simulada=${simulated}`, async () => {
    const actor = await owner(), g = await group(actor, 0, { vip: true });
    await pool.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1", [g.citas[0]]);
    const client = await pool.connect();
    try { await client.query('BEGIN'); const sub = await vipCoverage(actor, g.citas[0], { funded, simulated }, client);
      await client.query("UPDATE subscriptions SET estado_suscripcion_codigo='vencida',motivo_fin_codigo='agotamiento' WHERE id_suscripcion=$1", [sub]);
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal(await balance(actor), funded && !simulated ? 1 : 0);
  });
  await t.test('VIP: cobertura registrada valida respeta el motor actual aunque la cita sea futura', async () => {
    const actor = await owner(), g = await group(actor, 0, { vip: true });
    const sub = await vipCoverage(actor, g.citas[0]);
    await pool.query("UPDATE subscriptions SET fin_at=now()+interval '1 hour' WHERE id_suscripcion=$1", [sub]);
    await pool.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1", [g.citas[0]]);
    assert.equal(await balance(actor), 1);
  });
  await t.test('saldo 9: canje insuficiente revierte pago, confirmacion y creditos diferidos', async () => {
    const actor = await owner(9), g = await group(actor, 2, { reward: true }), pi = await intent(g);
    await assert.rejects(redeemReward({ db: pool }, { idCliente: actor.id, idSucursal: branch, idServicioCanje: service }), { code: 'POINTS_REDEEM_INSUFFICIENT_BALANCE' });
    await assert.rejects(paid(g, pi, { actor, redeem: true }), { code: 'POINTS_REDEEM_INSUFFICIENT_BALANCE_CONFIRM' });
    assert.equal(await balance(actor), 9); assert.equal((await pool.query('SELECT count(*)::int n FROM payments WHERE id_intent=$1', [pi.id_intent])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM citas WHERE id_grupo_cita=$1 AND estado_cita_codigo='confirmada'", [g.id])).rows[0].n, 0);
  });
  await t.test('duplicado y concurrente: una acreditacion por cita, unico ciclo', async () => {
    const actor = await owner(), g = await group(actor, 4), pi = await intent(g);
    await Promise.all([paid(g, pi), paid(g, pi), paid(g, pi)]); assert.equal(await balance(actor), 5);
    await Promise.all(g.citas.flatMap(cita => [pool.query('SELECT app_private.points_award_paid_appointment_v1($1)', [cita]), pool.query('SELECT app_private.points_award_paid_appointment_v1($1)', [cita])]));
    assert.equal(await balance(actor), 5);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [actor.id])).rows[0].n, 1);
  });
  await t.test('dos reservas concurrentes comparten un ciclo sin perder puntos', async () => {
    const actor = await owner(), a = await group(actor), b = await group(actor);
    const pa = await intent(a), pb = await intent(b);
    await Promise.all([paid(a, pa), paid(b, pb)]); assert.equal(await balance(actor), 2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1', [actor.id])).rows[0].n, 1);
  });
  await t.test('saldo 10, dos canjes concurrentes: solo uno consume, el segundo revierte todo', async () => {
    const actor = await owner(10), a = await group(actor, 1, { reward: true }), b = await group(actor, 1, { reward: true });
    const pa = await intent(a), pb = await intent(b);
    const results = await Promise.allSettled([paid(a, pa, { actor, redeem: true }), paid(b, pb, { actor, redeem: true })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'POINTS_REDEEM_INSUFFICIENT_BALANCE_CONFIRM');
    assert.equal(await balance(actor), 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1 AND tipo_puntos_codigo='canjear'", [actor.id])).rows[0].n, 1);
  });
  for (const order of ['confirmacion_primero', 'pago_primero', 'intent_ultimo']) await t.test(`orden de escritura ${order}: acredita cuando toda la evidencia esta confirmada`, async () => {
    const actor = await owner(), g = await group(actor), pi = await intent(g);
    if (order !== 'pago_primero') await pool.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1", [g.citas[0]]);
    if (order !== 'intent_ultimo') await pool.query("UPDATE payment_intents SET estado_intent_codigo='confirmado' WHERE id_intent=$1", [pi.id_intent]);
    await capture(pi);
    assert.equal(await balance(actor), order === 'confirmacion_primero' ? 1 : 0);
    if (order === 'pago_primero') await pool.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1", [g.citas[0]]);
    if (order === 'intent_ultimo') await pool.query("UPDATE payment_intents SET estado_intent_codigo='confirmado' WHERE id_intent=$1", [pi.id_intent]);
    assert.equal(await balance(actor), 1);
  });
  await t.test('guarda: insercion sin pago, beneficiario ajeno y cambio de credito rechazados', async () => {
    const actor = await owner(), other = await owner(), g = await group(actor), pi = await intent(g);
    const insert = (id, cita) => pool.query("INSERT INTO points_transactions(id_cliente,id_cita,tipo_puntos_codigo,puntos) VALUES($1,$2,'acumular',99) RETURNING *", [id, cita]);
    assert.equal((await insert(actor.id, g.citas[0])).rowCount, 0);
    await paid(g, pi); assert.equal((await insert(other.id, g.citas[0])).rowCount, 0);
    await assert.rejects(pool.query('UPDATE points_transactions SET puntos=99 WHERE id_cita=$1', [g.citas[0]]), { code: '23514' });
    assert.equal(await balance(actor), 1); assert.equal(await balance(other), 0);
  });
  await t.test('pagos de otro grupo no sirven como evidencia', async () => {
    const actor = await owner(), a = await group(actor), b = await group(actor), pi = await intent(a);
    await paid(a, pi); await pool.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_grupo_cita=$1", [b.id]); assert.equal(await balance(actor), 1);
  });
  await t.test('solo completar una cita sin pago nunca acredita', async () => {
    const actor = await owner(), g = await group(actor); await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1", [g.citas[0]]); assert.equal(await balance(actor), 0);
  });
  await t.test('no_show automatico: 4:59 conserva confirmada, 5:00 marca ausencia y conserva el punto', async () => {
    const actor = await owner(), g = await group(actor), pi = await intent(g); await paid(g, pi);
    await pool.query("UPDATE citas SET inicio_at=date_trunc('milliseconds',inicio_at) WHERE id_cita=$1", [g.citas[0]]);
    const startAt = (await pool.query('SELECT inicio_at FROM citas WHERE id_cita=$1', [g.citas[0]])).rows[0].inicio_at;
    // AM: Ejecuta SQL real de inasistencia; aisla expiracion de holds/proveedores ajena a esta prueba.
    const client = { query: (sql, params) => sql.includes('no_show_at = COALESCE') ? pool.query(sql, params) : Promise.resolve({ rows: [], rowCount: 0 }) };
    await expireStaleAppointmentReservations(client, { now: new Date(startAt.getTime() + 299999) });
    assert.equal((await pool.query('SELECT estado_cita_codigo FROM citas WHERE id_cita=$1', [g.citas[0]])).rows[0].estado_cita_codigo, 'confirmada');
    await expireStaleAppointmentReservations(client, { now: new Date(startAt.getTime() + 300000) });
    assert.equal((await pool.query('SELECT estado_cita_codigo FROM citas WHERE id_cita=$1', [g.citas[0]])).rows[0].estado_cita_codigo, 'no_show');
    assert.equal(await balance(actor), 1);
    await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1", [g.citas[0]]); assert.equal(await balance(actor), 1);
  });
  await t.test('trigger historico de aplicacion de pago confirma y acredita sin llamada Node adicional', async () => {
    const sql = await source('test/sql/payments/qa_payment_triggers_20261011.sql');
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_trg_aplicar_pago_a_cita()');
    await pool.query(sql.slice(at, sql.indexOf('$function$;', at) + 11));
    await pool.query('CREATE TRIGGER tr_pay_aplicar AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION fn_trg_aplicar_pago_a_cita()');
    const actor = await owner(), g = await group(actor, 0, { individual: true }), pi = await intent(g);
    await capture(pi); assert.equal(await balance(actor), 1);
    assert.equal((await pool.query('SELECT estado_cita_codigo FROM citas WHERE id_cita=$1', [g.citas[0]])).rows[0].estado_cita_codigo, 'confirmada');
  });
});
