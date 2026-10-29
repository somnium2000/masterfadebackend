import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AppError, sendError } from '../src/utils/errors.js';
import { sendOk } from '../src/utils/response.js';
import Fastify from 'fastify';

// AM: Ejecuta los helpers reales en memoria, sin registrar timers ni conexiones.
const source = readFileSync(new URL('../src/routes/v1/admin/configuracion.js', import.meta.url), 'utf8');
const context = vm.createContext({ process: { env: { COMMUNICATION_SCHEDULER_ENABLED: 'false' } }, AppError, sendError, sendOk, Date, Set, Map });
vm.runInContext(source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export default ', '') + `
globalThis.helpers = { processCampaignShipmentsDelivery, refreshCommunicationCampaignMetrics,
  listCampaignShipments, normalizeCommunicationSendError, runCommunicationScheduledDispatchTick,
  tryAcquireCommunicationSendLock, releaseCommunicationSendLock, buildEligibilityEvaluationCte, adminConfiguracionRoutes };`, context);
const h = context.helpers;
const campaign = { id_campania: 'campaign', estado: 'programada', asunto: 'Aviso', contenido_texto: 'Sintético', creada_por: 'actor' };

function fixture({ reason = 'elegible', status = 'pendiente', address = 'test@example.test', databaseError = false, campaignStatus = 'programada' } = {}) {
  const row = { id_envio: 'shipment', id_cliente: 'client', id_persona: 'person', correo_destino: 'test@example.test', nombre_cliente: 'Sintético' };
  let current = status, sent = 0, omitted = 3, attempts = 0, locked = false;
  const queries = [], logs = [];
  const client = { release() {}, async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('information_schema.columns')) return { rows: [] };
    if (sql.includes('pg_try_advisory_lock')) { const acquired = !locked; locked = true; return { rows: [{ locked: acquired }] }; }
    if (sql.includes('pg_advisory_unlock')) { locked = false; return { rows: [{ pg_advisory_unlock: true }] }; }
    if (sql.includes('GROUP BY ce.id_campania')) return { rows: [{ id_campania: campaign.id_campania }] };
    if (sql.includes('SELECT') && sql.includes('FROM public.comunicaciones_campanias')) return { rows: [{ ...campaign, estado: campaignStatus }] };
    if (sql.includes('JOIN resultado') && sql.includes('comunicaciones_envios')) {
      if (databaseError) throw new Error('synthetic database unavailable');
      assert.match(sql, /ce\.id_cliente/); assert.match(sql, /ce\.id_persona/);
      assert.match(sql, /ce\.estado_envio/); assert.match(sql, /c\.deleted_at IS NULL/);
      return { rows: current === params[2] ? [{ estado_elegibilidad: reason, correo_actual: address }] : [] };
    }
    if (sql.includes('WITH omitido AS')) {
      assert.match(sql, /estado_envio = \$3::text/);
      if (current === params[2]) { current = 'omitido'; omitted++; }
      return { rows: [] };
    }
    if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total_destinatarios: 1, total_pendientes: ['pendiente', 'enviando'].includes(current) ? 1 : 0, total_enviados: current === 'enviado' ? 1 : 0, total_fallidos: current === 'fallido' ? 1 : 0 }] };
    if (sql.includes('UPDATE public.comunicaciones_campanias')) return { rows: [{ ...campaign, total_omitidos: omitted, total_pendientes: params[2], total_enviados: params[3], total_fallidos: params[4] }] };
    if (sql.includes('UPDATE public.comunicaciones_envios')) {
      if (sql.includes('SET\n          estado_envio = $4::text')) {
        if (current !== params[2]) return { rows: [] };
        current = params[3]; attempts++; return { rows: [{ id_envio: row.id_envio }] };
      }
      if (sql.includes('estado_envio = $2::text') && params[3] === 'enviando') {
        if (current !== params[3]) return { rows: [] };
        current = params[1]; return { rows: [{ id_envio: row.id_envio }] };
      }
      current = params[1]; attempts++; return { rows: [] };
    }
    if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
    if (sql.includes('ce.ultimo_error')) return { rows: [{ ...row, estado_envio: current, ultimo_error: 'smtp internal.test token=SECRET /private/key' }] };
    if (sql.includes('ce.estado_envio = $2::text')) return { rows: current === params[1] ? [row] : [] };
    throw new Error(`Unexpected mocked query: ${sql.slice(0, 60)}`);
  } };
  const mailer = { configured: true, async sendMail() { sent++; return { sent: true }; } };
  return { client, mailer, queries, logs, state: () => ({ current, sent, omitted, attempts }) };
}

for (const reason of ['sin_consentimiento_marketing', 'inactivo', null, 'sin_aceptacion_terminos', 'sin_correo']) {
  test(`no entrega a destinatario ${reason}; omisión idempotente`, async () => {
    const f = fixture({ reason });
    await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
    await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
    assert.equal(f.state().sent, 0); assert.equal(f.state().current, 'omitido');
    assert.equal(f.state().omitted, 4); assert.equal(f.state().attempts, 0);
  });
}
test('correo cambiado no redirige ni entrega', async () => {
  const f = fixture({ address: 'changed@example.test' });
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
  assert.equal(f.state().sent, 0); assert.equal(f.state().current, 'omitido');
});
test('elegible conserva entrega y no duplica tras reintento', async () => {
  const f = fixture();
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
  assert.equal(f.state().sent, 1); assert.equal(f.state().current, 'enviado');
});
test('SMTP aceptado y fallo PostgreSQL posterior no permite reenvío automático', async () => {
  const f = fixture();
  const originalQuery = f.client.query.bind(f.client);
  let failAfterSmtp = true;
  f.client.query = async (sql, params = []) => {
    if (failAfterSmtp && sql.includes('UPDATE public.comunicaciones_envios') && params[1] === 'enviado') {
      failAfterSmtp = false;
      throw new Error('synthetic database write failure after SMTP');
    }
    return originalQuery(sql, params);
  };
  await assert.rejects(() => h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente'));
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
  assert.equal(f.state().sent, 1);
  assert.equal(f.state().current, 'enviando');
  const metrics = await h.refreshCommunicationCampaignMetrics(f.client, campaign.id_campania, 'actor');
  assert.equal(metrics.total_pendientes, 1);
});
test('falla PostgreSQL al reclamar el envío impide invocar SMTP', async () => {
  const f = fixture();
  const originalQuery = f.client.query.bind(f.client);
  f.client.query = async (sql, params = []) => {
    if (sql.includes('SET\n          estado_envio = $4::text')) throw new Error('synthetic claim failure');
    return originalQuery(sql, params);
  };
  await assert.rejects(() => h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente'));
  assert.equal(f.state().sent, 0); assert.equal(f.state().current, 'pendiente');
});
for (const status of ['enviado', 'omitido']) test(`no reenvía estado ${status}`, async () => {
  const f = fixture({ status }); await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
  assert.equal(f.state().sent, 0);
});
test('reintento fallido con consentimiento revocado se omite', async () => {
  const f = fixture({ status: 'fallido', reason: 'sin_consentimiento_marketing' });
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'fallido');
  assert.equal(f.state().sent, 0); assert.equal(f.state().current, 'omitido');
});
test('reintento fallido inequívoco conserva envío legítimo', async () => {
  const f = fixture({ status: 'fallido' });
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'fallido');
  assert.equal(f.state().sent, 1); assert.equal(f.state().current, 'enviado');
});
test('error temporal no envía ni convierte en omisión permanente', async () => {
  const f = fixture({ databaseError: true });
  await assert.rejects(() => h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente'));
  assert.equal(f.state().sent, 0); assert.equal(f.state().current, 'pendiente');
});
test('scheduler comparte revalidación y actualiza métricas incluso si solo omite', async () => {
  const f = fixture({ reason: 'sin_consentimiento_marketing' });
  await h.runCommunicationScheduledDispatchTick({ db: { connect: async () => f.client }, mailer: f.mailer, log: { error() {}, warn() {} } });
  assert.equal(f.state().sent, 0); assert.equal(f.state().current, 'omitido');
  assert.ok(f.queries.some(q => q.sql.includes('total_pendientes = $3')));
  assert.ok(f.queries.some(q => q.sql.includes('pg_advisory_unlock')));
});
test('scheduler reiniciado no procesa campaña cancelada', async () => {
  const f = fixture({ campaignStatus: 'cancelada' });
  await h.runCommunicationScheduledDispatchTick({ db: { connect: async () => f.client }, mailer: f.mailer, log: { error() {}, warn() {} } });
  assert.equal(f.state().sent, 0); assert.equal(f.state().current, 'pendiente');
});
test('métricas conservan exclusiones iniciales y omisión de cola', async () => {
  const f = fixture({ reason: 'inactivo' });
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
  const metrics = await h.refreshCommunicationCampaignMetrics(f.client, campaign.id_campania, 'actor');
  assert.equal(metrics.total_omitidos, 4); assert.equal(metrics.total_pendientes, 0);
  assert.equal(metrics.total_enviados, 0); assert.equal(metrics.total_fallidos, 0);
});
for (const raw of ['smtp internal.test', 'token=SYNTHETIC', '/private/mail/key', 'Error', '', 'X'.repeat(2000)]) test(`error de proveedor seguro (${raw.length})`, () => {
  assert.equal(h.normalizeCommunicationSendError(raw), 'No se pudo enviar el correo. Reintenta más tarde.');
});
test('historial histórico inseguro se sanea en backend', async () => {
  const f = fixture(); const result = await h.listCampaignShipments(f.client, campaign.id_campania);
  assert.equal(result.envios[0].ultimo_error, 'No se pudo enviar el correo. Reintenta más tarde.');
});
test('los tres flujos conservan locks y helper compartido', () => {
  assert.equal((source.match(/await processCampaignShipmentsDelivery\(/g) || []).length, 3);
  assert.equal((source.match(/lockAcquired = await tryAcquireCommunicationSendLock/g) || []).length, 4);
  assert.match(h.buildEligibilityEvaluationCte(), /consentimiento_marketing, FALSE\) IS TRUE/);
});

async function httpFixture(f) {
  const app = Fastify();
  app.decorate('db', { connect: async () => f.client }); app.decorate('mailer', f.mailer);
  app.decorate('requireRoles', () => async request => { request.claims = { user: { id_usuario: 'actor' } }; });
  await app.register(h.adminConfiguracionRoutes); await app.ready(); return app;
}

async function scheduleHttpFixture() {
  const scheduledValues = [];
  let shipmentCount = 0;
  const campaignRow = {
    id_campania: '11111111-1111-4111-8111-111111111111', tipo_campania: 'informativa', canal: 'email',
    nombre_interno: 'QA', asunto: 'Aviso', contenido_texto: 'Contenido', observaciones: null,
    estado: 'borrador', total_destinatarios: 0, total_pendientes: 0, total_enviados: 0,
    total_fallidos: 0, total_omitidos: 0, creada_por: '22222222-2222-4222-8222-222222222222',
  };
  const recipient = {
    id_cliente: '33333333-3333-4333-8333-333333333333',
    id_persona: '44444444-4444-4444-8444-444444444444',
    id_usuario: '55555555-5555-4555-8555-555555555555',
    nombres: 'Cliente', apellidos: 'QA', nombre_cliente: 'Cliente QA', correo_destino: 'qa@example.test',
  };
  const client = { release() {}, async query(sql, params = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('information_schema.columns')) return { rows: [] };
    if (sql.includes('FROM public.comunicaciones_campanias') && sql.includes('FOR UPDATE')) return { rows: [campaignRow] };
    if (sql.includes('FROM public.comunicaciones_envios') && sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: shipmentCount }] };
    if (sql.includes('total_clientes_evaluados')) return { rows: [{ total_clientes_evaluados: 1, total_elegibles: 1, total_excluidos: 0 }] };
    if (sql.includes('GROUP BY estado_elegibilidad')) return { rows: [] };
    if (sql.includes("WHERE estado_elegibilidad = 'elegible'") && sql.includes('LIMIT $1::int')) return { rows: [recipient] };
    if (sql.includes("WHERE estado_elegibilidad <> 'elegible'") && sql.includes('LIMIT $1::int')) return { rows: [] };
    if (sql.includes("WHERE estado_elegibilidad = 'elegible'") && sql.includes('id_persona')) return { rows: [recipient] };
    if (sql.includes("WHERE estado_elegibilidad <> 'elegible'")) return { rows: [] };
    if (sql.includes('INSERT INTO public.comunicaciones_envios')) { shipmentCount += 1; scheduledValues.push({ kind: 'shipment', params }); return { rows: [] }; }
    if (sql.includes('UPDATE public.comunicaciones_campanias')) {
      scheduledValues.push({ kind: 'campaign', params });
      Object.assign(campaignRow, { estado: 'programada', programada_para: params[1], total_destinatarios: 1, total_pendientes: 1 });
      return { rows: [campaignRow] };
    }
    throw new Error(`Unexpected mocked query: ${sql.slice(0, 80)}`);
  } };
  const f = { client, mailer: { configured: false } };
  const app = await httpFixture(f);
  return { app, scheduledValues };
}

for (const explicitDate of [null, '2030-01-15T18:00:00.000Z']) {
  test(`programación ${explicitDate ? 'explícita' : 'implícita'} persiste la misma fecha efectiva en campaña y envío`, async t => {
    const { app, scheduledValues } = await scheduleHttpFixture(); t.after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/comunicacion/campanias/11111111-1111-4111-8111-111111111111/programar',
      payload: explicitDate ? { programada_para: explicitDate } : {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const shipmentDate = scheduledValues.find(row => row.kind === 'shipment').params[6];
    const campaignDate = scheduledValues.find(row => row.kind === 'campaign').params[1];
    assert.equal(campaignDate, shipmentDate);
    assert.equal(response.json().data.programada_para, shipmentDate);
    assert.equal(new Date(shipmentDate).toISOString(), shipmentDate);
    if (explicitDate) {
      assert.equal(shipmentDate, explicitDate);
      const tegucigalpaHour = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Tegucigalpa', hour: '2-digit', hourCycle: 'h23',
      }).format(new Date(shipmentDate));
      assert.equal(tegucigalpaHour, '12');
    }
    const repeated = await app.inject({
      method: 'POST',
      url: '/comunicacion/campanias/11111111-1111-4111-8111-111111111111/programar',
      payload: explicitDate ? { programada_para: explicitDate } : {},
    });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().data.ya_programada, true);
    assert.equal(scheduledValues.filter(row => row.kind === 'shipment').length, 1);
  });
}
for (const [endpoint, status] of [['enviar', 'pendiente'], ['reintentar-fallidos', 'fallido']]) test(`HTTP ${endpoint} revalida antes del mailer`, async t => {
  const f = fixture({ reason: 'sin_consentimiento_marketing', status }); const app = await httpFixture(f); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: `/comunicacion/campanias/11111111-1111-4111-8111-111111111111/${endpoint}` });
  assert.equal(response.statusCode, 200, response.body); assert.equal(f.state().sent, 0); assert.equal(f.state().current, 'omitido');
});
test('dos envíos concurrentes: lock rechaza al segundo y no hay duplicado', async t => {
  const f = fixture(); let release, entered;
  const pending = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  f.mailer.sendMail = async () => { entered(); await pending; return { sent: true }; };
  const app = await httpFixture(f); t.after(() => app.close());
  const url = '/comunicacion/campanias/11111111-1111-4111-8111-111111111111/enviar';
  const first = app.inject({ method: 'POST', url }).then(response => response);
  await started;
  const second = await app.inject({ method: 'POST', url }); assert.equal(second.statusCode, 409);
  release(); assert.equal((await first).statusCode, 200); assert.equal(f.state().attempts, 1);
});
test('exclusión manual de programación no crea una fila elegible en cola', () => {
  const filter = source.match(/eligibleRecipients\.filter\(\(recipient\) => !excludedSet\.has\(String\(recipient.id_cliente\)\)\)/)?.[0];
  assert.ok(filter);
  const recipients = vm.runInNewContext(filter, { eligibleRecipients: [{ id_cliente: 'allowed' }, { id_cliente: 'excluded' }], excludedSet: new Set(['excluded']) });
  assert.equal(recipients.length, 1); assert.equal(recipients[0].id_cliente, 'allowed');
});
test('diagnóstico nuevo se limita a código estable y no contiene error del proveedor', async () => {
  const f = fixture(); f.mailer.sendMail = async () => ({ sent: false, message: 'token=SYNTHETIC /private/key' });
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente', { log: { warn: (...args) => f.logs.push(args) } });
  assert.equal(f.state().current, 'fallido');
  assert.equal(f.queries.find(q => q.sql.includes('ultimo_error = $3')).params[2], 'COMM_DELIVERY_FAILED');
  assert.ok(!JSON.stringify(f.logs).includes('SYNTHETIC'));
});
test('excepción del mailer se registra como fallo seguro, sin exponer su contenido', async () => {
  const f = fixture(); f.mailer.sendMail = async () => { throw Error('smtp internal.test token=SYNTHETIC'); };
  await h.processCampaignShipmentsDelivery(f.client, f.mailer, campaign, 'pendiente');
  assert.equal(f.state().current, 'fallido'); assert.equal(f.state().attempts, 1);
  assert.equal(f.queries.find(q => q.sql.includes('ultimo_error = $3')).params[2], 'COMM_DELIVERY_FAILED');
});
test('historial identifica omisión sin confundirla con un fallo SMTP', () => {
  assert.equal(h.normalizeCommunicationSendError('COMM_OMITTED_INELIGIBLE'), 'Destinatario omitido tras verificar su elegibilidad actual.');
});
test('la misma política verifica persona, cliente, términos y consentimiento actuales', () => {
  const sql = h.buildEligibilityEvaluationCte({ hasClientAceptaTerminosAt: true });
  for (const expression of [/p\.deleted_at IS NULL/, /c\.deleted_at IS NULL/, /bc\.cliente_activo, FALSE/, /bc\.acepta_terminos_at IS NOT NULL/, /bc\.consentimiento_marketing, FALSE/, /cr\.deleted_at IS NULL/, /cr\.es_principal DESC/]) assert.match(sql, expression);
});
