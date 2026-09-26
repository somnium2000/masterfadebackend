import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import publicPagosRoutes, {
  buildSafeProviderErrorDiagnostic,
  buildSafePixelPaySdkDiagnostics,
  buildProviderOrderReference,
  classifyPixelPayStatusResult,
  assertPixelPayUuidMatches,
  isPixelPayPaidStatus,
  resolveStoredPixelPayUuid,
  resolveTrustedPixelPayReferences,
} from "../src/routes/v1/public/pagos.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";
import { TodoPagoPreprodSimulatedProvider } from "../src/services/payments/TodoPagoPreprodSimulatedProvider.js";

const GROUP_A = "11111111-2222-4333-8444-555555555555";
const CITA_A = "66666666-6666-4666-8666-666666666666";
const HOLD_A = "77777777-7777-4777-8777-777777777777";
const CITA_B = "67676767-6767-4767-8767-676767676767";
const HOLD_B = "78787878-7878-4787-8787-787878787878";
const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DETAIL_A = "12121212-1212-4121-8121-121212121212";
const PROVIDER_A = "22222222-2222-4222-8222-222222222222";
const USER_A = "88888888-8888-4888-8888-888888888888";
const INTENT_A = "99999999-9999-4999-8999-999999999999";
const PROMO_A = "13131313-1313-4131-8131-131313131313";
const PROMO_RULE_A = "14141414-1414-4141-8141-141414141414";

function pixelPaySalePayload() {
  return {
    id_grupo_cita: GROUP_A,
    id_intent: INTENT_A,
    titular_email: "cliente@example.com",
    card_number: "4111111111111111",
    card_holder: "CLIENTE PRUEBA",
    card_expire: "2807",
    card_cvv: "999",
    billing_country: "HN",
    billing_state: "HN-CR",
    billing_city: "San Pedro Sula",
    billing_address: "Calle QA",
    billing_phone: "99999999",
  };
}

for (const [name, status, expected] of [
  ["request rechazado con UNKNOWN", { ok: false, success: false, status: "UNKNOWN" }, "error_proveedor"],
  ["request rechazado sin status", { ok: false, success: false, status: "" }, "error_proveedor"],
  ["respuesta exitosa con UNKNOWN", { ok: true, success: true, status: "UNKNOWN" }, "respuesta_invalida"],
  ["respuesta exitosa sin status", { ok: true, success: true, status: "" }, "respuesta_invalida"],
  ["respuesta exitosa PENDING", { ok: true, success: true, status: "PENDING" }, "ok"],
  ["respuesta exitosa PAID", { ok: true, success: true, status: "PAID" }, "ok"],
]) {
  test(`clasificacion status PixelPay: ${name}`, () => {
    assert.equal(classifyPixelPayStatusResult(status), expected);
  });
}

test("solo PAID exacto se clasifica como pago confirmado", () => {
  assert.equal(isPixelPayPaidStatus("PAID"), true);
  assert.equal(isPixelPayPaidStatus("paid"), true);
  assert.equal(isPixelPayPaidStatus("UNPAID"), false);
  assert.equal(isPixelPayPaidStatus("PAID_PENDING"), false);
  assert.equal(isPixelPayPaidStatus("APPROVED"), false);
});

test("payment_uuid persistido se valida de forma estricta", () => {
  const intent = { provider_session_id: "P-UUID-A", referencia_externa: "TX-A" };
  assert.equal(resolveStoredPixelPayUuid(intent), "P-UUID-A");
  assert.equal(resolveStoredPixelPayUuid({
    provider_session_id: null,
    referencia_externa: "TX-123456",
  }), null);
  assert.equal(assertPixelPayUuidMatches(intent, "P-UUID-A"), "P-UUID-A");
  assert.throws(
    () => assertPixelPayUuidMatches(intent, "P-UUID-B"),
    (error) => error?.code === "PIXELPAY_PAYMENT_UUID_MISMATCH"
  );
});

test("solo persiste referencias de una respuesta Sale con hash y monto validados", () => {
  assert.deepEqual(resolveTrustedPixelPayReferences({
    paymentHashValid: true,
    amountMatches: true,
    paymentUuid: "P-UUID-A",
    transactionId: "TX-A",
  }), { paymentUuid: "P-UUID-A", transactionId: "TX-A" });
  assert.deepEqual(resolveTrustedPixelPayReferences({
    paymentHashValid: false,
    amountMatches: true,
    paymentUuid: "P-UUID-A",
    transactionId: "TX-A",
  }), { paymentUuid: null, transactionId: null });
});

test("diagnostico de proveedor solo expone metadata permitida", () => {
  const error = Object.assign(new Error("PAN 4111111111111111 CVV 999 secret"), {
    code: "PIXELPAY_RESPONSE_INVALID",
    uncertain: true,
    statusCode: 200,
    upstreamContentType: "text/html; charset=utf-8\r\nx-secret: hidden",
    upstreamContentLength: 321,
    body: "4111111111111111",
    headers: { "x-client-signature": "private" },
  });
  const diagnostic = buildSafeProviderErrorDiagnostic(error, "req-qa");
  assert.deepEqual(diagnostic, {
    requestId: "req-qa",
    errorCode: "PIXELPAY_RESPONSE_INVALID",
    errorName: "Error",
    sdkErrorName: null,
    upstreamStatusCode: 200,
    upstreamContentType: "text/html; charset=utf-8 x-secret: hidden",
    upstreamContentLength: 321,
    uncertain: true,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /4111111111111111|999|x-client-signature|private/i);
});

test("diagnostico SDK de ruta aplica lista blanca estricta", () => {
  const diagnostic = buildSafePixelPaySdkDiagnostics({
    sdkResponseClass: "SuccessResponse",
    statusCode: 200,
    responseSuccess: true,
    transactionResultValid: true,
    transactionResultDataPresent: true,
    transactionResultParsed: false,
    responseApproved: null,
    responseIncomplete: null,
    responseCodePresent: false,
    hasPaymentUuid: false,
    hasTransactionId: false,
    hasPaymentHash: false,
    paymentHashValid: false,
    transactionAmountPresent: false,
    approvedAmountPresent: false,
    transactionAmountMatches: false,
    approvedAmountMatches: false,
    amountMatches: false,
    outcome: "uncertain",
    payment_uuid: "must-not-appear",
    response: { data: { card: "must-not-appear" } },
  });

  assert.equal(diagnostic.sdkResponseClass, "SuccessResponse");
  assert.equal(diagnostic.transactionResultParsed, false);
  assert.equal(diagnostic.outcome, "uncertain");
  assert.equal(Object.hasOwn(diagnostic, "payment_uuid"), false);
  assert.equal(Object.hasOwn(diagnostic, "response"), false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /must-not-appear/);
});

function makeGroupRow({
  ownerEmail = "cliente@example.com",
  expiresAt = "2099-01-01T16:00:00.000Z",
  idCita = CITA_A,
  idHold = HOLD_A,
  order = 1,
  holdState = "activo",
  citaState = "en_espera",
} = {}) {
  return {
    id_grupo_cita: GROUP_A,
    estado_grupo_codigo: "activo",
    id_cliente_titular: null,
    id_persona_titular: USER_A,
    id_cita: idCita,
    orden_integrante: order,
    estado_cita_codigo: citaState,
    total_pagar_hnl: "115.00",
    id_hold: idHold,
    estado_hold_codigo: holdState,
    expires_at: expiresAt,
    direccion_correo: ownerEmail,
    titular_nombres: "Ada",
    titular_apellidos: "Lovelace",
  };
}

function createPagosClient({
  existingIntent = null,
  persistedPromotion = false,
  failProviderUpdate = false,
  throwProviderUpdate = false,
  throwPixelPayReferenceUpdate = false,
  ownerEmail = "cliente@example.com",
  holdExpiresAt = "2099-01-01T16:00:00.000Z",
  groupSize = 1,
  secondHoldExpiresAt = "2099-01-01T17:00:00.000Z",
  secondHoldState = "activo",
  providerCode = "mock",
  groupCitaState = "en_espera",
  groupHoldState = "activo",
} = {}) {
  const calls = [];
  const statusChecks = [];
  const payments = [];
  let activeIntent = existingIntent ? { ...existingIntent } : null;
  const groupState = [
    makeGroupRow({
      ownerEmail,
      expiresAt: holdExpiresAt,
      citaState: groupCitaState,
      holdState: groupHoldState,
    }),
    ...(groupSize === 2
      ? [makeGroupRow({
          ownerEmail,
          expiresAt: secondHoldExpiresAt,
          idCita: CITA_B,
          idHold: HOLD_B,
          order: 2,
          holdState: secondHoldState,
        })]
      : []),
  ];
  const client = {
    calls,
    setSecondHold({ expiresAt, state } = {}) {
      const second = groupState.find((row) => row.id_cita === CITA_B);
      if (!second) return;
      if (expiresAt !== undefined) second.expires_at = expiresAt;
      if (state !== undefined) second.estado_hold_codigo = state;
    },
    getActiveIntent() {
      return activeIntent ? structuredClone(activeIntent) : null;
    },
    getStatusChecks() {
      return structuredClone(statusChecks);
    },
    getPayments() {
      return structuredClone(payments);
    },
    getGroupState() {
      return structuredClone(groupState);
    },
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM public.citas_grupos cg") && text.includes("co.direccion_correo")) {
        return { rows: structuredClone(groupState) };
      }
      if (text.includes("FROM public.citas c") && text.includes("COALESCE(c.subtotal_servicios_hnl")) {
        return {
          rows: [{
            id_cita: CITA_A,
            id_grupo_cita: GROUP_A,
            id_sucursal: BRANCH_A,
            id_empleado_barbero: BARBER_A,
            inicio_at: "2026-07-15T15:00:00.000Z",
            selection_type: "services",
            id_paquete: null,
            subtotal_servicios_hnl: "100.00",
          }],
        };
      }
      if (text.includes("FROM public.citas_detalles") && text.includes("WHERE id_cita = $1::uuid")) {
        return {
          rows: [{
            id_cita_detalle: DETAIL_A,
            id_servicio: SERVICE_A,
            cantidad: 1,
            precio_unitario_hnl: "100.00",
            subtotal_hnl: "100.00",
            descuento_hnl: "0.00",
            incluye_isv_snapshot: false,
            isv_porcentaje: "15.00",
            isv_hnl: "15.00",
            total_linea_hnl: "115.00",
          }],
        };
      }
      if (text.includes("FROM public.citas_promociones") && text.includes("estado_aplicacion_codigo = 'aplicada'")) {
        if (!persistedPromotion) return { rows: [] };
        return {
          rows: [{
            id_cita_promocion: "15151515-1515-4151-8151-151515151515",
            id_grupo_cita: GROUP_A,
            id_cita: CITA_A,
            id_cita_detalle: DETAIL_A,
            id_cita_paquete: null,
            id_promocion: PROMO_A,
            id_promocion_regla: PROMO_RULE_A,
            aplica_a_codigo: "servicio",
            descuento_calculado_hnl: "10.00",
            prioridad_aplicacion: 10,
            es_acumulable: true,
            estado_aplicacion_codigo: "aplicada",
          }],
        };
      }
      if (text.includes("FROM public.promociones_reglas_agendamiento")) {
        throw new Error("promotion engine unavailable");
      }
      if (text.includes("UPDATE public.citas_detalles")) return { rows: [] };
      if (text.includes("UPDATE public.citas") && text.includes("total_pagar_hnl")) return { rows: [] };
      if (text.includes("FROM public.usuarios u")) return { rows: [{ id_usuario: USER_A }] };
      if (text.includes("FROM public.payment_providers")) {
        return { rows: [{ id_provider: PROVIDER_A, codigo: providerCode, nombre: providerCode, activo: true }] };
      }
      if (text.includes("FROM public.payment_intents pi") && text.includes("JOIN public.payment_providers pp")) {
        if (text.includes("FOR UPDATE OF pi")) {
          return { rows: activeIntent ? [{ ...activeIntent, provider_code: providerCode }] : [] };
        }
        return {
          rows: activeIntent ? [{
            ...activeIntent,
            provider_code: providerCode,
            intent_group_id: GROUP_A,
            anchor_estado_cita_codigo: groupState[0].estado_cita_codigo,
            intent_hold_group_id: GROUP_A,
            intent_hold_estado_codigo: groupState[0].estado_hold_codigo,
            intent_hold_expires_at: groupState[0].expires_at,
          }] : [],
        };
      }
      if (text.includes("FROM public.payment_intents") && text.includes("estado_intent_codigo = ANY")) {
        return { rows: activeIntent ? [{ ...activeIntent }] : [] };
      }
      if (text.includes("INSERT INTO public.payment_intents")) {
        const idIntent = params[0];
        activeIntent = {
          id_intent: idIntent,
          id_provider: PROVIDER_A,
          id_cita: CITA_A,
          id_hold: HOLD_A,
          link_pago_url: null,
          referencia_externa: null,
          idempotency_key: params[5],
          expires_at: params[6],
          monto_hnl: "115.00",
          moneda_codigo: "HNL",
          estado_intent_codigo: "creado",
          id_grupo_cita: GROUP_A,
        };
        return {
          rows: [{ ...activeIntent }],
        };
      }
      if (text.includes("FOR UPDATE OF c") && text.includes("c.estado_cita_codigo")) {
        return {
          rows: groupState.map((row) => ({
            id_cita: row.id_cita,
            estado_cita_codigo: row.estado_cita_codigo,
          })),
        };
      }
      if (text.includes("SELECT id_cita, estado_cita_codigo FROM public.citas") && text.includes("FOR UPDATE")) {
        return {
          rows: groupState.map((row) => ({
            id_cita: row.id_cita,
            estado_cita_codigo: row.estado_cita_codigo,
          })),
        };
      }
      if (text.includes("FOR UPDATE OF h") && text.includes("h.estado_hold_codigo")) {
        return {
          rows: groupState.map((row) => ({
            id_hold: row.id_hold,
            id_cita: row.id_cita,
            estado_hold_codigo: row.estado_hold_codigo,
            expires_at: row.expires_at,
          })),
        };
      }
      if (text.includes("FOR UPDATE OF pi") && text.includes("pi.id_grupo_cita = $2::uuid")) {
        return {
          rows: activeIntent ? [{
            id_intent: activeIntent.id_intent,
            estado_intent_codigo: activeIntent.estado_intent_codigo,
            expires_at: activeIntent.expires_at,
          }] : [],
        };
      }
      if (text.includes("SELECT id_intent, estado_intent_codigo, expires_at FROM public.payment_intents")
        && text.includes("FOR UPDATE")) {
        return {
          rows: activeIntent ? [{
            id_intent: activeIntent.id_intent,
            estado_intent_codigo: activeIntent.estado_intent_codigo,
            expires_at: activeIntent.expires_at,
          }] : [],
        };
      }
      if (text.includes("UPDATE public.payment_intents") && text.includes("link_pago_url = $2::text")) {
        if (throwProviderUpdate) throw new Error("database update failed");
        if (failProviderUpdate) return { rows: [] };
        activeIntent = {
          ...activeIntent,
          link_pago_url: params[1],
          referencia_externa: params[2],
          orden_compra: params[3],
          provider_session_id: params[2],
          launch_expires_at: params[4],
          estado_intent_codigo: "link_generado",
        };
        return {
          rows: [{
            ...activeIntent,
          }],
        };
      }
      if (text.includes("UPDATE public.payment_intents") && text.includes("orden_compra = $2::text")) {
        if (!activeIntent || activeIntent.estado_intent_codigo !== "creado") return { rows: [] };
        activeIntent = {
          ...activeIntent,
          orden_compra: params[1],
          estado_intent_codigo: "link_generado",
        };
        return { rows: [{ ...activeIntent }] };
      }
      if (text.includes("UPDATE public.payment_intents")
        && text.includes("estado_intent_codigo = 'pendiente_confirmacion'")
        && text.includes("RETURNING id_intent")) {
        if (!activeIntent || activeIntent.estado_intent_codigo !== "link_generado") return { rows: [] };
        activeIntent = { ...activeIntent, estado_intent_codigo: "pendiente_confirmacion" };
        return { rows: [{ id_intent: activeIntent.id_intent }] };
      }
      if (text.includes("app_private.proteger_reserva_pago_v1")) {
        if (!activeIntent || activeIntent.estado_intent_codigo !== "link_generado") return { rows: [] };
        const deadlineMs = Date.now() + (5 * 60 * 1000);
        for (const row of groupState) {
          const currentExpiryMs = new Date(row.expires_at).getTime();
          row.expires_at = new Date(Math.max(currentExpiryMs, deadlineMs)).toISOString();
          row.estado_cita_codigo = "pendiente_pago";
        }
        const protectionExpiresAt = groupState
          .map((row) => row.expires_at)
          .sort()[0];
        activeIntent = {
          ...activeIntent,
          estado_intent_codigo: "pendiente_confirmacion",
          expires_at: protectionExpiresAt,
        };
        return { rows: [{ protection_expires_at: protectionExpiresAt }] };
      }
      if (text.includes("UPDATE public.payment_intents")
        && text.includes("estado_intent_codigo = $2::text")
        && text.includes("provider_session_id = COALESCE")) {
        activeIntent = {
          ...activeIntent,
          estado_intent_codigo: params[1],
          referencia_externa: params[2] || activeIntent?.referencia_externa || null,
          provider_session_id: params[3] || activeIntent?.provider_session_id || null,
        };
        return { rows: [] };
      }
      if (text.includes("UPDATE public.payment_intents")
        && text.includes("estado_intent_codigo = $2::text")
        && !text.includes("provider_session_id")) {
        activeIntent = { ...activeIntent, estado_intent_codigo: params[1] };
        return { rows: [] };
      }
      if (text.includes("UPDATE public.payment_intents")
        && text.includes("SET referencia_externa = $2::text, provider_session_id = $3::text")) {
        if (throwPixelPayReferenceUpdate) throw new Error("pixelpay reference persistence failed");
        activeIntent = {
          ...activeIntent,
          referencia_externa: params[1],
          provider_session_id: params[2],
        };
        return { rows: [] };
      }
      if (text.includes("app_private.registrar_payment_status_check_v1")) {
        statusChecks.push({
          id_intent: params[0],
          provider_reference: params[1],
          origin: params[2],
          provider_status: params[3],
          result: params[4],
          http_status: params[5],
          error_code: params[6],
          duration_ms: params[7],
          request_id: params[8],
          checked_at: params[9],
        });
        activeIntent = {
          ...activeIntent,
          verification_attempts: Number(activeIntent?.verification_attempts || 0) + 1,
          last_verified_at: params[9],
        };
        return { rows: [{ id_status_check: "abababab-abab-4bab-8bab-abababababab" }] };
      }
      if (text.includes("FROM public.payments") && text.includes("estado_pago_codigo = 'capturado'")) {
        const payment = payments.find((row) => row.id_intent === params[0]);
        if (text.includes("EXISTS")) {
          return { rows: [{
            ...activeIntent,
            id_grupo_cita: GROUP_A,
            has_captured_payment: Boolean(payment),
          }] };
        }
        return { rows: payment ? [{ ...payment }] : [] };
      }
      if (text.includes("INSERT INTO public.payments")) {
        const existing = payments.find((row) => row.provider_tx_id === params[1]);
        if (existing) return { rows: [] };
        const payment = {
          id_payment: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
          id_intent: params[0],
          estado_pago_codigo: "capturado",
          provider_tx_id: params[1],
          monto_hnl: params[2],
          moneda_codigo: "HNL",
          paid_at: params[3],
        };
        payments.push(payment);
        return { rows: [{ id_payment: payment.id_payment }] };
      }
      if (text.includes("SELECT id_intent FROM public.payments WHERE provider_tx_id")) {
        const payment = payments.find((row) => row.provider_tx_id === params[0]);
        return { rows: payment ? [{ id_intent: payment.id_intent }] : [] };
      }
      if (text.includes("UPDATE public.payment_intents") && text.includes("provider_session_id = COALESCE")) {
        activeIntent = {
          ...activeIntent,
          referencia_externa: params[1] || activeIntent?.referencia_externa || null,
          provider_session_id: params[1] || activeIntent?.provider_session_id || null,
        };
        return { rows: [] };
      }
      if (text.includes("FROM public.citas c") && text.includes("JOIN public.citas_grupos cg")) {
        return { rows: [{ id_grupo_cita: GROUP_A, id_cliente_titular: null }] };
      }
      if (text.includes("SELECT COALESCE(SUM(total_pagar_hnl),0)::numeric AS total")) {
        return { rows: [{ total: "115.00" }] };
      }
      if (text.includes("app_private.confirmar_reserva_pagada_v1")) {
        activeIntent = { ...activeIntent, estado_intent_codigo: "confirmado", paid_at: params[2] };
        for (const row of groupState) {
          row.estado_cita_codigo = "confirmada";
          row.estado_hold_codigo = "consumido";
        }
        return { rows: [{ resultado: { confirmed: true, id_grupo_cita: GROUP_A } }] };
      }
      if (text.includes("UPDATE public.citas") && text.includes("estado_cita_codigo = 'pendiente_pago'")) {
        for (const row of groupState) {
          if (row.estado_cita_codigo === "en_espera") row.estado_cita_codigo = "pendiente_pago";
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return client;
}

async function createPagosApp(client, {
  providerCode = "mock",
  providerAdapter = null,
  logs = null,
  connectFactory = null,
} = {}) {
  PaymentProviderFactory.reset();
  process.env.PAYMENT_PROVIDER = "mock";
  if (providerAdapter) PaymentProviderFactory._instance = providerAdapter;
  const app = Fastify({
    logger: logs
      ? {
          level: "trace",
          stream: { write: (message) => logs.push(message) },
        }
      : false,
  });
  app.decorate("config", { paymentProvider: providerCode });
  app.decorate("db", {
    async connect() {
      return connectFactory ? connectFactory() : client;
    },
    async query(sql, params = []) {
      return client.query(sql, params);
    },
  });
  await app.register(publicPagosRoutes, { prefix: "/v1/public/pagos" });
  return app;
}

function createSerializedTransactionClients(baseClient) {
  let tail = Promise.resolve();
  return () => {
    let releaseLock = null;
    return {
      async query(sql, params = []) {
        const text = String(sql);
        if (text.includes("pg_advisory_xact_lock") && !releaseLock) {
          const previous = tail;
          tail = new Promise((resolve) => { releaseLock = resolve; });
          await previous;
        }
        try {
          return await baseClient.query(sql, params);
        } finally {
          if ((text === "COMMIT" || text === "ROLLBACK") && releaseLock) {
            const release = releaseLock;
            releaseLock = null;
            release();
          }
        }
      },
      release() {
        if (releaseLock) {
          const release = releaseLock;
          releaseLock = null;
          release();
        }
      },
    };
  };
}

function createIframeProvider({ failure = null, onCreateIntent = null } = {}) {
  const calls = [];
  const cancelCalls = [];
  return {
    calls,
    cancelCalls,
    async createIntent(input) {
      calls.push(input);
      if (failure) throw failure;
      if (onCreateIntent) await onCreateIntent(input);
      return {
        providerIntentId: "todopago-session-001",
        paymentUrl: null,
        launch: {
          type: "iframe_post",
          action: "https://modal.example.test/checkout",
          method: "POST",
          fields: {
            tokenTodomovil: "private-launch-token",
            idTransaccion: "todopago-session-001",
            amount: "115.00",
            customerName: input.metadata.customerName,
            ordenDeCompra: input.metadata.ordenDeCompra,
            currencyCode: input.moneda,
            encrypted: "private-encrypted-payload",
          },
          allowedMessageOrigin: "https://modal.example.test",
          expiresAt: input.metadata.expiresAt,
        },
        raw: {
          token: "private-raw-token",
          encrypted: "private-raw-encrypted",
        },
      };
    },
    async cancelIntent(providerIntentId) {
      cancelCalls.push(providerIntentId);
    },
  };
}

function publicIntentPayload(overrides = {}) {
  return {
    id_grupo_cita: GROUP_A,
    titular_email: "cliente@example.com",
    nombre_apellido: "Nombre suministrado por cliente",
    ...overrides,
  };
}

test("ordenDeCompra es deterministica, unica por provider e intent y no contiene PII", () => {
  const first = buildProviderOrderReference({
    providerCode: "todopago",
    idIntent: INTENT_A,
  });
  const repeated = buildProviderOrderReference({
    providerCode: "todopago",
    idIntent: INTENT_A,
  });
  const anotherProvider = buildProviderOrderReference({
    providerCode: "mock",
    idIntent: INTENT_A,
  });

  assert.equal(first, repeated);
  assert.notEqual(first, anotherProvider);
  assert.equal(first.includes("cliente@example.com"), false);
  assert.equal(first.includes("Ada"), false);
  assert.match(first, /^MF-TODOPAGO-[0-9A-F]{32}$/);
});

test("iframe_post persiste solo metadatos seguros y devuelve launch una sola vez", async () => {
  const logs = [];
  const provider = createIframeProvider();
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
    logs,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    headers: { "x-forwarded-for": "203.0.113.99" },
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.data.payment_url, null);
  assert.equal(body.data.launch.type, "iframe_post");
  assert.equal(body.data.launch.fields.tokenTodomovil, "private-launch-token");
  assert.equal(body.data.launch.fields.encrypted, "private-encrypted-payload");
  assert.equal(provider.calls.length, 1);

  const intentInsert = client.calls.find((call) => call.sql.includes("INSERT INTO public.payment_intents"));
  const providerInput = provider.calls[0];
  const expectedOrder = buildProviderOrderReference({
    providerCode: "todopago",
    idIntent: intentInsert.params[0],
  });
  assert.equal(providerInput.idempotencyKey, intentInsert.params[5]);
  assert.equal(providerInput.montoHnl, 115);
  assert.equal(providerInput.moneda, "HNL");
  assert.equal(providerInput.metadata.customerName, "Ada Lovelace");
  assert.equal(providerInput.metadata.clientIp, "127.0.0.1");
  assert.notEqual(providerInput.metadata.clientIp, "203.0.113.99");
  assert.equal(providerInput.metadata.ordenDeCompra, expectedOrder);
  assert.equal(providerInput.metadata.expiresAt, "2099-01-01T16:00:00.000Z");

  const providerUpdate = client.calls.find((call) =>
    call.sql.includes("UPDATE public.payment_intents")
    && call.sql.includes("provider_session_id = $3::text")
  );
  assert.ok(providerUpdate);
  assert.deepEqual(providerUpdate.params, [
    intentInsert.params[0],
    null,
    "todopago-session-001",
    expectedOrder,
    "2099-01-01T16:00:00.000Z",
    GROUP_A,
  ]);
  assert.equal(providerUpdate.sql.includes("launch.fields"), false);
  assert.equal(providerUpdate.sql.includes("tokenTodomovil"), false);
  assert.equal(providerUpdate.sql.includes("encrypted"), false);

  const persistedDiagnostics = JSON.stringify(client.calls);
  assert.equal(persistedDiagnostics.includes("private-launch-token"), false);
  assert.equal(persistedDiagnostics.includes("private-encrypted-payload"), false);
  assert.equal(logs.join("").includes("private-launch-token"), false);
  assert.equal(logs.join("").includes("private-encrypted-payload"), false);

  const responseWithoutLaunch = structuredClone(body);
  delete responseWithoutLaunch.data.launch;
  const additionalResponse = JSON.stringify(responseWithoutLaunch);
  assert.equal(additionalResponse.includes("private-launch-token"), false);
  assert.equal(additionalResponse.includes("private-encrypted-payload"), false);
  assert.equal(client.calls.some((call) =>
    call.sql.includes("SET estado_cita_codigo = 'confirmada'")
  ), false);
  assert.equal(client.calls.some((call) => call.sql.includes("INSERT INTO public.payments")), false);

  await app.close();
});

test("grupo usa el menor expires_at y solo persiste launch con ambos holds activos", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({
    providerCode: "todopago",
    groupSize: 2,
    holdExpiresAt: "2099-01-01T18:00:00.000Z",
    secondHoldExpiresAt: "2099-01-01T17:00:00.000Z",
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.launch.type, "iframe_post");
  const intentInsert = client.calls.find((call) => call.sql.includes("INSERT INTO public.payment_intents"));
  assert.equal(intentInsert.params[6], "2099-01-01T17:00:00.000Z");
  assert.equal(provider.calls[0].metadata.expiresAt, "2099-01-01T17:00:00.000Z");
  assert.equal(client.getActiveIntent().provider_session_id, "todopago-session-001");
  assert.deepEqual(
    client.getGroupState().map((row) => row.estado_cita_codigo),
    ["pendiente_pago", "pendiente_pago"]
  );
  assert.equal(client.calls.filter((call) => call.sql.includes("pg_advisory_xact_lock")).length, 2);
  assert.equal(provider.calls.length, 1);
  await app.close();
});

test("si el hold no principal vence durante el proveedor revierte y cancela sin devolver launch", async () => {
  let client;
  const provider = createIframeProvider({
    onCreateIntent() {
      client.setSecondHold({ expiresAt: "2000-01-01T00:00:00.000Z" });
    },
  });
  client = createPagosClient({
    providerCode: "todopago",
    groupSize: 2,
    holdExpiresAt: "2099-01-01T18:00:00.000Z",
    secondHoldExpiresAt: "2099-01-01T17:00:00.000Z",
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_HOLD_EXPIRED");
  assert.equal(response.body.includes("launch"), false);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.cancelCalls, ["todopago-session-001"]);
  assert.equal(client.calls.some((call) => call.sql.includes("provider_session_id = $3::text")), false);
  assert.equal(client.getActiveIntent().provider_session_id, undefined);
  assert.equal(client.getActiveIntent().orden_compra, undefined);
  assert.deepEqual(
    client.getGroupState().map((row) => row.estado_cita_codigo),
    ["en_espera", "en_espera"]
  );
  await app.close();
});

test("si el hold no principal se cancela durante el proveedor revierte y cancela una sola vez", async () => {
  let client;
  const provider = createIframeProvider({
    onCreateIntent() {
      client.setSecondHold({ state: "cancelado" });
    },
  });
  client = createPagosClient({
    providerCode: "todopago",
    groupSize: 2,
    holdExpiresAt: "2099-01-01T18:00:00.000Z",
    secondHoldExpiresAt: "2099-01-01T17:00:00.000Z",
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_HOLD_EXPIRED");
  assert.equal(response.body.includes("launch"), false);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.cancelCalls, ["todopago-session-001"]);
  assert.equal(client.calls.some((call) => call.sql.includes("provider_session_id = $3::text")), false);
  assert.equal(client.getActiveIntent().provider_session_id, undefined);
  assert.equal(client.getActiveIntent().launch_expires_at, undefined);
  assert.deepEqual(
    client.getGroupState().map((row) => row.estado_cita_codigo),
    ["en_espera", "en_espera"]
  );
  await app.close();
});

test("hold vencido no llama al proveedor", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({
    providerCode: "todopago",
    holdExpiresAt: "2000-01-01T00:00:00.000Z",
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_HOLD_EXPIRED");
  assert.equal(provider.calls.length, 0);
  await app.close();
});

test("titular sin propiedad del hold no llama al proveedor", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload({ titular_email: "intruso@example.com" }),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_GROUP_FORBIDDEN");
  assert.equal(provider.calls.length, 0);
  await app.close();
});

test("datos reservados enviados por cliente se ignoran y se derivan en backend", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      ...publicIntentPayload(),
      monto_hnl: 0.01,
      moneda_codigo: "USD",
      ordenDeCompra: "CLIENT-ORDER",
      customerName: "Cliente falso",
      clientIp: "203.0.113.20",
      expiresAt: "2099-12-31T23:59:59.000Z",
      provider_session_id: "client-session",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(provider.calls.length, 1);
  const providerInput = provider.calls[0];
  assert.equal(providerInput.montoHnl, 115);
  assert.equal(providerInput.moneda, "HNL");
  assert.equal(providerInput.metadata.customerName, "Ada Lovelace");
  assert.equal(providerInput.metadata.clientIp, "127.0.0.1");
  assert.equal(providerInput.metadata.expiresAt, "2099-01-01T16:00:00.000Z");
  assert.notEqual(providerInput.metadata.ordenDeCompra, "CLIENT-ORDER");
  await app.close();
});

test("repetir la operacion idempotente no crea otra sesion y devuelve launch null", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().data.id_intent, second.json().data.id_intent);
  assert.equal(first.json().data.launch.type, "iframe_post");
  assert.equal(second.json().data.launch, null);
  assert.equal(provider.calls.length, 1);
  assert.equal(client.calls.filter((call) => call.sql.includes("INSERT INTO public.payment_intents")).length, 1);
  await app.close();
});

test("intent existente sin launch efimero no vuelve a llamar al proveedor", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({
    providerCode: "todopago",
    existingIntent: {
      id_intent: INTENT_A,
      id_hold: HOLD_A,
      link_pago_url: null,
      referencia_externa: null,
      idempotency_key: `masterfade:booking-payment:${INTENT_A}`,
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      estado_intent_codigo: "creado",
    },
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.id_intent, INTENT_A);
  assert.equal(response.json().data.launch, null);
  assert.equal(provider.calls.length, 0);
  await app.close();
});

test("fallo del proveedor no persiste metadatos ni filtra secretos", async () => {
  const logs = [];
  const provider = createIframeProvider({
    failure: Object.assign(new Error("private-launch-token private-encrypted-payload"), {
      code: "TODOPAGO_AUTH_HTTP_ERROR",
    }),
  });
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
    logs,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_CREATE_INTENT_ERROR");
  assert.equal(provider.calls.length, 1);
  assert.equal(client.calls.some((call) => call.sql.includes("provider_session_id = $3::text")), false);
  assert.equal(response.body.includes("private-launch-token"), false);
  assert.equal(response.body.includes("private-encrypted-payload"), false);
  assert.equal(logs.join("").includes("private-launch-token"), false);
  assert.equal(logs.join("").includes("private-encrypted-payload"), false);
  await app.close();
});

test("fallo de persistencia posterior no devuelve launch", async () => {
  const logs = [];
  const provider = createIframeProvider();
  const client = createPagosClient({
    providerCode: "todopago",
    throwProviderUpdate: true,
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
    logs,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_CREATE_INTENT_ERROR");
  assert.equal(provider.calls.length, 1);
  assert.equal(response.body.includes("launch"), false);
  assert.equal(response.body.includes("private-launch-token"), false);
  assert.equal(response.body.includes("private-encrypted-payload"), false);
  assert.equal(logs.join("").includes("private-launch-token"), false);
  assert.equal(logs.join("").includes("private-encrypted-payload"), false);
  assert.equal(client.calls.filter((call) => call.sql === "COMMIT").length, 1);
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  await app.close();
});

test("preprod_simulated conserva redirect y payment_url", async () => {
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: new TodoPagoPreprodSimulatedProvider(),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.launch.type, "redirect");
  assert.equal(response.json().data.launch.method, "GET");
  assert.equal(response.json().data.payment_url, response.json().data.launch.action);
  await app.close();
});

test("ruta real POST /v1/public/pagos/crear-intent conserva snapshots y crea intent", async () => {
  const client = createPagosClient();
  const app = await createPagosApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      id_grupo_cita: GROUP_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.monto_hnl, 115);
  assert.ok(client.calls.some((call) => call.sql === "BEGIN"));
  assert.ok(client.calls.some((call) => call.sql === "COMMIT"));
  assert.ok(!client.calls.some((call) => call.sql === "ROLLBACK"));

  const detailUpdate = client.calls.find((call) => call.sql.includes("UPDATE public.citas_detalles"));
  assert.ok(detailUpdate);
  assert.equal(detailUpdate.sql.includes("incluye_isv_snapshot"), false);
  assert.equal(detailUpdate.sql.includes("isv_porcentaje"), false);
  assert.deepEqual(detailUpdate.params, [DETAIL_A, 0, 15, 115]);

  const intentInsert = client.calls.find((call) => call.sql.includes("INSERT INTO public.payment_intents"));
  assert.ok(intentInsert);
  assert.match(intentInsert.params[0], /^[0-9a-f-]{36}$/i);
  assert.equal(intentInsert.params[4], 115);
  assert.equal(intentInsert.params[5], `masterfade:booking-payment:${intentInsert.params[0]}`);
  assert.equal(intentInsert.params[8], GROUP_A);
  const providerUpdate = client.calls.find((call) =>
    call.sql.includes("UPDATE public.payment_intents")
    && call.sql.includes("link_pago_url = $2::text")
  );
  assert.ok(providerUpdate);
  assert.equal(providerUpdate.params[0], intentInsert.params[0]);
  await app.close();
});

test("crear intent PixelPay persiste orden provider-agnostic sin llamar sale", async () => {
  const provider = {
    saleCalls: 0,
    async sale() {
      this.saleCalls += 1;
      throw new Error("sale no debe ejecutarse al crear intent");
    },
  };
  const client = createPagosClient({ providerCode: "pixelpay" });
  const app = await createPagosApp(client, {
    providerCode: "pixelpay",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.estado_intent_codigo, "link_generado");
  assert.match(client.getActiveIntent().orden_compra, /^MF-PIXELPAY-[0-9A-F]{32}$/);
  assert.equal(provider.saleCalls, 0);
  await app.close();
});

test("sale guard carga intent PixelPay reclamado y no llama al proveedor", async () => {
  const provider = {
    saleCalls: 0,
    async sale() {
      this.saleCalls += 1;
      throw new Error("sale no debe ejecutarse para intent reclamado");
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      orden_compra: "MF-PIXELPAY-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, {
    providerCode: "pixelpay",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/sale",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
      card_number: "4111111111111111",
      card_holder: "CLIENTE PRUEBA",
      card_expire: "2807",
      card_cvv: "999",
      billing_country: "HN",
      billing_state: "HN-CR",
      billing_city: "San Pedro Sula",
      billing_address: "Calle QA",
      billing_phone: "99999999",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PIXELPAY_SALE_ALREADY_IN_PROGRESS");
  assert.equal(provider.saleCalls, 0);
  await app.close();
});

for (const scenario of [
  { name: "incierto", uncertain: true, expectedHttp: 202, expectedState: "pendiente_confirmacion" },
  { name: "definitivo", uncertain: false, expectedHttp: 502, expectedState: "fallido" },
]) {
  test(`sale con error de respuesta ${scenario.name} conserva la semantica y no consulta status`, async () => {
    const logs = [];
    const provider = {
      saleCalls: 0,
      statusCalls: 0,
      async sale() {
        this.saleCalls += 1;
        const error = new Error("PAN 4111111111111111 CVV 999 secret");
        Object.assign(error, {
          code: "PIXELPAY_RESPONSE_INVALID",
          uncertain: scenario.uncertain,
          statusCode: scenario.uncertain ? 200 : 422,
          upstreamContentType: "text/html",
          upstreamContentLength: 321,
        });
        throw error;
      },
      async queryPaymentStatus() {
        this.statusCalls += 1;
        throw new Error("status no debe ejecutarse");
      },
    };
    const client = createPagosClient({
      providerCode: "pixelpay",
      existingIntent: {
        id_intent: INTENT_A,
        id_provider: PROVIDER_A,
        id_cita: CITA_A,
        id_hold: HOLD_A,
        id_grupo_cita: GROUP_A,
        estado_intent_codigo: "link_generado",
        expires_at: "2099-01-01T16:00:00.000Z",
        monto_hnl: "115.00",
        moneda_codigo: "HNL",
        orden_compra: "MF-PIXELPAY-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        created_by_usuario_id: USER_A,
      },
    });
    const app = await createPagosApp(client, {
      providerCode: "pixelpay",
      providerAdapter: provider,
      logs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/public/pagos/pixelpay/sale",
      payload: {
        id_grupo_cita: GROUP_A,
        id_intent: INTENT_A,
        titular_email: "cliente@example.com",
        card_number: "4111111111111111",
        card_holder: "CLIENTE PRUEBA",
        card_expire: "2807",
        card_cvv: "999",
        billing_country: "HN",
        billing_state: "HN-CR",
        billing_city: "San Pedro Sula",
        billing_address: "Calle QA",
        billing_phone: "99999999",
      },
    });

    assert.equal(response.statusCode, scenario.expectedHttp, response.body);
    if (!scenario.uncertain) {
      assert.equal(response.json().error.code, "PIXELPAY_REQUEST_REJECTED");
    }
    assert.equal(client.getActiveIntent().estado_intent_codigo, scenario.expectedState);
    assert.equal(provider.saleCalls, 1);
    assert.equal(provider.statusCalls, 0);
    assert.equal(client.getStatusChecks().length, 0);
    assert.doesNotMatch(logs.join(""), /4111111111111111|CVV 999|secret/i);
    await app.close();
  });
}

test("sale SDK no aprobada registra diagnostico seguro una vez y no lo devuelve", async () => {
  const logs = [];
  const provider = {
    saleCalls: 0,
    async sale() {
      this.saleCalls += 1;
      return {
        outcome: "uncertain",
        paymentUuid: null,
        transactionId: null,
        paymentHashValid: false,
        amountMatches: false,
        diagnostics: {
          sdkResponseClass: "SuccessResponse",
          statusCode: 200,
          responseSuccess: true,
          safeMessageCode: "SDK_PUBLIC_KEY_UNAVAILABLE",
          transactionResultValid: false,
          transactionResultDataPresent: true,
          transactionResultParsed: false,
          responseApproved: null,
          responseIncomplete: null,
          responseCodePresent: false,
          hasPaymentUuid: false,
          hasTransactionId: false,
          hasPaymentHash: false,
          paymentHashValid: false,
          transactionAmountPresent: false,
          approvedAmountPresent: false,
          transactionAmountMatches: false,
          approvedAmountMatches: false,
          amountMatches: false,
          outcome: "uncertain",
          payment_uuid: "sensitive-payment-uuid",
          transaction_id: "sensitive-transaction-id",
          payment_hash: "sensitive-payment-hash",
          response: { data: { card_number: "sensitive-pan" } },
        },
      };
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "link_generado",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      orden_compra: "MF-PIXELPAY-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, {
    providerCode: "pixelpay",
    providerAdapter: provider,
    logs,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/sale",
    payload: pixelPaySalePayload(),
  });

  const payload = response.json();
  const diagnosticLogs = logs
    .map((entry) => JSON.parse(entry))
    .filter((entry) => entry.msg === "Resultado PixelPay SDK no aprobado");
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(provider.saleCalls, 1);
  assert.equal(diagnosticLogs.length, 1);
  assert.equal(diagnosticLogs[0].id_intent, INTENT_A);
  assert.equal(diagnosticLogs[0].pixelPaySdkDiagnostics.transactionResultValid, false);
  assert.equal(diagnosticLogs[0].pixelPaySdkDiagnostics.outcome, "uncertain");
  assert.equal(diagnosticLogs[0].pixelPaySdkDiagnostics.safeMessageCode, "SDK_PUBLIC_KEY_UNAVAILABLE");
  assert.equal(Object.hasOwn(payload.data, "diagnostics"), false);
  assert.doesNotMatch(response.body, /sdkResponseClass|transactionResultValid|safeMessageCode|sensitive-/i);
  assert.doesNotMatch(logs.join(""), /sensitive-payment|sensitive-transaction|sensitive-pan/i);
  await app.close();
});

test("al iniciar sale protege transaccionalmente el slot durante aproximadamente cinco minutos", async () => {
  const provider = {
    saleCalls: 0,
    async sale() {
      this.saleCalls += 1;
      const error = new Error("respuesta incierta");
      error.uncertain = true;
      error.code = "PIXELPAY_TIMEOUT";
      throw error;
    },
  };
  const initialExpiry = new Date(Date.now() + 30_000).toISOString();
  const client = createPagosClient({
    providerCode: "pixelpay",
    holdExpiresAt: initialExpiry,
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "link_generado",
      expires_at: initialExpiry,
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      orden_compra: "MF-PIXELPAY-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });
  const startedAt = Date.now();

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/sale",
    payload: pixelPaySalePayload(),
  });

  const protectionMs = new Date(client.getGroupState()[0].expires_at).getTime() - startedAt;
  assert.equal(response.statusCode, 202, response.body);
  assert.ok(protectionMs >= 295_000 && protectionMs <= 305_000, `proteccion=${protectionMs}ms`);
  assert.equal(client.getActiveIntent().expires_at, client.getGroupState()[0].expires_at);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
  assert.equal(provider.saleCalls, 1);
  await app.close();
});

test("APPROVED seguido de falla DB conserva order_id y nunca repite sale", async () => {
  const provider = {
    saleCalls: 0,
    async sale() {
      this.saleCalls += 1;
      return {
        outcome: "approved",
        paymentUuid: "P-UUID-APPROVED",
        transactionId: "TX-APPROVED",
        paymentHashValid: true,
        amountMatches: true,
      };
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    throwPixelPayReferenceUpdate: true,
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "link_generado",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      orden_compra: "MF-PIXELPAY-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/sale",
    payload: pixelPaySalePayload(),
  });

  assert.equal(response.statusCode, 500, response.body);
  assert.equal(provider.saleCalls, 1);
  assert.equal(client.getPayments().length, 0);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
  assert.equal(client.getActiveIntent().orden_compra, "MF-PIXELPAY-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(client.getActiveIntent().provider_session_id || null, null);
  await app.close();
});

test("status carga intent PixelPay y registra una verificacion con proveedor simulado", async () => {
  const provider = {
    statusCalls: [],
    async queryPaymentStatus(paymentUuid) {
      this.statusCalls.push(paymentUuid);
      return { ok: true, success: true, statusCode: 200, status: "pending", paymentUuid };
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: "payment-uuid-qa",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, {
    providerCode: "pixelpay",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/status",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.provider_status, "pending");
  assert.deepEqual(provider.statusCalls, ["payment-uuid-qa"]);
  assert.equal(client.getActiveIntent().verification_attempts, 1);
  assert.equal(client.getStatusChecks().length, 1);
  assert.equal(client.getStatusChecks()[0].origin, "manual");
  assert.equal(client.getStatusChecks()[0].result, "ok");
  assert.equal(client.getStatusChecks()[0].provider_status, "pending");
  assert.equal(client.getStatusChecks()[0].http_status, 200);
  assert.ok(!client.calls.some((call) => call.sql.includes("SET last_verified_at = now()")));
  await app.close();
});

test("status sin payment_uuid no llama proveedor ni registra telemetria", async () => {
  const provider = {
    statusCalls: 0,
    async queryPaymentStatus() {
      this.statusCalls += 1;
      throw new Error("no debe ejecutarse");
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: null,
      referencia_externa: "TX-123456",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/status",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PIXELPAY_PAYMENT_UUID_MISSING");
  assert.equal(provider.statusCalls, 0);
  assert.equal(client.getStatusChecks().length, 0);
  assert.equal(client.getActiveIntent().verification_attempts || 0, 0);
  assert.equal(client.getPayments().length, 0);
  await app.close();
});

test("status rechaza payment_uuid diferente al persistido", async () => {
  const provider = {
    statusCalls: [],
    async queryPaymentStatus(paymentUuid) {
      this.statusCalls.push(paymentUuid);
      return {
        ok: true,
        success: true,
        statusCode: 200,
        status: "PAID",
        paymentUuid: "payment-uuid-diferente",
      };
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: "payment-uuid-persistido",
      referencia_externa: "TX-PERSISTIDA",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/status",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "PIXELPAY_PAYMENT_UUID_MISMATCH");
  assert.deepEqual(provider.statusCalls, ["payment-uuid-persistido"]);
  assert.equal(client.getPayments().length, 0);
  await app.close();
});

test("status PAID reconcilia una sola vez y repetido no duplica payment", async () => {
  const provider = {
    statusCalls: 0,
    async queryPaymentStatus(paymentUuid) {
      this.statusCalls += 1;
      return { ok: true, success: true, statusCode: 200, status: "PAID", paymentUuid };
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: "payment-uuid-paid-qa",
      referencia_externa: "transaction-id-paid-qa",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });
  const request = {
    method: "POST",
    url: "/v1/public/pagos/pixelpay/status",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  };

  const first = await app.inject(request);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.provider_status, "PAID");
  assert.equal(first.json().data.booking_confirmed, true);
  assert.equal(client.getPayments().length, 1);
  assert.equal(client.getPayments()[0].provider_tx_id, "transaction-id-paid-qa");
  assert.equal(client.getActiveIntent().estado_intent_codigo, "confirmado");
  const sideEffectsAfterFirst = {
    promotions: client.calls.filter((call) => /promociones_usos|citas_promociones/i.test(call.sql)).length,
    emails: client.calls.filter((call) => /notificaciones_email/i.test(call.sql)).length,
    points: client.calls.filter((call) => /puntos|points/i.test(call.sql)).length,
  };

  const second = await app.inject(request);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().data.duplicate, true);
  assert.equal(client.getPayments().length, 1);
  assert.equal(provider.statusCalls, 2);
  assert.equal(client.getStatusChecks().length, 2);
  assert.equal(client.calls.filter((call) => call.sql.includes("app_private.confirmar_reserva_pagada_v1")).length, 1);
  assert.deepEqual({
    promotions: client.calls.filter((call) => /promociones_usos|citas_promociones/i.test(call.sql)).length,
    emails: client.calls.filter((call) => /notificaciones_email/i.test(call.sql)).length,
    points: client.calls.filter((call) => /puntos|points/i.test(call.sql)).length,
  }, sideEffectsAfterFirst);
  await app.close();
});

test("dos Status PAID concurrentes producen un payment y una confirmacion efectiva", async () => {
  const provider = {
    statusCalls: 0,
    async queryPaymentStatus(paymentUuid) {
      this.statusCalls += 1;
      return { ok: true, success: true, statusCode: 200, status: "PAID", paymentUuid };
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: "payment-uuid-concurrent-qa",
      referencia_externa: "transaction-id-concurrent-qa",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, {
    providerCode: "pixelpay",
    providerAdapter: provider,
    connectFactory: createSerializedTransactionClients(client),
  });
  const request = {
    method: "POST",
    url: "/v1/public/pagos/pixelpay/status",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  };

  const [first, second] = await Promise.all([app.inject(request), app.inject(request)]);

  assert.deepEqual([first.statusCode, second.statusCode], [200, 200]);
  assert.equal(provider.statusCalls, 2);
  assert.equal(client.getStatusChecks().length, 2);
  assert.equal(client.getPayments().length, 1);
  assert.equal(client.getPayments()[0].provider_tx_id, "transaction-id-concurrent-qa");
  assert.equal(client.calls.filter((call) => call.sql.includes("app_private.confirmar_reserva_pagada_v1")).length, 1);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "confirmado");
  await app.close();
});

test("GET estado conserva pendiente_confirmacion despues de liberar el slot", async () => {
  const client = createPagosClient({
    providerCode: "pixelpay",
    holdExpiresAt: "2020-01-01T00:00:00.000Z",
    groupCitaState: "expirada",
    groupHoldState: "expirado",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2020-01-01T00:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: "payment-uuid-pending-qa",
      referencia_externa: "transaction-id-pending-qa",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay" });

  const response = await app.inject({
    method: "GET",
    url: `/v1/public/pagos/estado?id_grupo_cita=${GROUP_A}&id_intent=${INTENT_A}&titular_email=cliente%40example.com`,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.estado_intent_codigo, "pendiente_confirmacion");
  assert.equal(response.json().data.booking_confirmed, false);
  await app.close();
});

test("status PAID posterior al vencimiento queda en conciliacion manual", async () => {
  const provider = {
    statusCalls: 0,
    async queryPaymentStatus(paymentUuid) {
      this.statusCalls += 1;
      return { ok: true, success: true, statusCode: 200, status: "PAID", paymentUuid };
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    holdExpiresAt: "2020-01-01T00:00:00.000Z",
    groupCitaState: "expirada",
    groupHoldState: "expirado",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2020-01-01T00:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: "payment-uuid-expired-qa",
      referencia_externa: "transaction-id-expired-qa",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/status",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().data.provider_status, "PAID");
  assert.equal(response.json().data.manual_reconciliation_required, true);
  assert.equal(response.json().data.booking_confirmed, false);
  assert.equal(client.getPayments().length, 0);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
  assert.equal(client.getGroupState()[0].estado_cita_codigo, "expirada");
  assert.equal(client.getGroupState()[0].estado_hold_codigo, "expirado");
  assert.equal(provider.statusCalls, 1);
  await app.close();
});

test("status PAID sin transaction_id estable queda en conciliacion manual", async () => {
  const provider = {
    async queryPaymentStatus(paymentUuid) {
      return { ok: true, success: true, statusCode: 200, status: "PAID", paymentUuid };
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: "payment-uuid-without-transaction",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/status",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().data.manual_reconciliation_required, true);
  assert.equal(client.getPayments().length, 0);
  await app.close();
});

test("status registra error tecnico sanitizado sin persistir secretos", async () => {
  const provider = {
    async queryPaymentStatus() {
      const error = new Error("mensaje con PAN 4111111111111111 y secreto");
      error.code = "PIXELPAY_TIMEOUT";
      error.statusCode = 504;
      throw error;
    },
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A,
      id_provider: PROVIDER_A,
      id_cita: CITA_A,
      id_hold: HOLD_A,
      id_grupo_cita: GROUP_A,
      estado_intent_codigo: "pendiente_confirmacion",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      provider_session_id: "payment-uuid-qa",
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/status",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 502);
  assert.equal(client.getStatusChecks().length, 1);
  assert.deepEqual(
    {
      origin: client.getStatusChecks()[0].origin,
      result: client.getStatusChecks()[0].result,
      error_code: client.getStatusChecks()[0].error_code,
      http_status: client.getStatusChecks()[0].http_status,
    },
    { origin: "manual", result: "timeout", error_code: "PIXELPAY_TIMEOUT", http_status: 504 }
  );
  assert.doesNotMatch(JSON.stringify(client.getStatusChecks()), /4111111111111111|secreto/i);
  assert.equal(client.getActiveIntent().verification_attempts, 1);
  await app.close();
});

test("ruta real POST /v1/public/pagos/crear-intent retorna intent existente idempotente", async () => {
  const client = createPagosClient({
    existingIntent: {
      id_intent: INTENT_A,
      id_hold: HOLD_A,
      link_pago_url: "http://localhost:5173/pago",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      estado_intent_codigo: "link_generado",
    },
  });
  const app = await createPagosApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      id_grupo_cita: GROUP_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.id_intent, INTENT_A);
  assert.ok(!client.calls.some((call) => call.sql.includes("INSERT INTO public.payment_intents")));
  assert.ok(client.calls.some((call) => call.sql === "COMMIT"));
  await app.close();
});

test("ruta real POST /v1/public/pagos/crear-intent hace rollback si no puede validar promocion persistida", async () => {
  const client = createPagosClient({ persistedPromotion: true });
  const app = await createPagosApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      id_grupo_cita: GROUP_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "BOOKING_PROMOTION_VALIDATION_UNAVAILABLE");
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  assert.ok(!client.calls.some((call) => call.sql === "COMMIT"));
  assert.ok(!client.calls.some((call) => call.sql.includes("INSERT INTO public.payment_intents")));
  await app.close();
});

test("ruta real POST /v1/public/pagos/crear-intent conserva intent local si falla update post proveedor", async () => {
  const client = createPagosClient({ failProviderUpdate: true });
  const app = await createPagosApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      id_grupo_cita: GROUP_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_HOLD_EXPIRED");
  const intentInsert = client.calls.find((call) => call.sql.includes("INSERT INTO public.payment_intents"));
  assert.ok(intentInsert);
  const commits = client.calls.filter((call) => call.sql === "COMMIT").length;
  assert.equal(commits, 1);
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  await app.close();
});
