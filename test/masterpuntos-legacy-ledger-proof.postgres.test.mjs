import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMasterpuntosRelease10Fixture } from './helpers/masterpuntosRelease10Fixture.mjs';
import { addManualPointsAdjustment, applyRewardRedeemForConfirmedGroup } from '../src/services/pointsService.js';

test('Release10: prueba contable del saldo legitimo sin ciclo, sin regularizar filas', {
  skip: !process.env.MASTERFADE_TEST_PG_BIN, timeout: 180000,
}, async t => {
  const f = await createMasterpuntosRelease10Fixture();
  t.after(f.close);
  await t.test('el preflight actual bloquea el credito abierto sin modificarlo', async () => {
    const actor = await f.owner(), c = await f.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos) VALUES($1,'ajustar',9)", [actor.id]);
      const before = (await c.query('SELECT to_jsonb(pt) row FROM points_transactions pt WHERE id_cliente=$1', [actor.id])).rows;
      const checks = (await f.sql('00-preflight.sql')).replace(/^BEGIN ISOLATION[^\n]+\n/m, '').replace(/^COMMIT;\s*$/m, '');
      const results = (await c.query(checks)).flatMap(r => r.rows);
      assert.equal(Number(results.find(r => r.code === 'HISTORICAL_UNCYCLED_REVIEW').affected), 1);
      assert.deepEqual((await c.query('SELECT to_jsonb(pt) row FROM points_transactions pt WHERE id_cliente=$1', [actor.id])).rows, before);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });
  // AM: Instalacion permitida sobre fixture vacio. Los estados mixtos posteriores son solo pruebas adversarias;
  // no se elimina ni se salta el preflight para presentar una migracion real como segura.
  await f.run('10-apply.sql');
  // AM: Tabla de tarifas desde el fixture de catalogo verificado; no se altera el esquema remoto.
  const catalog = await f.source('test/sql/security-supabase-02-fixture.sql');
  const ratesStart = catalog.indexOf('CREATE TABLE public.servicios_tarifas (');
  assert.ok(ratesStart >= 0);
  await f.pool.query(catalog.slice(ratesStart, catalog.indexOf('\n);', ratesStart) + 3));
  const legacy = async (actor, amount = 9, age = '2 days') => (await f.pool.query(`
    INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos,created_at,updated_at)
    VALUES($1,'ajustar',$2,now()-$3::interval,now()-$3::interval)
    RETURNING id_points_tx, to_jsonb(points_transactions) original`, [actor.id, amount, age])).rows[0];
  const live = async () => {
    const actor = await f.owner(), imported = await legacy(actor, 9, '14 months');
    for (let n = 0; n < 5; n++) await f.paid(actor, await f.appointment(actor));
    assert.equal(await f.balance(actor), 14);
    const cycle = (await f.pool.query('SELECT id_cycle FROM points_cycles WHERE id_cliente=$1', [actor.id])).rows[0].id_cycle;
    return { actor, imported, cycle };
  };
  const originalIntact = async imported => assert.deepEqual(
    (await f.pool.query('SELECT to_jsonb(pt) original FROM points_transactions pt WHERE id_points_tx=$1', [imported.id_points_tx])).rows[0].original,
    imported.original);
  const cycleBalance = async cycle => Number((await f.pool.query('SELECT sum(puntos)::int n FROM points_transactions WHERE id_cycle=$1', [cycle])).rows[0].n);
  const adjustment = (actor, key) => addManualPointsAdjustment({ db: f.pool }, {
    idCliente: actor.id, accion: 'restar', puntos: 10, motivo: 'Prueba contable aislada',
    usuarioAdmin: { id_usuario: actor.user }, claims: { roles: ['super_admin'] }, idempotencyKey: key,
  });
  await t.test('servicio real: 9 existentes + 5 pagos validos - 10 deja ciclo -5; reintento no duplica', async () => {
    const { actor, imported, cycle } = await live(), key = randomUUID();
    const first = await adjustment(actor, key), repeated = await adjustment(actor, key);
    assert.equal(first.id_points_tx, repeated.id_points_tx);
    assert.equal(await f.balance(actor), 4);
    assert.equal(await cycleBalance(cycle), -5);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1 AND tipo_puntos_codigo='ajuste_resta'", [actor.id])).rows[0].n, 1);
    await originalIntact(imported);
  });
  await t.test('restas concurrentes conservan saldo global e idempotencia; el problema por ciclo permanece', async () => {
    const { actor, imported, cycle } = await live();
    const results = await Promise.allSettled([adjustment(actor, randomUUID()), adjustment(actor, randomUUID())]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'POINTS_INSUFFICIENT_BALANCE');
    assert.equal(await f.balance(actor), 4); assert.equal(await cycleBalance(cycle), -5);
    await originalIntact(imported);
  });
  await t.test('canje real: una fila de -10, sin duplicacion, pero el ciclo queda negativo', async () => {
    const { actor, imported, cycle } = await live();
    const group = randomUUID();
    await f.pool.query(`INSERT INTO citas_grupos(id_grupo_cita,id_cliente_titular,id_sucursal,codigo_reserva,origen_codigo)
      VALUES($1,$2,$3,$4,'cliente_autenticado')`, [group, actor.id, f.branch, randomUUID()]);
    const cita = await f.appointment(actor, { state: 'confirmada', reward: true, group });
    await f.pool.query(`INSERT INTO citas_detalles(id_cita,id_servicio,duracion_min,precio_unitario_hnl,
      subtotal_hnl,nombre_servicio_snapshot,line_key,orden_linea)
      VALUES($1,$2,30,300,300,'Servicio sintetico','servicio',1)`, [cita, f.service]);
    await f.pool.query(`INSERT INTO servicios_tarifas(id_servicio,id_sucursal) VALUES($1,$2)`, [f.service, f.branch]);
    await f.pool.query(`INSERT INTO points_rule_services(id_rule,id_servicio,cliente_condicion_codigo,habilitado,visible_cliente)
      SELECT id_rule,$1,'sin_membresia',true,true FROM points_rules`, [f.service]);
    const c = await f.pool.connect();
    try {
      await c.query('BEGIN');
      const first = await applyRewardRedeemForConfirmedGroup(c, { idGrupoCita: group, idCliente: actor.id });
      const replay = await applyRewardRedeemForConfirmedGroup(c, { idGrupoCita: group, idCliente: actor.id });
      assert.equal(first.aplicada, true); assert.equal(replay.ya_aplicada, true);
      assert.equal(first.id_points_tx, replay.id_points_tx);
      await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
    assert.deepEqual((await f.pool.query("SELECT puntos FROM points_transactions WHERE id_cita=$1 AND tipo_puntos_codigo='canjear'", [cita])).rows, [{ puntos: -10 }]);
    assert.equal(await f.balance(actor), 4); assert.equal(await cycleBalance(cycle), -5);
    await originalIntact(imported);
  });
  await t.test('mover el debito completo a NULL tampoco sirve: el vencimiento real lleva el saldo a -1', async () => {
    const actor = await f.owner(), imported = await legacy(actor, 9, '14 months');
    const cycle = (await f.pool.query(`INSERT INTO points_cycles(id_cliente,primer_acumulado_at,vence_at)
      VALUES($1,now()-interval '13 months',now()-interval '13 months'+interval '12 months') RETURNING id_cycle`, [actor.id])).rows[0].id_cycle;
    await f.pool.query(`INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos,created_at,updated_at)
      VALUES($1,$2,'ajustar',5,now()-interval '12 months',now()-interval '12 months')`, [actor.id, cycle]);
    await f.pool.query("INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos,created_at,updated_at) VALUES($1,'canjear',10,now()-interval '2 months',now()-interval '2 months')", [actor.id]);
    assert.equal(Number((await f.pool.query('SELECT sum(puntos)::int n FROM points_transactions WHERE id_cliente=$1', [actor.id])).rows[0].n), 4);
    assert.equal(await f.balance(actor), -1);
    await f.pool.query('SELECT fn_points_materialize_expired_cycles($1)', [actor.id]);
    assert.equal(Number((await f.pool.query('SELECT sum(puntos)::int n FROM points_transactions WHERE id_cliente=$1', [actor.id])).rows[0].n), -1);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1 AND tipo_puntos_codigo='vencimiento'", [actor.id])).rows[0].n, 1);
    await originalIntact(imported);
  });
  await t.test('la regla de imputacion cambia un saldo futuro: 4 o 0, aun conservando todas las filas originales', async () => {
    const { rows } = await f.pool.query(`WITH input AS (SELECT 9 old_points,5 cycle_points,10 debit),
      alternatives AS (
        SELECT 'ciclo_primero' policy,old_points-GREATEST(debit-cycle_points,0) old_left,
          GREATEST(cycle_points-debit,0) cycle_left FROM input
        UNION ALL
        SELECT 'saldo_existente_primero',GREATEST(old_points-debit,0),
          cycle_points-GREATEST(debit-old_points,0) FROM input)
      SELECT policy,old_left,cycle_left,old_left+cycle_left balance_after_debit,old_left balance_after_cycle_expiry
      FROM alternatives ORDER BY policy`);
    assert.deepEqual(rows, [
      { policy:'ciclo_primero',old_left:4,cycle_left:0,balance_after_debit:4,balance_after_cycle_expiry:4 },
      { policy:'saldo_existente_primero',old_left:0,cycle_left:4,balance_after_debit:4,balance_after_cycle_expiry:0 },
    ]);
  });
  await t.test('el SQL actual reutiliza el ciclo agotado por canje y no renueva doce meses desde el siguiente punto', async () => {
    const actor = await f.owner();
    const prior = (await f.pool.query(`SELECT * FROM fn_points_get_or_create_active_cycle($1,12,now()-interval '6 months')`, [actor.id])).rows[0];
    await f.pool.query(`INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos)
      VALUES($1,$2,'ajustar',10),($1,$2,'canjear',10)`, [actor.id, prior.id_cycle]);
    assert.equal(await f.balance(actor), 0);
    await f.paid(actor, await f.appointment(actor));
    const after = (await f.pool.query('SELECT * FROM points_cycles WHERE id_cliente=$1', [actor.id])).rows;
    assert.equal(after.length, 1);
    assert.equal(after[0].id_cycle, prior.id_cycle);
    assert.equal(after[0].vence_at.toISOString(), prior.vence_at.toISOString());
    assert.equal(await f.balance(actor), 1);
    assert.equal((await f.pool.query(`SELECT vence_at < now()+interval '11 months' shortened
      FROM points_cycles WHERE id_cycle=$1`, [prior.id_cycle])).rows[0].shortened, true);
  });
  await t.test('rollback del experimento conserva filas y no regulariza la contabilidad', async () => {
    const before = await f.snapshot(), c = await f.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE points_cycles SET updated_at=updated_at');
      await c.query('ROLLBACK');
    } finally { c.release(); }
    assert.deepEqual(await f.snapshot(), before);
  });
});
