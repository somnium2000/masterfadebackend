import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAdminPointsReleaseFixture } from './helpers/adminPointsReleaseFixture.mjs';

test('Release09: ajustes reales PostgreSQL17, auth, alcance y ledger productivo', { skip: !process.env.MASTERFADE_TEST_PG_BIN, timeout: 180000 }, async t => {
  const f = await createAdminPointsReleaseFixture(); t.after(f.close);
  const admin = f.token(), superAdmin = f.token(['super_admin']), foreignAdmin = f.token(['admin'], [f.otherBranch]);
  const body = (accion = 'sumar', puntos = 2, motivo = 'Correccion administrativa') => ({ accion, puntos, motivo });

  await t.test('rutinas locales reproducen cuerpos del export productivo sin migraciones QA', async () => {
    const hashes = JSON.parse(await readFile(new URL('./sql/admin-masterpoints-release.hashes.json', import.meta.url), 'utf8'));
    for (const [name, expected] of Object.entries(hashes)) {
      const { rows } = await f.pool.query("SELECT p.prosrc, p.prosecdef, p.proconfig, md5(pg_get_functiondef(p.oid)) AS hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [name]);
      assert.equal(createHash('sha256').update(rows[0].prosrc).digest('hex'), expected.export_body_sha256, name);
      assert.equal(rows[0].hash, expected.catalog_definition_hash, name);
      assert.equal(rows[0].prosecdef, false); assert.equal(rows[0].proconfig, null);
    }
  });
  await t.test('JSON invalido no ejecuta SQL del ajuste ni escribe idempotencia', async () => {
    const client = await f.makeClient();
    for (const accion of ['sumar', 'restar']) for (const puntos of ['2', true, false, null, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER, [], {}, '1e2']) {
      const before = f.serviceQueries(); const response = await f.adjust(client, admin, body(accion, puntos));
      assert.equal(response.statusCode, 400, JSON.stringify({ accion, puntos, result: response.json() }));
      assert.equal(f.serviceQueries(), before);
    }
    for (const payload of [body('otro'), body(true), body(null), body('sumar', 2, ''), body('sumar', 2, 'abcd'), body('sumar', 2, 'x'.repeat(301))]) {
      assert.equal((await f.adjust(client, admin, payload)).statusCode, 400);
    }
    assert.equal((await f.ledger(client)).length, 0);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM app_private.points_manual_adjustment_idempotency')).rows[0].n, 0);
  });
  await t.test('roles, sesion, sucursal ajena/sin sucursal y suma global original', async () => {
    const client = await f.makeClient(); await f.seed(client);
    for (const roles of [['cliente'], ['barbero']]) {
      const before = f.serviceQueries(); assert.equal((await f.adjust(client, f.token(roles), body())).statusCode, 403); assert.equal(f.serviceQueries(), before);
    }
    assert.equal((await f.adjust(client, null, body())).statusCode, 401);
    assert.equal((await f.adjust(client, { token: 'invalid' }, body())).statusCode, 401);
    const csrfRejected = await f.adjust(client, admin, body(), randomUUID(), { 'x-csrf-token': 'incorrect' });
    assert.equal(csrfRejected.statusCode, 403); assert.equal(csrfRejected.json().error.code, 'CSRF_TOKEN_INVALID');
    assert.equal((await f.adjust(client, foreignAdmin, body('restar'))).statusCode, 403);
    const noBranch = await f.makeClient(null); await f.seed(noBranch);
    assert.equal((await f.adjust(noBranch, admin, body('restar'))).statusCode, 403);
    assert.equal((await f.adjust(client, foreignAdmin, body('restar'), randomUUID(), { 'x-roles': 'super_admin' })).statusCode, 403);
    assert.equal((await f.adjust(noBranch, superAdmin, body('restar'))).statusCode, 200);
    assert.equal((await f.adjust(client, foreignAdmin, body('sumar'))).statusCode, 200);
  });
  await t.test('signo, motivo y autor reales, historial inmutable y resumen posterior', async () => {
    const client = await f.makeClient(); await f.seed(client); const initial = await f.ledger(client);
    for (const [accion, expected] of [['sumar', 7], ['restar', 5]]) {
      const response = await f.adjust(client, admin, body(accion)); assert.equal(response.statusCode, 200, response.body);
      const data = response.json().data;
      assert.equal(data.puntos, accion === 'sumar' ? 2 : -2); assert.equal(data.saldo_actual, expected);
      const row = (await f.ledger(client)).find(item => item.id_points_tx === data.id_points_tx);
      assert.equal(row.creado_por_usuario_id, admin.user); assert.equal(row.motivo, body().motivo); assert.equal(row.puntos, data.puntos);
    }
    assert.deepEqual((await f.ledger(client)).find(row => row.id_points_tx === initial[0].id_points_tx), initial[0]);
    const response = await f.app.inject({ url: `/v1/admin/puntos/clientes/${client.id}/resumen`, headers: { cookie: 'mf_session=' + admin.token } });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().data.saldo_total, 5); assert.equal(response.json().data.historial.length, 3);
  });
  await t.test('saldo insuficiente y meta de recompensa conservan rollback', async () => {
    const client = await f.makeClient(); await f.seed(client, 5); const old = await f.ledger(client);
    assert.equal((await f.adjust(client, admin, body('restar', 6))).statusCode, 422);
    assert.equal((await f.adjust(client, admin, body('sumar', 6))).statusCode, 409);
    assert.deepEqual(await f.ledger(client), old);
  });
  await t.test('repeticion, doble envio y concurrencia no duplican ni pierden saldo', async () => {
    const client = await f.makeClient(); await f.seed(client, 5); const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 4 }, () => f.adjust(client, admin, body('restar', 2), key)));
    assert.ok(responses.every(r => r.statusCode === 200)); assert.equal(new Set(responses.map(r => r.json().data.id_points_tx)).size, 1);
    assert.equal((await f.adjust(client, admin, body('restar', 3), key)).statusCode, 409);
    assert.equal(await f.balance(client), 3); assert.equal((await f.ledger(client)).length, 2);
    const competing = await Promise.all([f.adjust(client, admin, body('restar', 3)), f.adjust(client, admin, body('restar', 3))]);
    assert.deepEqual(competing.map(r => r.statusCode).sort(), [200, 422]); assert.equal(await f.balance(client), 0);
    const mixed = await Promise.all([f.adjust(client, admin, body('sumar', 2)), f.adjust(client, admin, body('sumar', 3))]);
    assert.ok(mixed.every(r => r.statusCode === 200)); assert.equal(await f.balance(client), 5);
  });
  await t.test('limite integer y motivos de 5/300 caracteres sin overflow', async () => {
    const client = await f.makeClient();
    await f.pool.query('UPDATE points_rules SET puntos_para_premio=2147483647');
    try {
      const response = await f.adjust(client, admin, body('sumar', 2147483647, 'x'.repeat(300)));
      assert.equal(response.statusCode, 200, response.body); assert.equal(await f.balance(client), 2147483647);
      assert.equal((await f.adjust(client, superAdmin, body('restar', 2147483647, 'cinco'))).statusCode, 200);
      assert.equal(await f.balance(client), 0);
    } finally { await f.pool.query('UPDATE points_rules SET puntos_para_premio=10'); }
  });
});
