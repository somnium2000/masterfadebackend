import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUnfinishedPixelPay3dsResponse } from '../src/services/payments/pixelPayStatusCandidate.js';

const ID = '11111111-1111-4111-8111-111111111111';
const pending = { id_intent: ID, estado_intent_codigo: 'pendiente_confirmacion' };

test('HTTP 202 en intento pendiente exige estado local y nunca getStatus externo', async () => {
  let calls = 0;
  const db = { async query(sql, values) {
    calls++;
    assert.match(sql, /upstream_http_status\s*=\s*202/);
    assert.match(sql, /sdk_response_class\s*=\s*'PayloadResponse'/);
    assert.match(sql, /id_intent\s*=\s*\$1::uuid/);
    assert.deepEqual(values, [ID]);
    return { rows: [{ awaiting_authentication: true }] };
  } };
  assert.equal(await hasUnfinishedPixelPay3dsResponse(db, pending), true);
  assert.equal(calls, 1);
});

test('un intento sin evidencia 202 puede seguir la conciliacion ordinaria', async () => {
  const db = { async query() { return { rows: [{ awaiting_authentication: false }] }; } };
  assert.equal(await hasUnfinishedPixelPay3dsResponse(db, pending), false);
});

test('el guard no consulta la base para estados ya definitivos o no iniciados', async () => {
  const db = { async query() { assert.fail('no debe consultar la base'); } };
  for (const state of ['confirmado', 'fallido', 'expirado', 'link_generado']) {
    assert.equal(await hasUnfinishedPixelPay3dsResponse(db, { ...pending, estado_intent_codigo: state }), false);
  }
});

test('sin identidad local del intent falla cerrado', async () => {
  const db = { async query() { assert.fail('no debe consultar sin identidad'); } };
  await assert.rejects(hasUnfinishedPixelPay3dsResponse(db, {
    estado_intent_codigo: 'pendiente_confirmacion',
  }), e => e.code === 'PIXELPAY_3DS_STATUS_GATE_UNAVAILABLE');
});

test('error de lectura no permite continuar hacia el proveedor', async () => {
  const db = { async query() { throw new Error('db unavailable'); } };
  await assert.rejects(hasUnfinishedPixelPay3dsResponse(db, pending), /db unavailable/);
});
