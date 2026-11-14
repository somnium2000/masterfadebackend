import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('El guard de orden Hosted corre despues del normalizador real de grupo sin aplicar SQL', async () => {
  const [hosted, canonical] = await Promise.all([
    readFile(new URL('../db/migrations/pixel/20261114010000_pixelpay_hosted_qa.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260701_microfase_2a2_reconciliacion_transaccional.sql', import.meta.url), 'utf8'),
  ]);
  const guardName = hosted.match(/CREATE TRIGGER\s+(\w+)\s+BEFORE INSERT OR UPDATE[^;]+ON public\.payment_intents/)?.[1];
  const normalizerName = canonical.match(/CREATE TRIGGER\s+(\w+)\s+BEFORE INSERT OR UPDATE ON public\.payment_intents\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.fn_payment_intents_set_group/)?.[1];
  assert.ok(guardName);
  assert.equal(normalizerName, 'tr_payment_intents_set_group');
  assert.ok(guardName > normalizerName, 'PostgreSQL ejecuta triggers equivalentes por nombre: primero debe completar el grupo');
  assert.match(canonical, /NEW\.id_grupo_cita := v_id_grupo_cita/);
});
