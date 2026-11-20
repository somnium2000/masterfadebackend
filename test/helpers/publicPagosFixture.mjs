import assert from 'node:assert/strict';
import Fastify from 'fastify';
import publicPagosRoutes, { buildProviderOrderReference } from '../../src/routes/v1/public/pagos.js';
import { PaymentProviderFactory } from '../../src/services/payments/PaymentProviderFactory.js';
import { createPublicPixelPay3dsAttempts } from '../../src/services/payments/publicPixelPay3ds.js';
import { installPrivatePilot } from './privatePilotApp.mjs';
import { QA_PIXELPAY_CASE29_VISA } from '../fixtures/qa-pixelpay-case29.mjs';

// AM: Shared synthetic DB and real route composition for route and browser/worker integration checks.
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
  initialPaymentEvents = [],
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
  optionsPublic3ds = false,
} = {}) {
  const calls = [];
  const statusChecks = [];
  const payments = structuredClone(initialPayments);
  const paymentEvents = structuredClone(initialPaymentEvents);
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
    getPaymentEvents() {
      return structuredClone(paymentEvents);
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
      if (text.includes('WITH verified_sale AS (') && text.includes('UPDATE public.payment_events callback')) return { rows: [] };
      if (text === "BEGIN") {
        transactionSnapshot = structuredClone({ activeIntent, groupState, payments, paymentEvents, saleAttempts, groupStateCode });
        return { rows: [] };
      }
      if (text === "COMMIT") { transactionSnapshot = null; return { rows: [] }; }
      if (text === "ROLLBACK") {
        if (transactionSnapshot) {
          activeIntent = transactionSnapshot.activeIntent;
          groupState.splice(0, groupState.length, ...transactionSnapshot.groupState);
          payments.splice(0, payments.length, ...transactionSnapshot.payments);
          paymentEvents.splice(0, paymentEvents.length, ...transactionSnapshot.paymentEvents);
          saleAttempts = transactionSnapshot.saleAttempts;
          groupStateCode = transactionSnapshot.groupStateCode;
          transactionSnapshot = null;
        }
        return { rows: [] };
      }
      if (text.includes("'pixelpay.sale.3ds_continuation_dispatched'")) {
        const [idIntent, idAttempt, deadline, order, amount, currency] = params;
        const providerEventId = `pixelpay_public_3ds_continue_${idIntent}`;
        const attempt = saleAttempts.find(row => row.id_intent === idIntent && row.payment_attempt_id === idAttempt);
        if (!attempt || attempt.upstream_http_status !== 202 || attempt.finalized_at
          || activeIntent?.estado_intent_codigo !== 'pendiente_confirmacion'
          || activeIntent.orden_compra !== order || Number(activeIntent.monto_hnl) !== amount
          || activeIntent.moneda_codigo !== currency || activeIntent.provider_session_id || activeIntent.referencia_externa
          || Date.parse(activeIntent.expires_at) <= Date.now() || Date.parse(deadline) <= Date.now()
          || paymentEvents.some(row => row.provider_event_id === providerEventId)) return { rows: [] };
        paymentEvents.push({ id_intent: idIntent, id_provider: activeIntent.id_provider, provider_event_id: providerEventId,
          evento_tipo: 'pixelpay.sale.3ds_continuation_dispatched', firma_valida: false });
        return { rows: [{ id_event: providerEventId }] };
      }
      if (text.includes("INSERT INTO app_private.pixelpay_sale_attempts")) {
        if (failAttemptStart) throw new Error("fixture de fallo en INSERT START");
        assert.ok(transactionSnapshot, "START debe compartir la transaccion del claim");
        const row = {
          id_sale_attempt: params[1], id_intent: params[0], payment_attempt_id: params[1],
          request_id: params[2], card_expire_format_valid: params[3], card_expire_future: params[4],
          billing_address_length: params[5], finalized_at: null,
          qa_test_origin: params[6] || null,
        };
        saleAttempts.push(row);
        return { rows: [{ id_sale_attempt: row.id_sale_attempt }] };
      }
      if (text.includes("SELECT to_jsonb(a)->>'qa_test_origin'")) {
        return { rows: saleAttempts.filter(row=>row.id_intent===params[0]&&row.qa_test_origin)
          .map(row=>({qa_test_origin:row.qa_test_origin})).slice(0,1) };
      }
      if (text.includes('SELECT EXISTS(SELECT 1 FROM app_private.pixelpay_sale_attempts WHERE id_intent=')) {
        return { rows: [{ attempted: saleAttempts.some(row=>row.id_intent===params[0]) }] };
      }
      if (text.includes("UPDATE app_private.pixelpay_sale_attempts")) {
        if (!text.includes("SET finalized_at")) {
          const row = saleAttempts.find(entry => entry.id_intent === params[0] && entry.payment_attempt_id === params[1]);
          if (row) {
            row.observed_payment_uuid_untrusted = params[2];
            if (text.includes('SET upstream_http_status = 202')) {
              row.upstream_http_status = 202;
              return { rows: [{ payment_attempt_id: row.payment_attempt_id }] };
            }
          }
          return { rows: [] };
        }
        const target = saleAttempts.find(entry => entry.payment_attempt_id === params[0]);
        if (target?.qa_test_origin !== '3ds_diagnostic' && !optionsPublic3ds) {
          assert.equal(transactionSnapshot, null, "FINAL ordinario debe usar autocommit fuera del claim");
        }
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
          response_success: params[13], transaction_result_valid: params[14],
          transaction_result_parsed: params[15], response_approved: params[16], response_incomplete: params[17],
          payment_uuid_present: params[19], transaction_id_present: params[20], payment_hash_present: params[21],
          payment_hash_valid: params[22], transaction_amount_matches: params[23], approved_amount_matches: params[24],
          amount_matches: params[25],
          final_parameters: structuredClone(params),
        });
        return { rows: [{ id_sale_attempt: row.id_sale_attempt }] };
      }
      if (text.includes('AS awaiting_authentication')) {
        return { rows: [{ awaiting_authentication: saleAttempts.some(row => row.id_intent === params[0]
          && (row.upstream_http_status === 202 || row.sdk_response_class === 'PayloadResponse')) }] };
      }
      if (text.includes("FROM app_private.pixelpay_sale_attempts")
        && text.includes("observed_payment_uuid_untrusted")) {
        return {
          rows: [...new Set(saleAttempts
            .filter((entry) => entry.id_intent === params[0]
              && entry.outcome === "uncertain"
              && entry.finalized_at
              && entry.observed_payment_uuid_untrusted)
            .map((entry) => entry.observed_payment_uuid_untrusted))]
            .map((observedPaymentUuid) => ({ observed_payment_uuid_untrusted: observedPaymentUuid })),
        };
      }
      if (text.includes("WITH approved_attempts AS")) {
        const flags = ["response_success", "response_approved", "transaction_result_valid", "transaction_result_parsed",
          "payment_uuid_present", "transaction_id_present", "payment_hash_present", "payment_hash_valid",
          "transaction_amount_matches", "approved_amount_matches", "amount_matches"];
        for (const flag of flags) assert.ok(text.includes(`${flag} IS TRUE`));
        assert.ok(text.includes("response_incomplete IS FALSE AND uncertain IS FALSE"));
        assert.ok(text.includes("finalized_at <= $2::timestamptz"));
        assert.ok(text.includes("(SELECT count(*) FROM approved_attempts) = 1"));
        assert.ok(text.includes("(SELECT count(*) FROM sale_events) = 1"));
        assert.ok(text.includes("SELECT min(h.expires_at)"));
        const rows = saleAttempts.filter((entry) => entry.id_intent === params[0] && entry.outcome === "approved"
          && entry.sdk_response_class === "SuccessResponse" && entry.upstream_http_status === 200
          && entry.finalized_at && new Date(entry.finalized_at).getTime() <= new Date(params[1]).getTime()
          && flags.every((flag) => entry[flag] === true) && entry.response_incomplete === false && entry.uncertain === false);
        const events = paymentEvents.filter((event) => {
          const payload = typeof event.payload_esencial === "string" ? JSON.parse(event.payload_esencial) : event.payload_esencial;
          return event.id_intent === params[0] && event.id_provider === activeIntent.id_provider
            && activeIntent.orden_compra === buildProviderOrderReference({ providerCode: "pixelpay", idIntent: activeIntent.id_intent })
            && groupState.some(row => row.id_cita === activeIntent.id_cita && row.id_grupo_cita === activeIntent.id_grupo_cita)
            && event.evento_tipo === "pixelpay.sale.approved_verified" && event.firma_valida === true
            && event.provider_event_id === `pixelpay_sale_${payload.payment_attempt_id}`
            && saleAttempts.some((attempt) => attempt.id_intent === event.id_intent && attempt.payment_attempt_id === payload.payment_attempt_id)
            && payload.payment_uuid === activeIntent.provider_session_id && payload.transaction_id === activeIntent.referencia_externa
            && typeof payload.amount === "number" && payload.amount === Number(activeIntent.monto_hnl)
            && payload.currency.toUpperCase() === activeIntent.moneda_codigo.toUpperCase()
            && payload.payment_hash_valid === true && payload.amount_matches === true;
        });
        const event = events[0];
        const payload = event && (typeof event.payload_esencial === "string" ? JSON.parse(event.payload_esencial) : event.payload_esencial);
        const inTime = event && new Date(event.recibido_at) <= new Date(params[1])
          && new Date(event.recibido_at) <= new Date(activeIntent.expires_at);
        return { rows: rows.length === 1 && events.length === 1 && inTime
          && rows[0].payment_attempt_id === payload.payment_attempt_id
          && (!params[2] || new Date(params[2]).getTime() === new Date(event.recibido_at).getTime())
          ? [{ finalized_at: rows[0].finalized_at, paid_at: event.recibido_at }] : [] };
      }
      if (text.includes('AS deletion_identity_lock')) return { rows: [{ deletion_identity_lock: true }] };
      if (text.includes('FOR SHARE OF c,u,p')) return { rows: [{ id_cliente: CLIENT_A }] };
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
          created_by_usuario_id: params[7],
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
      if (text.includes("UPDATE public.payment_intents SET estado_intent_codigo = 'fallido'")) {
        if (activeIntent?.id_intent !== params[0] || activeIntent?.id_grupo_cita !== params[1]
          || activeIntent.estado_intent_codigo !== 'pendiente_confirmacion') return { rows: [] };
        activeIntent.estado_intent_codigo = 'fallido';
        return { rows: [{ id_intent: params[0] }] };
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
        && text.includes("SET referencia_externa = $3, provider_session_id = $4")) {
        if (activeIntent?.estado_intent_codigo !== 'pendiente_confirmacion') return { rows: [] };
        activeIntent = { ...activeIntent, referencia_externa: params[2], provider_session_id: params[3] };
        return { rows: [{ id_intent: activeIntent.id_intent }] };
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
      if (text.includes("INSERT INTO public.payment_events")
        && text.includes("VALUES ($1::uuid, $2::text, $3::text, TRUE, $4::jsonb, $5::uuid)")) {
        if (!paymentEvents.some((row) => row.provider_event_id === params[1])) {
          paymentEvents.push({
            id_intent: params[4],
            id_provider: params[0],
            provider_event_id: params[1],
            evento_tipo: params[2],
            payload_esencial: structuredClone(params[3]),
            recibido_at: new Date().toISOString(),
          });
        }
        return { rows: [] };
      }
      if (text.includes("INSERT INTO public.payment_events") && text.includes("SELECT pi.id_provider")) {
        if (!paymentEvents.some((row) => row.provider_event_id === params[1])) {
          paymentEvents.push({
            id_intent: params[0],
            id_provider: activeIntent.id_provider,
            firma_valida: true,
            provider_event_id: params[1],
            evento_tipo: params[2],
            payload_esencial: params[3],
            recibido_at: new Date().toISOString(),
          });
        }
        return { rows: [] };
      }
      if (text.includes("min(pe.recibido_at)::text AS verified_at") && text.includes("FROM public.payment_events pe")) {
        const rows = paymentEvents
          .filter((row) => row.id_intent === params[0])
          .sort((a, b) => a.recibido_at.localeCompare(b.recibido_at));
        return { rows: [{ verified_at: rows[0]?.recibido_at ?? null }] };
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
  privatePilot = null,
  config = {},
  qa3dsDiagnostic = null,
  songbirdBridge = null,
  delegatedAttemptFactory = null,
  public3dsAttemptFactory = null,
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
  if (qa3dsDiagnostic) app.decorate('qaPixelPay3dsDiagnostic', qa3dsDiagnostic);
  if (delegatedAttemptFactory) app.decorate('qaPixelPayDelegated', qa3dsDiagnostic);
  if (songbirdBridge) app.decorate('songbirdBridge', songbirdBridge);
  app.decorate("config", {
    paymentProvider: providerCode,
    pixelPayEnv: "sandbox",
    todoPago: providerCode === "todopago"
      ? { mode: "preprod_simulated", simulatedEnabled: true }
      : null,
    qaPaymentSimulation: { enabled: providerCode === "todopago" },
    ...config,
  });
  if (!privatePilot) app.decorate("requireRoles", () => async (request) => {
    request.claims = claims;
  });
  app.decorate("db", {
    async connect() {
      return connectFactory ? connectFactory() : client;
    },
    async query(sql, params = []) {
      if (privatePilot?.publicCommerce && sql.includes("FROM public.clientes c") && sql.includes("c.anonimizado")) {
        return { rows: params[0] === CLIENT_A && params[1] === USER_A && params[2] === USER_A
          ? [{ id_cliente: CLIENT_A }] : [] };
      }
      return client.query(sql, params);
    },
  });
  if (privatePilot?.publicCommerce) app.config.publicCommerce = privatePilot.publicCommerce;
  if (privatePilot) app.pilotRequest = await installPrivatePilot(app, privatePilot.t, {
    userId: USER_A, clientId: CLIENT_A, enabled: privatePilot.enabled ?? true,
  });
  if (public3dsAttemptFactory) {
    const manager = createPublicPixelPay3dsAttempts({
      db: app.db, environment: app.config.pixelPayEnv, makeAttempt: public3dsAttemptFactory,
    });
    if (privatePilot) app.publicPixelPay3ds = manager;
    else app.decorate('publicPixelPay3ds', manager);
    app.addHook('onClose', async () => manager.close());
  }
  await app.register(publicPagosRoutes, {
    prefix: authenticated ? "/v1/pagos/reservas" : "/v1/public/pagos",
    authenticated,
    ...(delegatedAttemptFactory ? { delegatedAttemptFactory } : {}),
  });
  return app;
}

function diagnosticRouteClient({intentPatch={},...options}={}) {
  return createPagosClient({providerCode:'pixelpay',amountHnl:1,groupClientId:CLIENT_A,groupPersonId:USER_A,groupUserId:USER_A,
    groupOrigin:'cliente_autenticado',existingIntent:{id_intent:INTENT_A,id_provider:PROVIDER_A,id_cita:CITA_A,id_hold:HOLD_A,
      id_grupo_cita:GROUP_A,estado_intent_codigo:'link_generado',expires_at:'2099-01-01T16:00:00.000Z',monto_hnl:'1.00',moneda_codigo:'HNL',
      orden_compra:buildProviderOrderReference({providerCode:'pixelpay',idIntent:INTENT_A}),created_by_usuario_id:USER_A,...intentPatch},...options});
}
const diagnosticOwnerClaims={cliente_id:CLIENT_A,user:{id_usuario:USER_A,id_persona:USER_A}};
const diagnosticCard={card_number:QA_PIXELPAY_CASE29_VISA};
const diagnosticPayload=()=>({...pixelPaySalePayload(),...diagnosticCard,card_expire:'2812'});


export { GROUP_A, CITA_A, HOLD_A, CITA_B, HOLD_B, BRANCH_A, BARBER_A, SERVICE_A, DETAIL_A, PROVIDER_A, USER_A, USER_B, CLIENT_A, CLIENT_B, INTENT_A, PROMO_A, PROMO_RULE_A, pixelPaySalePayload, makeGroupRow, createPagosClient, createPagosApp, diagnosticRouteClient, diagnosticOwnerClaims, diagnosticCard, diagnosticPayload };
