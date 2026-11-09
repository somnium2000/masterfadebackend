import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import adminPointsRoutes from '../src/routes/v1/admin/puntos.js';
import {
  addManualPointsAdjustment,
  getClientePointsSummary,
  searchActiveClientesForAdminPoints,
} from '../src/services/pointsService.js';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const IDEMPOTENCY_KEY = '66666666-6666-4666-8666-666666666666';

function claims(roles = ['admin'], branchIds = [BRANCH_A]) {
  return { roles, branch_ids: branchIds, user: { id_usuario: ADMIN } };
}

function fixture({ actorClaims = claims(), clientBranch = BRANCH_A, balance = 4 } = {}) {
  const calls = [];
  let balanceReads = 0;
  const record = (target, sql, params = []) => calls.push({
    target,
    sql: String(sql).replace(/\s+/g, ' ').trim(),
    params,
  });
  const branchRows = () => actorClaims.roles.includes('super_admin')
    ? [{ id_sucursal: BRANCH_A }, { id_sucursal: BRANCH_B }]
    : actorClaims.branch_ids.map((id_sucursal) => ({ id_sucursal }));
  const canReachClient = (branchIds, global) => global || (clientBranch && branchIds.includes(clientBranch));
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql); record('client', text, params);
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('SELECT c.id_cliente') && !text.includes('JOIN public.personas')) {
        return { rows: canReachClient(params[1] || [], false) ? [{ id_cliente: CLIENT }] : [] };
      }
      if (text.includes('fn_points_materialize_expired_cycles')) return { rows: [] };
      if (text.includes('JOIN public.personas p')) return { rows: [{
        id_cliente: CLIENT, id_persona: USER, id_usuario: USER, id_sucursal_origen: clientBranch,
        nombres: 'Cliente', apellidos: 'Sintético',
      }] };
      if (text.includes('FROM public.usuarios u')) return { rows: [{ id_usuario: USER }] };
      if (text.includes('FROM public.tipos_puntos')) return { rows: [
        { tipo_puntos_codigo: 'ajustar', signo: 1 },
        { tipo_puntos_codigo: 'ajuste_resta', signo: -1 },
      ] };
      if (text.includes('AS puntos_titular')) return { rows: [{ saldo_total: balance, puntos_titular: balance, puntos_integrante: 0 }] };
      if (text.includes('fn_points_get_effective_rule')) return { rows: [{ puntos_para_premio: 10 }] };
      if (text.includes('FROM public.points_transactions pt') && text.includes('ORDER BY pt.created_at')) return { rows: [] };
      if (text.includes('SELECT COALESCE(SUM(pt.puntos), 0)::int AS saldo_total')) {
        balanceReads += 1;
        return { rows: [{ saldo_total: balanceReads === 1 ? balance : balance + 5 }] };
      }
      if (text.includes('INSERT INTO app_private.points_manual_adjustment_idempotency')) return { rows: [{ idempotency_key: params[0], payload_hash: params[1], response_payload: null }], rowCount: 1 };
      if (text.includes('UPDATE app_private.points_manual_adjustment_idempotency')) return { rows: [], rowCount: 1 };
      if (text.includes('INSERT INTO public.points_transactions')) return { rows: [{
        id_points_tx: USER, id_cliente: CLIENT, tipo_puntos_codigo: 'ajustar', origen_punto_codigo: 'sistema',
        puntos: 5, motivo: 'Ajuste sintético', created_at: '2026-10-29T12:00:00.000Z',
      }] };
      throw new Error(`SQL_NO_SIMULADO: ${text}`);
    },
    release() { calls.push({ target: 'client', sql: 'RELEASE', params: [] }); },
  };
  const app = {
    db: {
      query: async (sql, params = []) => {
        const text = String(sql); record('db', text, params);
        if (text.includes('FROM public.sucursales')) return { rows: branchRows() };
        if (text.includes('FROM public.clientes c')) {
          return { rows: [{
            id_cliente: CLIENT, nombre_cliente: 'Cliente Sintético', correo: null, telefono: null,
            id_usuario: USER, id_sucursal_origen: clientBranch,
          }] };
        }
        throw new Error(`SQL_DB_NO_SIMULADO: ${text}`);
      },
      connect: async () => client,
    },
  };
  return { app, calls, actorClaims };
}

test('admin A busca y consulta cliente A', async () => {
  const { app, calls, actorClaims } = fixture();
  const search = await searchActiveClientesForAdminPoints(app, { q: 'Cliente', claims: actorClaims, allowGlobalAssignment: true });
  assert.deepEqual(search.clientes.map((row) => row.id_cliente), [CLIENT]);
  const summary = await getClientePointsSummary(app, CLIENT, { claims: actorClaims, allowGlobalAssignment: true });
  assert.equal(summary.id_cliente, CLIENT); assert.equal(summary.saldo_total, 4);
  assert.equal(calls.some(({ sql }) => sql.includes('fn_points_materialize_expired_cycles')), false);
  assert.ok(calls.some(({ sql }) => sql.includes('FROM public.vw_points_balance')));
});

test('admin A busca y consulta globalmente cliente B sin materializar movimientos', async () => {
  const { app, calls, actorClaims } = fixture({ clientBranch: BRANCH_B });
  const search = await searchActiveClientesForAdminPoints(app, { q: 'Cliente', claims: actorClaims, allowGlobalAssignment: true });
  assert.equal(search.clientes[0].id_cliente, CLIENT);
  assert.equal(search.clientes[0].id_sucursal_origen, BRANCH_B);
  const summary = await getClientePointsSummary(app, CLIENT, { claims: actorClaims, allowGlobalAssignment: true });
  assert.equal(summary.id_cliente, CLIENT);
  assert.equal(summary.id_sucursal_origen, BRANCH_B);
  assert.equal(calls.some(({ sql }) => sql.includes('fn_points_materialize_expired_cycles')), false);
  assert.ok(calls.some(({ sql }) => sql.includes('FROM public.vw_points_balance')));
});

test('Fastify inject permite buscar, resumir y sumar globalmente, pero rechaza restar fuera de alcance', async (t) => {
  const scoped = fixture({ clientBranch: BRANCH_B });
  const app = Fastify({ logger: false });
  app.decorate('db', scoped.app.db);
  app.decorate('requireRoles', () => async (request) => { request.claims = scoped.actorClaims; });
  await app.register(adminPointsRoutes, { prefix: '/puntos' }); await app.ready();
  t.after(() => app.close());

  const search = await app.inject('/puntos/clientes/buscar?q=Cliente');
  const summary = await app.inject(`/puntos/clientes/${CLIENT}/resumen`);
  const addition = await app.inject({
    method: 'POST', url: `/puntos/clientes/${CLIENT}/ajuste`,
    headers: { 'x-idempotency-key': IDEMPOTENCY_KEY },
    payload: { accion: 'sumar', puntos: 5, motivo: 'Ajuste sintético' },
  });
  const subtraction = await app.inject({
    method: 'POST', url: `/puntos/clientes/${CLIENT}/ajuste`,
    headers: { 'x-idempotency-key': '77777777-7777-4777-8777-777777777777' },
    payload: { accion: 'restar', puntos: 5, motivo: 'Ajuste sintético' },
  });

  assert.equal(search.statusCode, 200); assert.equal(search.json().data.clientes[0].id_cliente, CLIENT);
  assert.equal(summary.statusCode, 200); assert.equal(summary.json().data.id_cliente, CLIENT);
  assert.equal(addition.statusCode, 200); assert.equal(addition.json().data.id_cliente, CLIENT);
  assert.equal(subtraction.statusCode, 403);
  assert.equal(subtraction.json().error.code, 'POINTS_CLIENT_BRANCH_FORBIDDEN');
  assert.equal(scoped.calls.filter(({ sql }) => sql.includes('INSERT INTO public.points_transactions')).length, 1);
});

test('admin con múltiples sucursales puede consultar cliente B', async () => {
  const actorClaims = claims(['admin'], [BRANCH_A, BRANCH_B]);
  const { app } = fixture({ actorClaims, clientBranch: BRANCH_B });
  assert.equal((await getClientePointsSummary(app, CLIENT, { claims: actorClaims, allowGlobalAssignment: true })).id_cliente, CLIENT);
});

test('cliente elegible sin sucursal es visible y admite suma, pero no resta para admin', async () => {
  const { app, calls, actorClaims } = fixture({ clientBranch: null });
  const search = await searchActiveClientesForAdminPoints(app, { q: 'Cliente', claims: actorClaims, allowGlobalAssignment: true });
  assert.equal(search.clientes[0].id_cliente, CLIENT); assert.equal(search.clientes[0].id_sucursal_origen, null);
  assert.equal((await getClientePointsSummary(app, CLIENT, { claims: actorClaims, allowGlobalAssignment: true })).id_sucursal_origen, null);
  await addManualPointsAdjustment(app, {
    idCliente: CLIENT, accion: 'sumar', puntos: 5, motivo: 'Ajuste sintético',
    usuarioAdmin: actorClaims.user, claims: actorClaims, idempotencyKey: IDEMPOTENCY_KEY, allowGlobalAssignment: true,
  });
  await assert.rejects(addManualPointsAdjustment(app, {
    idCliente: CLIENT, accion: 'restar', puntos: 5, motivo: 'Ajuste sintético',
    usuarioAdmin: actorClaims.user, claims: actorClaims,
    idempotencyKey: '77777777-7777-4777-8777-777777777777',
  }), { statusCode: 403, code: 'POINTS_CLIENT_BRANCH_FORBIDDEN' });
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO public.points_transactions')).length, 1);
});

test('super_admin conserva búsqueda y resumen globales', async () => {
  const actorClaims = claims(['super_admin'], []);
  const { app } = fixture({ actorClaims, clientBranch: BRANCH_B });
  assert.equal((await searchActiveClientesForAdminPoints(app, { q: 'Cliente', claims: actorClaims })).clientes[0].id_cliente, CLIENT);
  assert.equal((await getClientePointsSummary(app, CLIENT, { claims: actorClaims })).id_cliente, CLIENT);
});

test('super_admin conserva ajuste global para cliente B', async () => {
  const actorClaims = claims(['super_admin'], []);
  const { app, calls } = fixture({ actorClaims, clientBranch: BRANCH_B });
  const result = await addManualPointsAdjustment(app, {
    idCliente: CLIENT, accion: 'sumar', puntos: 5, motivo: 'Ajuste sintético',
    usuarioAdmin: actorClaims.user, claims: actorClaims, idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(result.id_cliente, CLIENT);
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO public.points_transactions')).length, 1);
});

test('resumen del flujo cliente sin claims administrativos conserva comportamiento existente', async () => {
  const { app, calls } = fixture({ clientBranch: BRANCH_B });
  assert.equal((await getClientePointsSummary(app, CLIENT)).id_cliente, CLIENT);
  assert.equal(calls.some(({ target, sql }) => target === 'db' && sql.includes('FROM public.sucursales')), false);
});

test('resta fuera de alcance revierte sin insertar ni modificar puntos', async () => {
  const { app, calls, actorClaims } = fixture({ clientBranch: BRANCH_B });
  await assert.rejects(addManualPointsAdjustment(app, {
    idCliente: CLIENT, accion: 'restar', puntos: 5, motivo: 'Ajuste sintético',
    usuarioAdmin: actorClaims.user, claims: actorClaims, idempotencyKey: IDEMPOTENCY_KEY,
  }), { statusCode: 403, code: 'POINTS_CLIENT_BRANCH_FORBIDDEN' });
  assert.equal(calls.some(({ sql }) => /INSERT INTO|UPDATE public\./.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
  assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
});

test('ajuste autorizado conserva la transacción y el saldo', async () => {
  const { app, calls, actorClaims } = fixture();
  const result = await addManualPointsAdjustment(app, {
    idCliente: CLIENT, accion: 'sumar', puntos: 5, motivo: 'Ajuste sintético',
    usuarioAdmin: actorClaims.user, claims: actorClaims, idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(result.saldo_actual, 9); assert.equal(result.saldo_siguiente, 9);
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO public.points_transactions')).length, 1);
  assert.equal(calls.filter(({ sql }) => sql === 'COMMIT').length, 1);
  const lockIndex = calls.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'));
  const insertIndex = calls.findIndex(({ sql }) => sql.includes('INSERT INTO public.points_transactions'));
  assert.ok(lockIndex < insertIndex);
});

test('resta autorizada de admin conserva validación por sucursal antes de insertar', async () => {
  const { app, calls, actorClaims } = fixture({ balance: 20 });
  await addManualPointsAdjustment(app, {
    idCliente: CLIENT, accion: 'restar', puntos: 5, motivo: 'Ajuste sintético',
    usuarioAdmin: actorClaims.user, claims: actorClaims,
    idempotencyKey: '77777777-7777-4777-8777-777777777777',
  });
  const scopeIndex = calls.findIndex(({ sql }) => sql.startsWith('SELECT c.id_cliente'));
  const insertIndex = calls.findIndex(({ sql }) => sql.includes('INSERT INTO public.points_transactions'));
  assert.ok(scopeIndex >= 0 && scopeIndex < insertIndex);
});

test('saldo insuficiente autorizado conserva rollback e integridad', async () => {
  const { app, calls, actorClaims } = fixture({ balance: 2 });
  await assert.rejects(addManualPointsAdjustment(app, {
    idCliente: CLIENT, accion: 'restar', puntos: 5, motivo: 'Ajuste sintético',
    usuarioAdmin: actorClaims.user, claims: actorClaims, idempotencyKey: IDEMPOTENCY_KEY,
  }), { statusCode: 422, code: 'POINTS_INSUFFICIENT_BALANCE' });
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO public.points_transactions')), false);
  assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
});

test('recompensa pendiente bloquea suma manual sin movimiento ni confirmación idempotente', async () => {
  const { app, calls, actorClaims } = fixture({ balance: 10 });
  await assert.rejects(addManualPointsAdjustment(app, {
    idCliente: CLIENT, accion: 'sumar', puntos: 1, motivo: 'Ajuste bloqueado',
    usuarioAdmin: actorClaims.user, claims: actorClaims, idempotencyKey: IDEMPOTENCY_KEY,
  }), { statusCode: 409, code: 'POINTS_REWARD_PENDING' });
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO public.points_transactions')), false);
  assert.equal(calls.some(({ sql }) => sql.includes('UPDATE app_private.points_manual_adjustment_idempotency')), false);
  assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
});

test('suma manual no sobrepasa la meta y vuelve a permitirse debajo de ella', async () => {
  const blocked = fixture({ balance: 9 });
  await assert.rejects(addManualPointsAdjustment(blocked.app, {
    idCliente: CLIENT, accion: 'sumar', puntos: 2, motivo: 'Ajuste excedente',
    usuarioAdmin: blocked.actorClaims.user, claims: blocked.actorClaims, idempotencyKey: IDEMPOTENCY_KEY,
  }), { statusCode: 409, code: 'POINTS_REWARD_PENDING' });
  assert.equal(blocked.calls.some(({ sql }) => sql.includes('INSERT INTO public.points_transactions')), false);

  const allowed = fixture({ balance: 8 });
  const result = await addManualPointsAdjustment(allowed.app, {
    idCliente: CLIENT, accion: 'sumar', puntos: 2, motivo: 'Ajuste permitido',
    usuarioAdmin: allowed.actorClaims.user, claims: allowed.actorClaims, idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(result.saldo_siguiente, 10);
});
