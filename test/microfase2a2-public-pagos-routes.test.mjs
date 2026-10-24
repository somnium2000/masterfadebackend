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
  reconcilePixelPayPaid,
  reconcilePixelPayFromDurableApproval,
  resolveStoredPixelPayUuid,
  resolveTrustedPixelPayReferences,
} from "../src/routes/v1/public/pagos.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";
import { TodoPagoPreprodSimulatedProvider } from "../src/services/payments/TodoPagoPreprodSimulatedProvider.js";
import { PIXELPAY_SALE_FINAL_QUERY_TIMEOUT_MS } from "../src/services/payments/pixelPaySaleAttemptStore.js";
import { createHangingPgPool } from "./helpers/hangingPgPool.mjs";
import { loadDurablePixelPayApproval } from "../src/services/payments/pixelPayDurableApproval.js";

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
const USER_B = "89888888-8888-4888-8888-888888888888";
const CLIENT_A = "89898989-8989-4989-8989-898989898989";
const CLIENT_B = "90909090-9090-4090-8090-909090909090";
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
    paymentAttemptId: null,
    errorCode: "PIXELPAY_RESPONSE_INVALID",
    errorName: "Error",
    sdkErrorName: null,
    upstreamStatusCode: 200,
    upstreamContentType: "text/html; charset=utf-8 x-secret: hidden",
    upstreamContentLength: 321,
    cfRay: null,
    responseClass: null,
    safeMessageCode: null,
    errorConstructorName: null,
    uncertain: true,
    cardExpireFormatValid: null,
    cardExpireFuture: null,
    billingAddressLength: null,
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
    inputErrorFields: ["order_id", "billing_state", "5555555555554444", "999", "secret-value", "billing_state"],
    inputErrorCount: 99,
    inputErrorUnknownCount: 3,
    cardExpireFormatValid: true,
    cardExpireFuture: true,
    billingAddressLength: 24,
    outcome: "uncertain",
    payment_uuid: "must-not-appear",
    response: { data: { card: "must-not-appear" } },
  });

  assert.equal(diagnostic.sdkResponseClass, "SuccessResponse");
  assert.equal(diagnostic.transactionResultParsed, false);
  assert.equal(diagnostic.outcome, "uncertain");
  assert.deepEqual(diagnostic.inputErrorFields, ["billing_state", "order_id"]);
  assert.equal(diagnostic.inputErrorCount, 2);
  assert.equal(diagnostic.inputErrorUnknownCount, 3);
  assert.equal(diagnostic.cardExpireFormatValid, true);
  assert.equal(diagnostic.cardExpireFuture, true);
  assert.equal(diagnostic.billingAddressLength, 24);
  assert.equal(Object.hasOwn(diagnostic, "payment_uuid"), false);
  assert.equal(Object.hasOwn(diagnostic, "response"), false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /must-not-appear|5555555555554444|"999"|secret-value/);
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
    id_persona_cliente: USER_A,
    primary_email_count: 1,
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
  failAttemptStart = false,
  failAttemptFinal = false,
  failPaymentInsert = false,
  ownerEmail = "cliente@example.com",
  holdExpiresAt = "2099-01-01T16:00:00.000Z",
  groupSize = 1,
  secondHoldExpiresAt = "2099-01-01T17:00:00.000Z",
  secondHoldState = "activo",
  providerCode = "mock",
  groupCitaState = "en_espera",
  groupHoldState = "activo",
  initialPayments = [],
  initialSaleAttempts = [],
  groupStateCode = "activo",
  slotReused = false,
  groupId = GROUP_A,
  citaId = CITA_A,
  holdId = HOLD_A,
  amountHnl = 115,
  groupClientId = null,
  groupPersonId = USER_A,
  groupUserId = null,
  groupOrigin = "publico",
} = {}) {
  const calls = [];
  const statusChecks = [];
  const payments = structuredClone(initialPayments);
  let saleAttempts = structuredClone(initialSaleAttempts);
  let transactionSnapshot = null;
  let activeIntent = existingIntent ? { ...existingIntent } : null;
  const groupState = [
    makeGroupRow({
      ownerEmail,
      expiresAt: holdExpiresAt,
      citaState: groupCitaState,
      holdState: groupHoldState,
      idCita: citaId,
      idHold: holdId,
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
  for (const row of groupState) {
    row.id_grupo_cita = groupId;
    row.id_cliente_titular = groupClientId;
    row.cita_cliente_id = groupClientId;
    row.id_persona_titular = groupPersonId;
    row.id_persona_cliente = groupPersonId;
    row.id_usuario_titular = groupUserId;
    row.origen_codigo = groupOrigin;
    row.total_pagar_hnl = String(amountHnl);
    row.estado_grupo_codigo = groupStateCode;
  }
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
    getSaleAttempts() {
      return structuredClone(saleAttempts);
    },
    getGroupState() {
      return structuredClone(groupState);
    },
    async query(sql, params = []) {
      params = typeof sql === "object" ? sql.values ?? params : params;
      const text = typeof sql === "object" ? sql.text : String(sql);
      calls.push({ sql: text, params });
      if (text === "BEGIN") {
        transactionSnapshot = structuredClone({ activeIntent, groupState, payments, saleAttempts, groupStateCode });
        return { rows: [] };
      }
      if (text === "COMMIT") { transactionSnapshot = null; return { rows: [] }; }
      if (text === "ROLLBACK") {
        if (transactionSnapshot) {
          activeIntent = transactionSnapshot.activeIntent;
          groupState.splice(0, groupState.length, ...transactionSnapshot.groupState);
          payments.splice(0, payments.length, ...transactionSnapshot.payments);
          saleAttempts = transactionSnapshot.saleAttempts;
          groupStateCode = transactionSnapshot.groupStateCode;
          transactionSnapshot = null;
        }
        return { rows: [] };
      }
      if (text.includes("INSERT INTO app_private.pixelpay_sale_attempts")) {
        if (failAttemptStart) throw new Error("fixture de fallo en INSERT START");
        assert.ok(transactionSnapshot, "START debe compartir la transaccion del claim");
        const row = {
          id_sale_attempt: params[1], id_intent: params[0], payment_attempt_id: params[1],
          request_id: params[2], card_expire_format_valid: params[3], card_expire_future: params[4],
          billing_address_length: params[5], finalized_at: null,
        };
        saleAttempts.push(row);
        return { rows: [{ id_sale_attempt: row.id_sale_attempt }] };
      }
      if (text.includes("UPDATE app_private.pixelpay_sale_attempts")) {
        assert.equal(transactionSnapshot, null, "FINAL debe usar autocommit fuera del claim");
        if (failAttemptFinal) throw new Error("fixture privada 4111111111111111 secretKey-final");
        const row = saleAttempts.find((entry) => entry.payment_attempt_id === params[0] && !entry.finalized_at);
        if (!row) return { rows: [] };
        Object.assign(row, {
          finalized_at: new Date().toISOString(), duration_ms: params[1], sdk_response_class: params[2],
          upstream_http_status: params[3], safe_message_code: params[4], outcome: params[5], uncertain: params[6],
          input_error_fields: params[7], input_error_count: params[8], input_error_unknown_count: params[9],
          observed_payment_uuid_untrusted: params[31],
          observed_transaction_id_untrusted: params[32],
          observed_transaction_reference_untrusted: params[33],
          final_parameters: structuredClone(params),
        });
        return { rows: [{ id_sale_attempt: row.id_sale_attempt }] };
      }
      if (text.includes("AS finalized_at FROM app_private.pixelpay_sale_attempts")) {
        const flags = ["response_success", "response_approved", "transaction_result_valid", "transaction_result_parsed",
          "payment_uuid_present", "transaction_id_present", "payment_hash_present", "payment_hash_valid",
          "transaction_amount_matches", "approved_amount_matches", "amount_matches"];
        for (const flag of flags) assert.ok(text.includes(`${flag} IS TRUE`));
        assert.ok(text.includes("response_incomplete IS FALSE AND uncertain IS FALSE"));
        assert.ok(text.includes("finalized_at <= $2::timestamptz"));
        assert.ok(text.includes("LIMIT 2"));
        assert.ok(text.includes("SELECT min(h.expires_at)"));
        const rows = saleAttempts.filter((entry) => entry.id_intent === params[0] && entry.outcome === "approved"
          && entry.sdk_response_class === "SuccessResponse" && entry.upstream_http_status === 200
          && entry.finalized_at && new Date(entry.finalized_at).getTime() <= new Date(params[1]).getTime()
          && flags.every((flag) => entry[flag] === true) && entry.response_incomplete === false && entry.uncertain === false);
        return { rows: rows.slice(0, 2).map((row) => ({ finalized_at: row.finalized_at })) };
      }
      if (failPaymentInsert && text.includes("INSERT INTO public.payments")) {
        throw new Error("fixture fallo financiero posterior a FINAL");
      }
      if (text.includes("FROM public.citas_grupos cg") && text.includes("co.direccion_correo")) {
        return { rows: structuredClone(groupState).map((row) => ({ ...row, estado_grupo_codigo: groupStateCode })) };
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
            subtotal_servicios_hnl: String(amountHnl === 115 ? 100 : amountHnl),
          }],
        };
      }
      if (text.includes("FROM public.citas_detalles") && text.includes("id_cita = $1::uuid")) {
        return {
          rows: [{
            id_cita_detalle: DETAIL_A,
            id_servicio: SERVICE_A,
            id_cita_paquete: null,
            nombre_servicio_snapshot: "Corte QA",
            nombre_paquete_snapshot: null,
            cantidad: 1,
            precio_unitario_hnl: String(amountHnl === 115 ? 100 : amountHnl),
            subtotal_hnl: String(amountHnl === 115 ? 100 : amountHnl),
            descuento_hnl: "0.00",
            incluye_isv_snapshot: false,
            isv_porcentaje: amountHnl === 115 ? "15.00" : "0.00",
            isv_hnl: amountHnl === 115 ? "15.00" : "0.00",
            total_linea_hnl: String(amountHnl),
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
            id_grupo_cita: groupId,
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
        return { rows: [{ id_grupo_cita: groupId, id_cliente_titular: null }] };
      }
      if (text.includes("SELECT COALESCE(SUM(total_pagar_hnl),0)::numeric AS total")) {
        return { rows: [{ total: String(amountHnl) }] };
      }
      if (text.includes("app_private.confirmar_reserva_pagada_v1")) {
        if (slotReused) {
          const error = new Error("MF_PAYMENT_SLOT_ALREADY_RELEASED");
          error.code = "P0001";
          throw error;
        }
        activeIntent = { ...activeIntent, estado_intent_codigo: "confirmado", paid_at: params[2] };
        for (const row of groupState) {
          row.estado_cita_codigo = "confirmada";
          row.estado_hold_codigo = "consumido";
        }
        return { rows: [{ resultado: { confirmed: true, id_grupo_cita: groupId } }] };
      }
      if (text.includes("UPDATE public.citas_grupos") && text.includes("estado_grupo_codigo = 'activo'")) {
        groupStateCode = "activo";
        for (const row of groupState) row.estado_grupo_codigo = "activo";
        return { rows: [] };
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
  authenticated = false,
  claims = null,
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
  app.decorate("requireRoles", () => async (request) => {
    request.claims = claims;
  });
  app.decorate("db", {
    async connect() {
      return connectFactory ? connectFactory() : client;
    },
    async query(sql, params = []) {
      return client.query(sql, params);
    },
  });
  await app.register(publicPagosRoutes, {
    prefix: authenticated ? "/v1/pagos/reservas" : "/v1/public/pagos",
    authenticated,
  });
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
    groupClientId: CLIENT_A,
    groupOrigin: "publico",
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

test("Sale uncertain persiste evidencia privada sin fuga, pago, referencias confiables ni Status", async () => {
  const observedPaymentUuid = "12345678-1234-4234-8234-123456789abc";
  const observedTransactionId = "TX-UNCERTAIN-408";
  const observedTransactionReference = "REF-UNCERTAIN-408";
  const logs = [];
  const client = pixelPayClaimClient();
  const provider = {
    saleCalls: 0,
    statusCalls: 0,
    async sale(input, context) {
      this.saleCalls += 1;
      return {
        outcome: "uncertain",
        statusCode: 408,
        paymentUuid: observedPaymentUuid,
        transactionId: observedTransactionId,
        transactionReference: observedTransactionReference,
        paymentHashValid: false,
        amountMatches: true,
        diagnostics: {
          paymentAttemptId: context.paymentAttemptId,
          sdkResponseClass: "TimeoutResponse",
          statusCode: 408,
          safeMessageCode: "SDK_UPSTREAM_TIMEOUT",
          outcome: "uncertain",
          responseSuccess: false,
          transactionResultValid: true,
          transactionResultParsed: true,
          hasPaymentUuid: true,
          hasTransactionId: true,
          hasPaymentHash: false,
          paymentHashValid: false,
          amountMatches: true,
        },
      };
    },
    async queryPaymentStatus() {
      this.statusCalls += 1;
      throw new Error("STATUS_RECONCILIATION_BLOCKED_BY_PROVIDER_CONTRACT");
    },
  };
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider, logs });
  const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
  assert.equal(response.statusCode, 202, response.body);
  const replay = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal(provider.saleCalls, 1);
  assert.equal(provider.statusCalls, 0);
  assert.equal(client.getStatusChecks().length, 0);
  assert.equal(client.getPayments().length, 0);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
  assert.equal(client.getActiveIntent().provider_session_id || null, null);
  assert.equal(client.getActiveIntent().referencia_externa || null, null);
  assert.equal(client.calls.some((call) => call.sql.includes("UPDATE public.payment_intents")
    && call.sql.includes("provider_session_id = COALESCE")), false);
  const row = client.getSaleAttempts()[0];
  assert.equal(row.safe_message_code, "SDK_UPSTREAM_TIMEOUT");
  assert.equal(row.observed_payment_uuid_untrusted, observedPaymentUuid);
  assert.equal(row.observed_transaction_id_untrusted, observedTransactionId);
  assert.equal(row.observed_transaction_reference_untrusted, observedTransactionReference);
  assert.doesNotMatch(`${response.body}\n${replay.body}`,
    new RegExp(`${observedPaymentUuid}|${observedTransactionId}|${observedTransactionReference}`));
  assert.doesNotMatch(logs.join("\n"), new RegExp(`${observedPaymentUuid}|${observedTransactionId}|${observedTransactionReference}`));
  await app.close();
});

test("sale SDK no aprobada registra diagnostico seguro una vez y no lo devuelve", async () => {
  const logs = [];
  const provider = {
    saleCalls: 0,
    saleInput: null,
    async sale(input) {
      this.saleCalls += 1;
      this.saleInput = structuredClone(input);
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
          inputErrorFields: ["billing_state", "5555555555554444", "999", "secret-value"],
          inputErrorCount: 4,
          inputErrorUnknownCount: 3,
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
  assert.equal(provider.saleInput.amount, 115);
  assert.deepEqual(provider.saleInput.items, [{
    code: SERVICE_A,
    title: "Corte QA",
    price: 115,
    qty: 1,
  }]);
  assert.equal(diagnosticLogs.length, 1);
  assert.equal(diagnosticLogs[0].id_intent, INTENT_A);
  assert.equal(diagnosticLogs[0].pixelPaySdkDiagnostics.transactionResultValid, false);
  assert.equal(diagnosticLogs[0].pixelPaySdkDiagnostics.outcome, "uncertain");
  assert.equal(diagnosticLogs[0].pixelPaySdkDiagnostics.safeMessageCode, "SDK_PUBLIC_KEY_UNAVAILABLE");
  assert.deepEqual(diagnosticLogs[0].pixelPaySdkDiagnostics.inputErrorFields, ["billing_state"]);
  assert.equal(diagnosticLogs[0].pixelPaySdkDiagnostics.inputErrorCount, 1);
  assert.equal(diagnosticLogs[0].pixelPaySdkDiagnostics.inputErrorUnknownCount, 3);
  assert.equal(Object.hasOwn(payload.data, "diagnostics"), false);
  assert.doesNotMatch(response.body, /sdkResponseClass|transactionResultValid|safeMessageCode|sensitive-/i);
  assert.doesNotMatch(logs.join(""), /sensitive-payment|sensitive-transaction|sensitive-pan/i);
  assert.doesNotMatch(
    JSON.stringify(diagnosticLogs[0].pixelPaySdkDiagnostics),
    /5555555555554444|"999"|secret-value/
  );
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

test("Sale APPROVED sin paidAt persiste timestamp backend y conserva referencias canonicas", async () => {
  const provider = {
    saleCalls: 0,
    async sale() {
      this.saleCalls += 1;
      return {
        outcome: "approved",
        paymentUuid: "P-UUID-PAID-AT",
        transactionId: "TX-PAID-AT",
        paymentHashValid: true,
        amountMatches: true,
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
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });
  const startedAt = Date.now();

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/pixelpay/sale",
    payload: pixelPaySalePayload(),
  });

  const payment = client.getPayments()[0];
  const intent = client.getActiveIntent();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(provider.saleCalls, 1);
  assert.equal(client.getPayments().length, 1);
  assert.ok(Number.isFinite(Date.parse(payment.paid_at)));
  assert.ok(Date.parse(payment.paid_at) >= startedAt);
  assert.equal(intent.estado_intent_codigo, "confirmado");
  assert.equal(intent.provider_session_id, "P-UUID-PAID-AT");
  assert.equal(payment.provider_tx_id, "P-UUID-PAID-AT");
  assert.equal(payment.monto_hnl, 115);
  assert.equal(payment.moneda_codigo, "HNL");
  assert.equal(client.getGroupState()[0].estado_hold_codigo, "consumido");
  assert.equal(client.getGroupState()[0].estado_cita_codigo, "confirmada");
  await app.close();
});

function pixelPayClaimClient(options = {}) {
  return createPagosClient({
    providerCode: "pixelpay",
    existingIntent: {
      id_intent: INTENT_A, id_provider: PROVIDER_A, id_cita: CITA_A, id_hold: HOLD_A,
      id_grupo_cita: GROUP_A, estado_intent_codigo: "link_generado",
      expires_at: "2099-01-01T16:00:00.000Z", monto_hnl: "115.00", moneda_codigo: "HNL",
      orden_compra: "MF-PIXELPAY-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", created_by_usuario_id: USER_A,
    },
    ...options,
  });
}

test("START comparte transaccion/COMMIT con el claim y el mismo UUID llega al provider y FINAL", async () => {
  const client = pixelPayClaimClient();
  const trace = [];
  let connections = 0;
  const provider = {
    saleCalls: 0,
    async sale(input, context) {
      this.saleCalls += 1;
      trace.push({ source: "provider", sql: "SALE" });
      const row = client.getSaleAttempts()[0];
      assert.equal(row.payment_attempt_id, context.paymentAttemptId);
      assert.equal(row.request_id, context.requestId);
      assert.equal(row.finalized_at, null);
      assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
      return { outcome: "payment_declined", statusCode: 402, diagnostics: {
        paymentAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sdkResponseClass: "PaymentDeclinedResponse",
        statusCode: 402, outcome: "payment_declined", responseSuccess: false,
      } };
    },
  };
  const app = await createPagosApp(client, {
    providerCode: "pixelpay", providerAdapter: provider,
    connectFactory() {
      const source = `client-${++connections}`;
      return {
        async query(sql, params) { trace.push({ source, sql }); return client.query(sql, params); },
        release() { trace.push({ source, sql: "RELEASE" }); },
      };
    },
  });
  app.db.query = async (sql, params) => {
    trace.push({ source: "pool-autocommit", sql: typeof sql === "object" ? sql.text : sql });
    return client.query(sql, params);
  };
  const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
  assert.equal(response.statusCode, 200, response.body);
  const startIndex = trace.findIndex((entry) => entry.sql.includes("INSERT INTO app_private.pixelpay_sale_attempts"));
  const claimIndex = trace.findIndex((entry) => entry.sql.includes("proteger_reserva_pago_v1"));
  const commitIndex = trace.findIndex((entry) => entry.sql === "COMMIT");
  const saleIndex = trace.findIndex((entry) => entry.sql === "SALE");
  const finalIndex = trace.findIndex((entry) => entry.sql.includes("UPDATE app_private.pixelpay_sale_attempts"));
  assert.ok(claimIndex < startIndex && startIndex < commitIndex && commitIndex < saleIndex && saleIndex < finalIndex);
  assert.equal(trace[claimIndex].source, trace[startIndex].source);
  assert.equal(trace[startIndex].source, trace[commitIndex].source);
  assert.equal(trace[finalIndex].source, "pool-autocommit");
  assert.equal(provider.saleCalls, 1);
  assert.equal(client.getSaleAttempts().length, 1);
  assert.equal(client.getSaleAttempts()[0].outcome, "payment_declined");
  assert.equal(client.getSaleAttempts()[0].card_expire_format_valid, true);
  assert.equal(client.getSaleAttempts()[0].card_expire_future, true);
  await app.close();
});

test("INSERT START fallido hace ROLLBACK del claim sin Sale ni intent abandonado", async () => {
  const client = pixelPayClaimClient({ failAttemptStart: true });
  const initialIntent = client.getActiveIntent();
  const initialGroup = client.getGroupState();
  const provider = { saleCalls: 0, async sale() { this.saleCalls += 1; throw new Error("no debe invocarse"); } };
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });
  const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(provider.saleCalls, 0);
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(client.calls.some((call) => call.sql === "COMMIT"), false);
  assert.deepEqual(client.getActiveIntent(), initialIntent);
  assert.deepEqual(client.getGroupState(), initialGroup);
  assert.deepEqual(client.getSaleAttempts(), []);
  await app.close();
});

for (const scenario of [
  { outcome: "approved", status: 200, responseClass: "SuccessResponse", http: 200, intent: "confirmado" },
  { outcome: "payment_declined", status: 402, responseClass: "PaymentDeclinedResponse", http: 200, intent: "fallido" },
  { outcome: "request_error_definitive", status: 422, responseClass: "InputErrorResponse", http: 200, intent: "fallido" },
  { outcome: "uncertain", status: 503, responseClass: "NetworkFailureResponse", http: 202, intent: "pendiente_confirmacion" },
]) {
  for (const finalFailure of [false, true]) {
    test(`FINAL ${scenario.outcome}, persistencia ${finalFailure ? "fallida" : "correcta"}, conserva resultado financiero`, async () => {
      const logs = [];
      const client = pixelPayClaimClient({ failAttemptFinal: finalFailure });
      const provider = {
        saleCalls: 0, statusCalls: 0,
        async sale(input, context) {
          this.saleCalls += 1;
          return {
            outcome: scenario.outcome, statusCode: scenario.status,
            paymentUuid: "P-UUID-DURABLE", transactionId: "TX-DURABLE",
            paymentHashValid: true, amountMatches: true,
            diagnostics: {
              paymentAttemptId: context.paymentAttemptId, sdkResponseClass: scenario.responseClass,
              statusCode: scenario.status, safeMessageCode: "SDK_MESSAGE_ABSENT", outcome: scenario.outcome,
              inputErrorFields: scenario.status === 422
                ? ["order_id", "billing_state", "billing_state", "5555555555554444", "999", "secret-value"] : [],
              inputErrorUnknownCount: scenario.status === 422 ? 3 : 0,
              responseSuccess: scenario.outcome === "approved", transactionResultValid: true,
              transactionResultParsed: true, responseApproved: scenario.outcome === "approved",
              responseIncomplete: false, responseCodePresent: true, hasPaymentUuid: true,
              hasTransactionId: true, hasPaymentHash: true, paymentHashValid: true,
              transactionAmountMatches: true, approvedAmountMatches: true, amountMatches: true,
              cfRay: "aabbccddeeff0011-MIA",
              response: { card_number: "4111111111111111" }, errors: { order_id: ["secretKey-value"] },
              payment_hash: "hash-privado", secretKey: "secretKey-value", authHash: "authHash-value",
            },
          };
        },
        async queryPaymentStatus() { this.statusCalls += 1; throw new Error("Status prohibido"); },
      };
      const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider, logs });
      const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
      assert.equal(response.statusCode, scenario.http, response.body);
      assert.equal(client.getActiveIntent().estado_intent_codigo, scenario.intent);
      assert.equal(client.getPayments().length, scenario.outcome === "approved" ? 1 : 0);
      assert.equal(provider.saleCalls, 1);
      assert.equal(provider.statusCalls, 0);
      assert.equal(client.getStatusChecks().length, 0);
      const row = client.getSaleAttempts()[0];
      assert.equal(client.getSaleAttempts().length, 1);
      assert.equal(row.finalized_at !== null, !finalFailure);
      if (!finalFailure) {
        assert.equal(row.outcome, scenario.outcome);
        assert.equal(row.upstream_http_status, scenario.status);
        assert.equal(row.sdk_response_class, scenario.responseClass);
        assert.deepEqual(row.input_error_fields, scenario.status === 422 ? ["billing_state", "order_id"] : []);
        assert.equal(row.input_error_count, scenario.status === 422 ? 2 : 0);
        assert.equal(row.input_error_unknown_count, scenario.status === 422 ? 3 : 0);
      }
      const critical = logs.map((entry) => JSON.parse(entry)).filter((entry) => entry.event === "PIXELPAY_SALE_FINAL_PERSISTENCE_FAILED");
      assert.equal(critical.length, finalFailure ? 1 : 0);
      if (finalFailure) {
        assert.equal(critical[0].level, 60);
        assert.equal(critical[0].paymentAttemptId, row.payment_attempt_id);
        assert.equal(critical[0].err, undefined);
      }
      const diagnosticWrites = client.calls.filter((call) => call.sql.includes("app_private.pixelpay_sale_attempts"));
      assert.equal(diagnosticWrites.length, 2);
      assert.doesNotMatch(JSON.stringify({ sqlParams: diagnosticWrites.map((call) => call.params), row, logs }),
        /4111111111111111|5555555555554444|"999"|secret-value|secretKey-value|authHash-value|hash-privado|CLIENTE PRUEBA|Calle QA|"2807"/);
      await app.close();
    });
  }
}

for (const scenario of [
  { outcome: "approved", status: 200, responseClass: "SuccessResponse", http: 200, intent: "confirmado" },
  { outcome: "request_error_definitive", status: 422, responseClass: "InputErrorResponse", http: 200, intent: "fallido" },
  { outcome: "uncertain", status: 503, responseClass: "NetworkFailureResponse", http: 202, intent: "pendiente_confirmacion" },
]) {
  test(`timeout nativo FINAL ${scenario.outcome} conserva el resultado, una Sale y cero Status/retries`, {
    timeout: PIXELPAY_SALE_FINAL_QUERY_TIMEOUT_MS + 10000,
  }, async (t) => {
    const logs = [];
    const client = pixelPayClaimClient();
    const { pool, connections } = createHangingPgPool();
    t.after(() => pool.end());
    const provider = {
      saleCalls: 0, statusCalls: 0,
      async sale(input, context) {
        this.saleCalls += 1;
        return {
          outcome: scenario.outcome, statusCode: scenario.status,
          paymentUuid: "P-UUID-TIMEOUT", transactionId: "TX-TIMEOUT",
          paymentHashValid: true, amountMatches: true,
          diagnostics: {
            paymentAttemptId: context.paymentAttemptId, sdkResponseClass: scenario.responseClass,
            statusCode: scenario.status, outcome: scenario.outcome,
          },
        };
      },
      async queryPaymentStatus() { this.statusCalls += 1; throw new Error("Status prohibido"); },
    };
    const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider, logs });
    t.after(() => app.close());
    const financialQuery = app.db.query.bind(app.db);
    let finalCalls = 0;
    app.db.query = (query, values) => {
      const sql = typeof query === "object" ? query.text : query;
      if (sql.includes("UPDATE app_private.pixelpay_sale_attempts")) {
        finalCalls += 1;
        // AM: Solo FINAL usa pg real con transporte simulado que nunca responde; no hay red.
        return pool.query(query, values);
      }
      return financialQuery(query, values);
    };
    const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
    assert.equal(response.statusCode, scenario.http, response.body);
    assert.equal(client.getActiveIntent().estado_intent_codigo, scenario.intent);
    assert.equal(client.getPayments().length, scenario.outcome === "approved" ? 1 : 0);
    assert.equal(provider.saleCalls, 1);
    assert.equal(provider.statusCalls, 0);
    assert.equal(client.getStatusChecks().length, 0);
    assert.equal(finalCalls, 1);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].executions, 1);
    assert.equal(connections[0].destroyed, true);
    assert.equal(pool.totalCount, 0);
    assert.equal(client.getSaleAttempts().length, 1);
    const row = client.getSaleAttempts()[0];
    assert.equal(row.finalized_at, null);
    const critical = logs.map((entry) => JSON.parse(entry)).filter((entry) => entry.event === "PIXELPAY_SALE_FINAL_PERSISTENCE_FAILED");
    assert.equal(critical.length, 1);
    assert.equal(critical[0].level, 60);
    assert.equal(critical[0].idIntent, INTENT_A);
    assert.equal(critical[0].paymentAttemptId, row.payment_attempt_id);
    assert.equal(critical[0].err, undefined);
    assert.equal(critical[0].error, undefined);
    assert.doesNotMatch(JSON.stringify(critical), /Query read timeout|card_number|card_cvv|secretKey|authHash/);
  });
}

for (const uncertain of [false, true]) {
  for (const failAttemptFinal of [false, true]) {
    test(`excepcion provider uncertain=${uncertain}, FINAL failure=${failAttemptFinal} mantiene clasificacion`, async () => {
      const client = pixelPayClaimClient({ failAttemptFinal });
      const provider = {
        saleCalls: 0, statusCalls: 0,
        async sale() {
          this.saleCalls += 1;
          throw Object.assign(new Error("fixture-privada"), {
            code: "PIXELPAY_RESPONSE_INVALID", uncertain, statusCode: uncertain ? 503 : 422,
            responseClass: "InputErrorResponse", safeMessageCode: "SDK_EXCEPTION_OTHER",
            errorConstructorName: "Error", sdkErrorName: "Error",
          });
        },
        async queryPaymentStatus() { this.statusCalls += 1; throw new Error("Status prohibido"); },
      };
      const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });
      const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
      assert.equal(response.statusCode, uncertain ? 202 : 502, response.body);
      assert.equal(client.getActiveIntent().estado_intent_codigo, uncertain ? "pendiente_confirmacion" : "fallido");
      assert.equal(provider.saleCalls, 1);
      assert.equal(provider.statusCalls, 0);
      const row = client.getSaleAttempts()[0];
      assert.equal(row.finalized_at !== null, !failAttemptFinal);
      if (!failAttemptFinal) {
        assert.equal(row.outcome, uncertain ? "uncertain" : "request_error_definitive");
        assert.equal(row.sdk_response_class, "InputErrorResponse");
        assert.equal(row.upstream_http_status, uncertain ? 503 : 422);
        assert.equal(row.final_parameters[27], "PIXELPAY_RESPONSE_INVALID");
      }
      await app.close();
    });
  }
}

test("FINAL aprobado sigue disponible si falla despues la escritura de referencias", async () => {
  const client = pixelPayClaimClient({ throwPixelPayReferenceUpdate: true });
  const provider = {
    async sale() { return { outcome: "approved", statusCode: 200, paymentUuid: "P-UUID", transactionId: "TX",
      diagnostics: { sdkResponseClass: "SuccessResponse", statusCode: 200, amountMatches: true } }; },
  };
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });
  const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(client.getSaleAttempts()[0].outcome, "approved");
  assert.ok(client.getSaleAttempts()[0].finalized_at);
  await app.close();
});

test("ROLLBACK de reconciliacion posterior no elimina START ni FINAL durable", async () => {
  const client = pixelPayClaimClient({ failPaymentInsert: true });
  const provider = {
    saleCalls: 0,
    async sale() {
      this.saleCalls += 1;
      return { outcome: "approved", paymentUuid: "P-UUID", transactionId: "TX", statusCode: 200,
        diagnostics: { sdkResponseClass: "SuccessResponse", statusCode: 200, amountMatches: true } };
    },
  };
  const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });
  const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", payload: pixelPaySalePayload() });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(provider.saleCalls, 1);
  assert.equal(client.getPayments().length, 0);
  const finalIndex = client.calls.findIndex((call) => call.sql.includes("UPDATE app_private.pixelpay_sale_attempts"));
  const beginIndices = client.calls.flatMap((call, i) => call.sql === "BEGIN" ? [i] : []);
  const rollbackIndex = client.calls.findIndex((call) => call.sql === "ROLLBACK");
  assert.equal(beginIndices.length, 2);
  assert.ok(finalIndex < beginIndices[1] && beginIndices[1] < rollbackIndex);
  assert.equal(client.getSaleAttempts().length, 1);
  assert.equal(client.getSaleAttempts()[0].outcome, "approved");
  assert.ok(client.getSaleAttempts()[0].finalized_at);
  await app.close();
});

test("reconcilePixelPayPaid respeta paidAt explicito", async () => {
  const explicitPaidAt = "2026-10-06T14:51:50.768Z";
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
      provider_session_id: "P-UUID-EXPLICIT",
      referencia_externa: "TX-EXPLICIT",
      created_by_usuario_id: USER_A,
    },
  });

  await reconcilePixelPayPaid(client, {
    idGrupoCita: GROUP_A,
    idIntent: INTENT_A,
    titularEmail: "cliente@example.com",
    paymentUuid: "P-UUID-EXPLICIT",
    providerTransactionId: "TX-EXPLICIT",
    expectedAmount: 115,
    paidAt: explicitPaidAt,
  });

  assert.equal(client.getPayments().length, 1);
  assert.equal(client.getPayments()[0].paid_at, explicitPaidAt);
  assert.equal(client.getActiveIntent().paid_at, explicitPaidAt);
});

test("payment_uuid duplicado en otro intent sigue protegido", async () => {
  const duplicateTransactionId = "TX-DUPLICATE";
  const client = createPagosClient({
    providerCode: "pixelpay",
    initialPayments: [{
      id_payment: "edededed-eded-4ded-8ded-edededededed",
      id_intent: "98989898-9898-4989-8989-989898989898",
      estado_pago_codigo: "capturado",
      provider_tx_id: "P-UUID-DUPLICATE",
      monto_hnl: 115,
      moneda_codigo: "HNL",
      paid_at: "2026-10-06T14:00:00.000Z",
    }],
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
      provider_session_id: "P-UUID-DUPLICATE",
      referencia_externa: duplicateTransactionId,
      created_by_usuario_id: USER_A,
    },
  });

  await assert.rejects(
    reconcilePixelPayPaid(client, {
      idGrupoCita: GROUP_A,
      idIntent: INTENT_A,
      titularEmail: "cliente@example.com",
      paymentUuid: "P-UUID-DUPLICATE",
      providerTransactionId: duplicateTransactionId,
      expectedAmount: 115,
    }),
    (error) => error?.code === "PIXELPAY_TRANSACTION_CONFLICT"
  );
  assert.equal(client.getPayments().length, 1);
  assert.equal(client.getPayments()[0].id_intent, "98989898-9898-4989-8989-989898989898");
});

function reconciliationIntent(overrides = {}) {
  return {
    id_intent: INTENT_A, id_provider: PROVIDER_A, id_cita: CITA_A, id_hold: HOLD_A,
    id_grupo_cita: GROUP_A, estado_intent_codigo: "pendiente_confirmacion",
    expires_at: "2099-01-01T16:00:00.000Z", monto_hnl: "115.00", moneda_codigo: "HNL",
    provider_session_id: "PAYMENT-UUID-NEW", referencia_externa: "TX-SANDBOX-REPEATED",
    created_by_usuario_id: USER_A, ...overrides,
  };
}

function reconcileFixture(client, overrides = {}) {
  return reconcilePixelPayPaid(client, {
    idGrupoCita: GROUP_A, idIntent: INTENT_A, titularEmail: "cliente@example.com",
    paymentUuid: "PAYMENT-UUID-NEW", providerTransactionId: "TX-SANDBOX-REPEATED",
    expectedAmount: 115, ...overrides,
  });
}

test("transactionId repetido y UUID distinto no colisionan, incluyendo caso real QA", async () => {
  for (const [tx, historicalUuid, newUuid] of [
    ["TX-SANDBOX-REPEATED", "PAYMENT-UUID-OLD", "PAYMENT-UUID-NEW"],
    ["1f694eee-4715-45b8-a545-000000000000", "S-a2eae9f3-11f5-4d5c-8190-0beec0242038", "S-a2f5612c-5084-4134-ad5f-feeb0ae6d8c8"],
  ]) {
    const historical = { id_intent: "98989898-9898-4989-8989-989898989898", provider_tx_id: tx,
      estado_pago_codigo: "capturado", provider_session_id: historicalUuid };
    const client = createPagosClient({ providerCode: "pixelpay", initialPayments: [historical],
      existingIntent: reconciliationIntent({ referencia_externa: tx, provider_session_id: newUuid }) });
    const result = await reconcileFixture(client, { providerTransactionId: tx, paymentUuid: newUuid });
    assert.equal(result.booking_confirmed, true);
    assert.equal(client.getPayments().filter((row) => row.id_intent === INTENT_A).length, 1);
    assert.equal(client.getPayments().find((row) => row.id_intent === INTENT_A).provider_tx_id, newUuid);
    assert.deepEqual(client.getPayments()[0], historical);
    assert.equal(client.getActiveIntent().estado_intent_codigo, "confirmado");
    assert.equal(client.getActiveIntent().referencia_externa, tx);
  }
});

for (const state of ["confirmado", "pendiente_confirmacion"]) {
  test(`payment legacy del mismo intent es idempotente (${state})`, async () => {
    const legacy = { id_intent: INTENT_A, provider_tx_id: "TX-SANDBOX-REPEATED", estado_pago_codigo: "capturado" };
    const client = createPagosClient({ providerCode: "pixelpay", initialPayments: [legacy],
      existingIntent: reconciliationIntent({ estado_intent_codigo: state }) });
    const first = await reconcileFixture(client);
    const second = await reconcileFixture(client);
    assert.equal(first.duplicate, true);
    assert.equal(second.duplicate, true);
    assert.deepEqual(client.getPayments(), [legacy]);
    assert.equal(client.getActiveIntent().estado_intent_codigo, "confirmado");
  });
}

test("UUID nuevo idempotente ejecuta confirmacion y efectos postpago solo una vez", async () => {
  const client = createPagosClient({ providerCode: "pixelpay", existingIntent: reconciliationIntent() });
  await reconcileFixture(client);
  const callsAfterFirst = client.calls.length;
  const repeated = await reconcileFixture(client);
  assert.equal(repeated.duplicate, true);
  assert.equal(client.getPayments().length, 1);
  assert.equal(client.calls.filter((call) => call.sql.includes("app_private.confirmar_reserva_pagada_v1")).length, 1);
  const repeatedSql = client.calls.slice(callsAfterFirst).map((call) => call.sql).join("\n");
  assert.doesNotMatch(repeatedSql, /INSERT INTO|UPDATE public\.|promociones|notificaciones_email|puntos/i);
});

test("compatibilidad legacy no permite UUID perteneciente a otro intent", async () => {
  const client = createPagosClient({ providerCode: "pixelpay", existingIntent: reconciliationIntent({ estado_intent_codigo: "confirmado" }),
    initialPayments: [
      { id_intent: INTENT_A, provider_tx_id: "TX-SANDBOX-REPEATED", estado_pago_codigo: "capturado" },
      { id_intent: CITA_B, provider_tx_id: "PAYMENT-UUID-NEW", estado_pago_codigo: "capturado" },
    ] });
  await assert.rejects(reconcileFixture(client), (error) => error.code === "PIXELPAY_TRANSACTION_CONFLICT");
  assert.equal(client.getPayments().length, 2);
});

function durableApprovalFixture(overrides = {}) {
  return {
    id_intent: INTENT_A, outcome: "approved", finalized_at: "2020-01-01T15:59:00.000Z",
    sdk_response_class: "SuccessResponse", upstream_http_status: 200,
    response_success: true, response_approved: true, response_incomplete: false,
    transaction_result_valid: true, transaction_result_parsed: true,
    payment_uuid_present: true, transaction_id_present: true, payment_hash_present: true,
    payment_hash_valid: true, transaction_amount_matches: true, approved_amount_matches: true,
    amount_matches: true, uncertain: false, ...overrides,
  };
}

const invalidApprovals = [
  ["sin evidencia", null],
  ["solo START", { finalized_at: null, created_at: "2020-01-01T15:58:00.000Z" }],
  ["despues del expiry", { finalized_at: "2020-01-01T16:00:00.001Z" }],
  ["otro intent", { id_intent: CITA_B }],
  ["outcome incierto", { outcome: "uncertain" }],
  ["HTTP no exitoso", { upstream_http_status: 422 }],
  ["clase no exitosa", { sdk_response_class: "InputErrorResponse" }],
  ["uncertain true", { uncertain: true }],
  ["incomplete true", { response_incomplete: true }],
  ...["response_success", "response_approved", "transaction_result_valid", "transaction_result_parsed",
    "payment_uuid_present", "transaction_id_present", "payment_hash_present", "payment_hash_valid",
    "transaction_amount_matches", "approved_amount_matches", "amount_matches"].flatMap((flag) => [
    [`${flag} false`, { [flag]: false }], [`${flag} null`, { [flag]: null }],
  ]),
];

for (const [name, approvalOverrides, slotReused] of [
  ["aprobacion previa", {}], ["aprobacion exactamente en expiry", { finalized_at: "2020-01-01T16:00:00.000Z" }],
  ["slot reutilizado", {}, true], ...invalidApprovals,
]) {
  test(`Status MOCK PAID post-expiry: ${name}`, async () => {
    const provider = { saleCalls: 0, statusCalls: 0,
      async sale() { this.saleCalls++; throw new Error("Sale prohibida"); },
      async queryPaymentStatus(paymentUuid) { this.statusCalls++; return { ok: true, success: true, statusCode: 200, status: "PAID", paymentUuid }; },
    };
    const approval = approvalOverrides === null ? null : durableApprovalFixture(approvalOverrides);
    const client = createPagosClient({ providerCode: "pixelpay", groupCitaState: "expirada", groupHoldState: "expirado",
      groupStateCode: "cancelado", holdExpiresAt: "2020-01-01T16:00:00.000Z", slotReused,
      existingIntent: reconciliationIntent({ expires_at: "2020-01-01T16:00:00.000Z" }),
      initialSaleAttempts: approval ? [approval] : [] });
    const app = await createPagosApp(client, { providerCode: "pixelpay", providerAdapter: provider });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/status",
        payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" } });
      if (slotReused) {
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error.code, "PAYMENT_SLOT_ALREADY_RELEASED");
        assert.equal(client.getPayments().length, 0);
        assert.equal(client.getGroupState()[0].estado_cita_codigo, "expirada");
        assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
      } else if (name.startsWith("aprobacion")) {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().data.booking_confirmed, true);
        assert.equal(client.getPayments().length, 1);
        assert.equal(client.getPayments()[0].provider_tx_id, "PAYMENT-UUID-NEW");
        assert.equal(client.getPayments()[0].paid_at, approval.finalized_at);
        assert.equal(client.getActiveIntent().estado_intent_codigo, "confirmado");
        assert.equal(client.getGroupState()[0].estado_cita_codigo, "confirmada");
        assert.equal(client.getGroupState()[0].estado_hold_codigo, "consumido");
      } else {
        assert.equal(response.statusCode, 202, response.body);
        assert.equal(response.json().data.manual_reconciliation_required, true);
        assert.equal(client.getPayments().length, 0);
      }
      assert.equal(provider.saleCalls, 0);
      assert.equal(provider.statusCalls, 1);
    } finally { await app.close(); }
  });
}

test("flag allowExpiredRecovery solo no habilita recuperacion ni permite backdate libre", async () => {
  for (const hasEvidence of [false, true]) {
    const client = createPagosClient({ providerCode: "pixelpay", groupStateCode: "cancelado",
      groupCitaState: "expirada", groupHoldState: "expirado", holdExpiresAt: "2020-01-01T16:00:00.000Z",
      existingIntent: reconciliationIntent(), initialSaleAttempts: hasEvidence ? [durableApprovalFixture()] : [] });
    const result = await reconcileFixture(client, { allowExpiredRecovery: true, paidAt: "2020-01-01T15:00:00.000Z" });
    assert.equal(result.manual_reconciliation_required, true);
    assert.equal(client.getPayments().length, 0);
  }
});

test("recuperacion requiere opt-in y nunca revive una cita cancelada explicitamente", async () => {
  for (const [allowExpiredRecovery, groupCitaState] of [[false, "expirada"], [true, "cancelada"]]) {
    const client = createPagosClient({ providerCode: "pixelpay", groupStateCode: "cancelado", groupCitaState,
      groupHoldState: "expirado", holdExpiresAt: "2020-01-01T16:00:00.000Z", existingIntent: reconciliationIntent(),
      initialSaleAttempts: [durableApprovalFixture()] });
    const result = await reconcileFixture(client, { allowExpiredRecovery, paidAt: durableApprovalFixture().finalized_at });
    assert.equal(result.manual_reconciliation_required, true);
    assert.equal(client.getPayments().length, 0);
  }
});

test("recuperacion usa menor expiry de todos los holds y lo revalida bajo locks", async () => {
  const client = createPagosClient({ providerCode: "pixelpay", groupStateCode: "cancelado", groupCitaState: "expirada",
    groupHoldState: "expirado", holdExpiresAt: "2020-01-01T16:00:00.000Z", groupSize: 2,
    secondHoldState: "expirado", secondHoldExpiresAt: "2020-01-01T15:58:00.000Z",
    existingIntent: reconciliationIntent(), initialSaleAttempts: [durableApprovalFixture()] });
  const result = await reconcileFixture(client, { allowExpiredRecovery: true, paidAt: durableApprovalFixture().finalized_at });
  assert.equal(result.manual_reconciliation_required, true);
  assert.equal(client.getPayments().length, 0);
  const evidenceQuery = client.calls.find((call) => call.sql.includes("SELECT finalized_at"));
  assert.equal(evidenceQuery.params[1], "2020-01-01T15:58:00.000Z");
  assert.ok(client.calls.findIndex((call) => call.sql.includes("FOR UPDATE OF h")) < client.calls.indexOf(evidenceQuery));
});

test("helper durable falla cerrado con holds ausentes o invalidos sin consultar DB", async () => {
  const client = { async query() { throw new Error("No debe consultar evidencia sin expiry valido"); } };
  for (const groupRows of [[], [{}], [{ expires_at: null }], [{ expires_at: "invalid" }]]) {
    assert.equal(await loadDurablePixelPayApproval(client, { idIntent: INTENT_A, groupRows }), null);
  }
});

function localRecoveryClient(overrides = {}) {
  return createPagosClient({ providerCode: "pixelpay", groupStateCode: "cancelado",
    groupCitaState: "expirada", groupHoldState: "expirado", holdExpiresAt: "2020-01-01T16:00:00.000Z",
    existingIntent: reconciliationIntent(), initialSaleAttempts: [durableApprovalFixture()], ...overrides });
}

async function recoverLocally(client, overrides = {}) {
  const previousProvider = PaymentProviderFactory._instance;
  const provider = { saleCalls: 0, statusCalls: 0,
    async sale() { this.saleCalls++; throw new Error("Sale prohibida en recovery local"); },
    async queryPaymentStatus() { this.statusCalls++; throw new Error("Status prohibido en recovery local"); },
  };
  PaymentProviderFactory._instance = provider;
  try {
    return await reconcilePixelPayFromDurableApproval(client, {
      idGrupoCita: GROUP_A, idIntent: INTENT_A, titularEmail: "cliente@example.com", ...overrides,
    });
  } finally {
    assert.equal(provider.saleCalls, 0);
    assert.equal(provider.statusCalls, 0);
    assert.equal(client.getStatusChecks().length, 0);
    PaymentProviderFactory._instance = previousProvider;
  }
}

test("durable recovery local: aprobado pre-expiry recupera grupo sin Sale/Status y es idempotente", async () => {
  const client = localRecoveryClient();
  const result = await recoverLocally(client);
  assert.equal(result.booking_confirmed, true);
  const payment = client.getPayments()[0];
  assert.equal(payment.provider_tx_id, "PAYMENT-UUID-NEW");
  assert.equal(payment.estado_pago_codigo, "capturado");
  assert.equal(payment.paid_at, durableApprovalFixture().finalized_at);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "confirmado");
  assert.equal(client.getActiveIntent().paid_at, payment.paid_at);
  assert.equal(client.getGroupState()[0].estado_cita_codigo, "confirmada");
  assert.equal(client.getGroupState()[0].estado_hold_codigo, "consumido");
  assert.equal(client.getGroupState()[0].estado_grupo_codigo, "activo");
  const afterFirst = client.calls.length;
  assert.equal((await recoverLocally(client)).duplicate, true);
  assert.equal(client.getPayments().length, 1);
  assert.equal(client.calls.filter((call) => call.sql.includes("app_private.confirmar_reserva_pagada_v1")).length, 1);
  assert.doesNotMatch(client.calls.slice(afterFirst).map((call) => call.sql).join("\n"),
    /INSERT INTO|UPDATE public\.|promociones|notificaciones_email|puntos/i);
  const approvalQuery = client.calls.findIndex((call) => call.sql.includes("AS finalized_at FROM"));
  assert.ok(client.calls.findIndex((call) => call.sql.includes("FOR UPDATE OF h")) < approvalQuery);
});

for (const [name, approvalOverride] of invalidApprovals) {
  test(`durable recovery local rechaza ${name}, incluso con hold vigente`, async () => {
    for (const expired of [true, false]) {
      const client = localRecoveryClient({
        ...(expired ? {} : { groupCitaState: "pendiente_pago", groupHoldState: "activo", groupStateCode: "activo" }),
        initialSaleAttempts: approvalOverride === null ? [] : [durableApprovalFixture(approvalOverride)],
      });
      const result = await recoverLocally(client);
      assert.equal(result.manual_reconciliation_required, true);
      assert.equal(client.getPayments().length, 0);
      assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
      assert.doesNotMatch(client.calls.map((call) => call.sql).join("\n"), /INSERT INTO|UPDATE public\./);
    }
  });
}

for (const [name, intentOverride] of [
  ["UUID ausente", { provider_session_id: null }],
  ["transactionId ausente", { referencia_externa: null }],
  ["referencias iguales", { referencia_externa: "PAYMENT-UUID-NEW" }],
  ["intent fallido", { estado_intent_codigo: "fallido" }],
  ["monto diferente", { monto_hnl: "114.00" }],
]) {
  test(`durable recovery local rechaza ${name}`, async () => {
    const client = localRecoveryClient({ existingIntent: reconciliationIntent(intentOverride) });
    assert.equal((await recoverLocally(client)).manual_reconciliation_required, true);
    assert.equal(client.getPayments().length, 0);
  });
}

for (const state of ["cancelada", "cancelada_por_cliente", "anulada", "no_show", "completada"]) {
  test(`durable recovery local no revive cita ${state}`, async () => {
    const client = localRecoveryClient({ groupCitaState: state });
    assert.equal((await recoverLocally(client)).manual_reconciliation_required, true);
    assert.equal(client.getPayments().length, 0);
    assert.equal(client.getGroupState()[0].estado_cita_codigo, state);
  });
}

test("durable recovery local rechaza evidencia ambigua (dos aprobaciones compatibles)", async () => {
  const client = localRecoveryClient({ initialSaleAttempts: [durableApprovalFixture(), durableApprovalFixture()] });
  assert.equal((await recoverLocally(client)).manual_reconciliation_required, true);
  assert.equal(client.getPayments().length, 0);
});

test("durable recovery local usa solo referencias DB e ignora paidAt/monto/UUID del caller", async () => {
  const client = localRecoveryClient({ groupStateCode: "activo", groupCitaState: "pendiente_pago",
    groupHoldState: "activo", holdExpiresAt: "2099-01-01T16:00:00.000Z" });
  const result = await recoverLocally(client, { paymentUuid: "OTRO-UUID", providerTransactionId: "OTRA-TX",
    paidAt: "2099-01-01T00:00:00Z", expectedAmount: 1 });
  assert.equal(result.booking_confirmed, true);
  assert.equal(client.getPayments()[0].provider_tx_id, "PAYMENT-UUID-NEW");
  assert.equal(client.getPayments()[0].paid_at, durableApprovalFixture().finalized_at);
  assert.equal(client.getPayments()[0].monto_hnl, 115);
});

test("durable recovery local valida titular y pertenencia del intent sin escrituras", async () => {
  const client = localRecoveryClient();
  await assert.rejects(recoverLocally(client, { titularEmail: "otra-persona@example.com" }),
    (error) => error.code === "PUBLIC_PAGOS_GROUP_FORBIDDEN");
  const mismatched = localRecoveryClient({ existingIntent: reconciliationIntent({ id_grupo_cita: CITA_B }) });
  await assert.rejects(recoverLocally(mismatched), (error) => error.code === "PUBLIC_PAGOS_INTENT_GROUP_MISMATCH");
  assert.equal(client.getPayments().length, 0);
  assert.equal(mismatched.getPayments().length, 0);
});

test("durable recovery local exige el menor expiry de todos los holds", async () => {
  const client = localRecoveryClient({ groupSize: 2, secondHoldState: "expirado",
    secondHoldExpiresAt: "2020-01-01T15:58:00.000Z", existingIntent: reconciliationIntent({ monto_hnl: "230.00" }) });
  assert.equal((await recoverLocally(client)).manual_reconciliation_required, true);
  assert.equal(client.getPayments().length, 0);
  const evidence = client.calls.find((call) => call.sql.includes("AS finalized_at FROM"));
  assert.equal(evidence.params[1], "2020-01-01T15:58:00.000Z");
});

test("durable recovery local rechaza payment previo de monto incorrecto", async () => {
  const client = localRecoveryClient({ initialPayments: [{ id_intent: INTENT_A, provider_tx_id: "PAYMENT-UUID-NEW",
    estado_pago_codigo: "capturado", monto_hnl: 114, moneda_codigo: "HNL" }] });
  assert.equal((await recoverLocally(client)).manual_reconciliation_required, true);
  assert.equal(client.getPayments().length, 1);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
});

test("durable recovery local protege slot reutilizado con rollback completo", async () => {
  const client = localRecoveryClient({ slotReused: true });
  await assert.rejects(recoverLocally(client), (error) => error.code === "PAYMENT_SLOT_ALREADY_RELEASED");
  assert.equal(client.getPayments().length, 0);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "pendiente_confirmacion");
  assert.equal(client.getGroupState()[0].estado_cita_codigo, "expirada");
  assert.equal(client.getGroupState()[0].estado_hold_codigo, "expirado");
  assert.equal(client.getGroupState()[0].estado_grupo_codigo, "cancelado");
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
});

test("durable recovery local acepta payment legacy del mismo intent sin segundo payment", async () => {
  const legacy = { id_intent: INTENT_A, provider_tx_id: "TX-SANDBOX-REPEATED", estado_pago_codigo: "capturado",
    monto_hnl: 115, moneda_codigo: "HNL" };
  const client = localRecoveryClient({ initialPayments: [legacy] });
  assert.equal((await recoverLocally(client)).duplicate, true);
  assert.equal((await recoverLocally(client)).duplicate, true);
  assert.deepEqual(client.getPayments(), [legacy]);
  assert.equal(client.calls.filter((call) => call.sql.includes("app_private.confirmar_reserva_pagada_v1")).length, 1);
});

test("durable recovery local fixture real QA preserva microsegundos e ignora colision historica transactionId", async () => {
  const idIntent = "9b1626eb-0c04-4ce3-ae93-5296ddcb02fe";
  const groupId = "1cc40753-b888-4452-82b5-8e384d590fbc";
  const citaId = "05f53173-ab1a-4b35-8a70-88f2f40d22f2";
  const holdId = "1dcc3717-bec0-4b31-be58-20f0821c947a";
  const uuid = "S-a2f5612c-5084-4134-ad5f-feeb0ae6d8c8";
  const tx = "1f694eee-4715-45b8-a545-000000000000";
  const finalizedAt = "2026-10-11T19:43:29.880935Z";
  const historical = { id_intent: CITA_B, provider_tx_id: tx, estado_pago_codigo: "capturado" };
  const client = localRecoveryClient({ groupId, citaId, holdId, amountHnl: 1,
    holdExpiresAt: "2026-10-11T19:48:29.071048Z", ownerEmail: "jorgedavidcarbajal1960@gmail.com",
    existingIntent: reconciliationIntent({ id_intent: idIntent, id_grupo_cita: groupId, id_cita: citaId, id_hold: holdId,
      provider_session_id: uuid, referencia_externa: tx, monto_hnl: "1.00" }),
    initialSaleAttempts: [durableApprovalFixture({ id_intent: idIntent, finalized_at: finalizedAt })],
    initialPayments: [historical],
  });
  assert.equal((await recoverLocally(client, { idGrupoCita: groupId, idIntent, titularEmail: "jorgedavidcarbajal1960@gmail.com" })).booking_confirmed, true);
  assert.deepEqual(client.getPayments()[0], historical);
  assert.equal(client.getPayments().length, 2);
  assert.equal(client.getPayments()[1].provider_tx_id, uuid);
  assert.equal(client.getPayments()[1].paid_at, finalizedAt);
  assert.equal(client.getPayments()[1].monto_hnl, 1);
  assert.equal(client.getActiveIntent().referencia_externa, tx);
  assert.equal(client.getActiveIntent().paid_at, finalizedAt);
});

test("pagos autenticados exigen propiedad de cliente, persona e intent", async () => {
  const existingIntent = {
    id_intent: INTENT_A,
    id_provider: PROVIDER_A,
    id_cita: CITA_A,
    id_hold: HOLD_A,
    id_grupo_cita: GROUP_A,
    estado_intent_codigo: "pendiente_confirmacion",
    expires_at: "2099-01-01T16:00:00.000Z",
    monto_hnl: "115.00",
    moneda_codigo: "HNL",
    created_by_usuario_id: USER_A,
  };
  const client = createPagosClient({
    providerCode: "pixelpay",
    existingIntent,
    groupClientId: CLIENT_A,
    groupPersonId: USER_A,
    groupUserId: USER_A,
    groupOrigin: "cliente_autenticado",
  });
  const ownerClaims = {
    cliente_id: CLIENT_A,
    user: { id_persona: USER_A, id_usuario: USER_A },
  };
  const app = await createPagosApp(client, {
    providerCode: "pixelpay",
    authenticated: true,
    claims: ownerClaims,
  });

  const owned = await app.inject({
    method: "POST",
    url: "/v1/pagos/reservas/estado",
    payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
  });
  assert.equal(owned.statusCode, 200, owned.body);

  await app.close();
  const foreignApp = await createPagosApp(client, {
    providerCode: "pixelpay",
    authenticated: true,
    claims: { ...ownerClaims, cliente_id: CLIENT_B },
  });
  const foreign = await foreignApp.inject({
    method: "POST",
    url: "/v1/pagos/reservas/estado",
    payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
  });
  assert.equal(foreign.statusCode, 403, foreign.body);
  assert.equal(foreign.json().error.code, "PUBLIC_PAGOS_GROUP_FORBIDDEN");
  await foreignApp.close();

  const foreignPersonApp = await createPagosApp(client, {
    providerCode: "pixelpay",
    authenticated: true,
    claims: { ...ownerClaims, user: { ...ownerClaims.user, id_persona: USER_B } },
  });
  const foreignPerson = await foreignPersonApp.inject({
    method: "POST",
    url: "/v1/pagos/reservas/estado",
    payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
  });
  assert.equal(foreignPerson.statusCode, 403, foreignPerson.body);
  assert.equal(foreignPerson.json().error.code, "PUBLIC_PAGOS_GROUP_FORBIDDEN");
  await foreignPersonApp.close();

  const foreignUserApp = await createPagosApp(client, {
    providerCode: "pixelpay",
    authenticated: true,
    claims: { ...ownerClaims, user: { ...ownerClaims.user, id_usuario: USER_B } },
  });
  const foreignUser = await foreignUserApp.inject({
    method: "POST",
    url: "/v1/pagos/reservas/estado",
    payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
  });
  assert.equal(foreignUser.statusCode, 403, foreignUser.body);
  assert.equal(foreignUser.json().error.code, "PUBLIC_PAGOS_GROUP_FORBIDDEN");
  await foreignUserApp.close();

  const noContextApp = await createPagosApp(client, {
    providerCode: "pixelpay",
    authenticated: true,
    claims: {},
  });
  const noContext = await noContextApp.inject({
    method: "POST",
    url: "/v1/pagos/reservas/estado",
    payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
  });
  assert.equal(noContext.statusCode, 409, noContext.body);
  assert.equal(noContext.json().error.code, "PAGOS_CLIENT_CONTEXT_REQUIRED");
  await noContextApp.close();

  const foreignIntentClient = createPagosClient({
    providerCode: "pixelpay",
    existingIntent: { ...existingIntent, created_by_usuario_id: USER_B },
    groupClientId: CLIENT_A,
    groupPersonId: USER_A,
    groupUserId: USER_A,
    groupOrigin: "cliente_autenticado",
  });
  const foreignIntentApp = await createPagosApp(foreignIntentClient, {
    providerCode: "pixelpay",
    authenticated: true,
    claims: ownerClaims,
  });
  const foreignIntent = await foreignIntentApp.inject({
    method: "POST",
    url: "/v1/pagos/reservas/estado",
    payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
  });
  assert.equal(foreignIntent.statusCode, 403, foreignIntent.body);
  assert.equal(foreignIntent.json().error.code, "PAGOS_INTENT_FORBIDDEN");
  await foreignIntentApp.close();
});

test("crear intent autenticado atribuye el intent al usuario de la sesion", async () => {
  const client = createPagosClient({
    providerCode: "pixelpay",
    groupClientId: CLIENT_A,
    groupPersonId: USER_A,
    groupUserId: USER_B,
    groupOrigin: "cliente_autenticado",
  });
  const app = await createPagosApp(client, {
    providerCode: "pixelpay",
    authenticated: true,
    claims: {
      cliente_id: CLIENT_A,
      user: { id_persona: USER_A, id_usuario: USER_B },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/pagos/reservas/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 201, response.body);
  const intentInsert = client.calls.find((call) => call.sql.includes("INSERT INTO public.payment_intents"));
  assert.equal(intentInsert?.params[7], USER_B);
  await app.close();
});

test("reserva publica con cliente persistido crea y consulta su intent", async () => {
  const client = createPagosClient({
    providerCode: "pixelpay",
    groupClientId: CLIENT_A,
    groupOrigin: "publico",
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay" });

  const created = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });
  assert.equal(created.statusCode, 201, created.body);

  const status = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/estado",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: created.json().data.id_intent,
      titular_email: "cliente@example.com",
    },
  });
  assert.equal(status.statusCode, 200, status.body);
  const groupLoad = client.calls.find((call) => call.sql.includes("FROM public.citas_grupos cg"));
  assert.match(groupLoad?.sql || "", /cg\.origen_codigo/);
  assert.match(groupLoad?.sql || "", /cg\.id_usuario_titular/);
  await app.close();
});

test("endpoint autenticado rechaza una reserva publica", async () => {
  const client = createPagosClient({
    providerCode: "pixelpay",
    groupClientId: CLIENT_A,
    groupOrigin: "publico",
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
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, {
    providerCode: "pixelpay",
    authenticated: true,
    claims: {
      cliente_id: CLIENT_A,
      user: { id_persona: USER_A, id_usuario: USER_A },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/pagos/reservas/estado",
    payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, "PAGOS_AUTHENTICATED_GROUP_REQUIRED");
  await app.close();
});

for (const groupOrigin of [null, "legacy", "admin", "panel", "barbero", "sistema"]) {
  test(`endpoint publico rechaza origen ambiguo ${groupOrigin ?? "null"}`, async () => {
    const client = createPagosClient({
      providerCode: "pixelpay",
      groupClientId: CLIENT_A,
      groupOrigin,
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
        created_by_usuario_id: USER_A,
      },
    });
    const app = await createPagosApp(client, { providerCode: "pixelpay" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/public/pagos/estado",
      payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "PUBLIC_PAGOS_GROUP_ORIGIN_UNSUPPORTED");
    await app.close();
  });
}

test("rutas publicas no operan grupos de clientes autenticados", async () => {
  const client = createPagosClient({
    providerCode: "pixelpay",
    groupClientId: CLIENT_A,
    groupUserId: USER_A,
    groupOrigin: "cliente_autenticado",
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
      created_by_usuario_id: USER_A,
    },
  });
  const app = await createPagosApp(client, { providerCode: "pixelpay" });
  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/estado",
    payload: { id_grupo_cita: GROUP_A, id_intent: INTENT_A, titular_email: "cliente@example.com" },
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_AUTHENTICATED_GROUP_REQUIRED");
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
    groupClientId: CLIENT_A,
    groupOrigin: "publico",
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
  assert.equal(client.getPayments()[0].provider_tx_id, "payment-uuid-paid-qa");
  assert.ok(Number.isFinite(Date.parse(client.getPayments()[0].paid_at)));
  assert.equal(client.getPayments()[0].monto_hnl, 115);
  assert.equal(client.getPayments()[0].moneda_codigo, "HNL");
  assert.equal(client.getActiveIntent().provider_session_id, "payment-uuid-paid-qa");
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
  assert.equal(client.getPayments()[0].provider_tx_id, "payment-uuid-concurrent-qa");
  assert.equal(client.calls.filter((call) => call.sql.includes("app_private.confirmar_reserva_pagada_v1")).length, 1);
  assert.equal(client.getActiveIntent().estado_intent_codigo, "confirmado");
  await app.close();
});

test("POST estado conserva pendiente_confirmacion sin exponer el correo en URL ni logs", async () => {
  const logs = [];
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
  const app = await createPagosApp(client, { providerCode: "pixelpay", logs });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/estado",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.estado_intent_codigo, "pendiente_confirmacion");
  assert.equal(response.json().data.booking_confirmed, false);
  const output = logs.join("");
  assert.match(output, /\/v1\/public\/pagos\/estado/);
  assert.doesNotMatch(output, /cliente@example\.com|titular_email/i);
  await app.close();
});

test("estado rechaza GET heredado y un body invalido sin registrar PII", async () => {
  const logs = [];
  const client = createPagosClient({ providerCode: "pixelpay" });
  const app = await createPagosApp(client, { providerCode: "pixelpay", logs });

  const legacyResponse = await app.inject({
    method: "GET",
    url: "/v1/public/pagos/estado",
  });
  const invalidResponse = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/estado",
    payload: {
      id_grupo_cita: GROUP_A,
      id_intent: INTENT_A,
      titular_email: "correo-invalido",
    },
  });

  assert.equal(legacyResponse.statusCode, 404, legacyResponse.body);
  assert.equal(invalidResponse.statusCode, 400, invalidResponse.body);
  const output = logs.join("");
  assert.doesNotMatch(output, /correo-invalido/i);
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
