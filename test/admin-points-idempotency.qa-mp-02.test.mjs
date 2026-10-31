import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';

import adminPointsRoutes from '../src/routes/v1/admin/puntos.js';
import { addManualPointsAdjustment } from '../src/services/pointsService.js';

const BRANCH = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const TX = '55555555-5555-4555-8555-555555555555';
const KEY = '66666666-6666-4666-8666-666666666666';
const actorClaims = { roles: ['admin'], branch_ids: [BRANCH], user: { id_usuario: ADMIN } };

function fixture() {
  const idempotency = new Map(); const movements = []; const calls = []; let balance = 20;
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim(); calls.push({ text, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text) || text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (text.startsWith('SELECT c.id_cliente') && !text.includes('JOIN public.personas p')) return { rows: [{ id_cliente: CLIENT }], rowCount: 1 };
      if (text.includes('JOIN public.personas p')) return { rows: [{ id_cliente: CLIENT, id_usuario: USER, id_sucursal_origen: BRANCH, nombres: 'Cliente', apellidos: 'QA' }] };
      if (text.includes('FROM public.usuarios u')) return { rows: [{ id_usuario: USER }] };
      if (text.includes('FROM public.tipos_puntos')) return { rows: [{ tipo_puntos_codigo: 'ajustar', signo: 1 }, { tipo_puntos_codigo: 'ajuste_resta', signo: -1 }] };
      if (text.includes('fn_points_materialize_expired_cycles')) return { rows: [] };
      if (text.includes('SELECT COALESCE(SUM(pt.puntos), 0)::int AS saldo_total')) return { rows: [{ saldo_total: balance }] };
      if (text.includes('INSERT INTO app_private.points_manual_adjustment_idempotency')) {
        if (idempotency.has(params[0])) return { rows: [], rowCount: 0 };
        const row = { idempotency_key: params[0], payload_hash: params[1], response_payload: null };
        idempotency.set(params[0], row); return { rows: [row], rowCount: 1 };
      }
      if (text.includes('FROM app_private.points_manual_adjustment_idempotency')) {
        const row = idempotency.get(params[0]); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes('INSERT INTO public.points_transactions')) {
        const points = Number(params[3]); balance += points; movements.push(points);
        return { rows: [{ id_points_tx: TX, id_cliente: CLIENT, tipo_puntos_codigo: params[2], origen_punto_codigo: 'sistema', puntos: points, motivo: params[4], created_at: '2026-10-31T12:00:00.000Z' }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE app_private.points_manual_adjustment_idempotency')) {
        const row = idempotency.get(params[0]); row.response_payload = JSON.parse(params[2]); row.id_points_tx = params[1]; return { rows: [], rowCount: 1 };
      }
      throw new Error(`SQL_NO_SIMULADO: ${text}`);
    },
    release() {},
  };
  return { app: { db: { connect: async () => client, query: async () => ({ rows: [{ id_sucursal: BRANCH }] }) } }, calls, movements };
}

const input = (overrides = {}) => ({ idCliente: CLIENT, accion: 'sumar', puntos: 5, motivo: 'Ajuste QA', usuarioAdmin: actorClaims.user, claims: actorClaims, idempotencyKey: KEY, ...overrides });

test('misma clave y payload persisten un solo movimiento y reproducen la respuesta', async () => {
  const f = fixture(); const first = await addManualPointsAdjustment(f.app, input()); const replay = await addManualPointsAdjustment(f.app, input());
  assert.equal(f.movements.length, 1); assert.equal(first.id_points_tx, replay.id_points_tx); assert.equal(replay.idempotent_replay, true);
});

test('misma clave con payload diferente produce conflicto sin segundo movimiento', async () => {
  const f = fixture(); await addManualPointsAdjustment(f.app, input());
  await assert.rejects(addManualPointsAdjustment(f.app, input({ puntos: 6 })), { statusCode: 409, code: 'POINTS_ADJUSTMENT_IDEMPOTENCY_CONFLICT' });
  assert.equal(f.movements.length, 1);
});

test('la ruta exige y propaga x-idempotency-key', async (t) => {
  const f = fixture(); const app = Fastify({ logger: false }); app.decorate('db', f.app.db);
  app.decorate('requireRoles', () => async (request) => { request.claims = actorClaims; });
  await app.register(adminPointsRoutes, { prefix: '/puntos' }); await app.ready(); t.after(() => app.close());
  const missing = await app.inject({ method: 'POST', url: `/puntos/clientes/${CLIENT}/ajuste`, payload: { accion: 'sumar', puntos: 5, motivo: 'Ajuste QA' } });
  assert.equal(missing.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: `/puntos/clientes/${CLIENT}/ajuste`, headers: { 'x-idempotency-key': KEY }, payload: { accion: 'sumar', puntos: 5, motivo: 'Ajuste QA' } });
  assert.equal(ok.statusCode, 200, ok.body); assert.equal(f.movements.length, 1);
});

test('migración define clave única, resultado durable y acceso privado', async () => {
  const sql = await readFile(new URL('../db/migrations/20261031143653_masterpuntos_manual_adjustment_idempotency_v1.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE app_private\.points_manual_adjustment_idempotency/i);
  assert.match(sql, /idempotency_key uuid PRIMARY KEY/i);
  assert.match(sql, /payload_hash text NOT NULL/i);
  assert.match(sql, /response_payload jsonb NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX ux_points_manual_adjustment_idempotency_tx/i);
  assert.match(sql, /REVOKE ALL[^;]+FROM anon/i);
  assert.match(sql, /REVOKE ALL[^;]+FROM authenticated/i);
});
