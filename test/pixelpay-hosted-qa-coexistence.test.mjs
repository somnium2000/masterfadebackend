import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePixelPayHostedConfig } from '../src/services/payments/pixelPayHosted.js';
import { resolveQaPaymentSimulationConfig, resolveQaVipPurchaseSimulationConfig } from '../src/config/qaPaymentSimulation.js';

const simulated = {
  NODE_ENV: 'development', ENTORNO: 'qa', PAYMENT_PROVIDER: 'todopago', TODOPAGO_MODE: 'preprod_simulated',
  TODOPAGO_SIMULATED_ENABLED: 'true', ENABLE_QA_PAYMENT_SIMULATION: 'true',
  ENABLE_QA_VIP_PURCHASE_SIMULATION: 'true', MEMBERSHIP_PAYMENT_SIMULATOR_ENABLED: 'true',
  PIXELPAY_HOSTED_ENABLED: 'false',
};
const hosted = {
  PIXELPAY_ENV: 'sandbox', PIXELPAY_HOSTED_KEY_ID: 'TESTKEY', PIXELPAY_HOSTED_SECRET_KEY: 'synthetic-only',
  PIXELPAY_HOSTED_APP_URL: 'https://pixelpay.app', FRONTEND_URL: 'https://qa.masterfadeapp.com',
  PIXELPAY_HOSTED_CALLBACK_URL: 'https://qa-api.example.invalid/v1/pagos/pixelpay/hosted/callback',
};

test('QA TodoPago y VIP conservan simulacion con Hosted apagado', () => {
  assert.equal(resolvePixelPayHostedConfig(simulated).enabled, false);
  assert.equal(resolveQaPaymentSimulationConfig(simulated).enabled, true);
  assert.equal(resolveQaVipPurchaseSimulationConfig(simulated).enabled, true);
});
test('Hosted activo no admite el proveedor global TodoPago de QA', () => {
  const env = { ...simulated, ...hosted, PIXELPAY_HOSTED_ENABLED: 'true' };
  assert.throws(() => resolvePixelPayHostedConfig(env), /Hosted solo se permite/);
  assert.equal(resolveQaPaymentSimulationConfig(env).enabled, true);
});
test('Cambiar globalmente a PixelPay conservando flags QA impide arrancar simuladores', () => {
  const env = { ...simulated, ...hosted, PAYMENT_PROVIDER: 'pixelpay', PIXELPAY_HOSTED_ENABLED: 'true' };
  assert.equal(resolvePixelPayHostedConfig(env).enabled, true);
  assert.throws(() => resolveQaPaymentSimulationConfig(env), /requiere/);
  assert.throws(() => resolveQaVipPurchaseSimulationConfig(env), /requiere/);
});
test('PixelPay y flags QA apagados sustituyen simulador, no demuestran coexistencia', () => {
  const env = { ...simulated, ...hosted, PAYMENT_PROVIDER: 'pixelpay', PIXELPAY_HOSTED_ENABLED: 'true',
    ENABLE_QA_PAYMENT_SIMULATION: 'false', ENABLE_QA_VIP_PURCHASE_SIMULATION: 'false', MEMBERSHIP_PAYMENT_SIMULATOR_ENABLED: 'false' };
  assert.equal(resolvePixelPayHostedConfig(env).enabled, true);
  assert.equal(resolveQaPaymentSimulationConfig(env).enabled, false);
  assert.equal(resolveQaVipPurchaseSimulationConfig(env).enabled, false);
});
test('Solo receptor Hosted puede coexistir con TodoPago si conserva configuracion Sandbox dedicada', () => {
  const env = { ...simulated, ...hosted };
  assert.equal(resolvePixelPayHostedConfig(env).enabled, false);
  assert.equal(resolvePixelPayHostedConfig(env).receivingEnabled, true);
  assert.equal(resolveQaPaymentSimulationConfig(env).enabled, true);
  assert.equal(resolveQaVipPurchaseSimulationConfig(env).enabled, true);
});
test('Receptor con claves retenidas exige Sandbox aun con creacion apagada', () => {
  assert.throws(() => resolvePixelPayHostedConfig({ ...simulated, ...hosted, PIXELPAY_ENV: '' }), /Hosted solo se permite/);
});
