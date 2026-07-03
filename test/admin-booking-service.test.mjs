import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_BOOKING_HOLD_IDEMPOTENCY_SCOPE,
  ADMIN_BOOKING_ORIGIN_CODE,
  ADMIN_BOOKING_UNPAID_PAYMENT_STATE,
  assertAdminBookingRole,
  assertAdminBenefitRequestAllowed,
  confirmAdminBookingHold,
  normalizeAdminHoldCloseBody,
  normalizeAdminBookingBody,
} from "../src/services/booking/adminBookingService.js";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";
const BARBER_ID = "44444444-4444-4444-8444-444444444444";
const GROUP_ID = "55555555-5555-4555-8555-555555555555";
const PERSON_ID = "66666666-6666-4666-8666-666666666666";
const USER_ID = "77777777-7777-4777-8777-777777777777";

function baseBody(overrides = {}) {
  return {
    id_sucursal: BRANCH_ID,
    id_cliente: CLIENT_ID,
    integrantes: [
      {
        fecha_inicio: "2026-07-10T15:00:00.000Z",
        servicios: [SERVICE_ID],
        id_barbero: BARBER_ID,
      },
    ],
    ...overrides,
  };
}

test("contrato administrativo usa scope y origen propios", () => {
  assert.equal(ADMIN_BOOKING_HOLD_IDEMPOTENCY_SCOPE, "admin:citas:hold");
  assert.equal(ADMIN_BOOKING_ORIGIN_CODE, "admin");
  assert.equal(ADMIN_BOOKING_UNPAID_PAYMENT_STATE, null);
});

test("assertAdminBookingRole permite admin y super_admin solamente", () => {
  assert.equal(assertAdminBookingRole({ roles: ["admin"], user: { id_usuario: CLIENT_ID } }).role, "admin");
  assert.equal(assertAdminBookingRole({ roles: ["super_admin"] }).role, "super_admin");
  assert.throws(
    () => assertAdminBookingRole({ roles: ["barbero"] }),
    /No tienes permisos/
  );
});

test("normalizeAdminBookingBody acepta cliente existente y mantiene beneficios para confirmacion posterior", () => {
  const normalized = normalizeAdminBookingBody(baseBody({ metodo_pago_codigo: "efectivo" }));
  assert.equal(normalized.idSucursal, BRANCH_ID);
  assert.equal(normalized.idCliente, CLIENT_ID);
  assert.equal(normalized.metodoPagoCodigo, null);
  assert.equal(normalized.integrantes[0].id_barbero, BARBER_ID);
  assert.deepEqual(normalized.integrantes[0].serviceIds, [SERVICE_ID]);
});

test("normalizeAdminBookingBody acepta crear ficha interna sin cuenta", () => {
  const normalized = normalizeAdminBookingBody(baseBody({
    id_cliente: null,
    cliente_nuevo: {
      nombres: "Ana",
      apellidos: "Lopez",
      telefono_principal: "9999 0000",
      correo_principal: "ANA@EXAMPLE.COM",
    },
  }));
  assert.equal(normalized.idCliente, null);
  assert.equal(normalized.clienteNuevo.correo_principal, "ana@example.com");
  assert.equal(normalized.clienteNuevo.telefono_principal, "9999 0000");
});

test("normalizeAdminBookingBody rechaza release_token y datos de tarjeta", () => {
  assert.throws(
    () => normalizeAdminBookingBody(baseBody({ release_token: "token" })),
    /release_token/
  );
  assert.equal(normalizeAdminBookingBody(baseBody({ membresia: { aplicar: true } })).beneficios.membresia.aplicar, true);
  assert.throws(
    () => normalizeAdminBookingBody(baseBody({ pago: { pan: "4111111111111111", cvv: "123" } })),
    /datos sensibles de tarjeta/
  );
});

test("normalizeAdminHoldCloseBody valida intencion, consentimiento y motivo", () => {
  assert.equal(normalizeAdminHoldCloseBody({ metodo_pago_codigo: "efectivo" }).metodoPagoCodigo, "efectivo");
  assert.throws(
    () => normalizeAdminHoldCloseBody({ metodo_pago_codigo: "tarjeta" }),
    /intencion administrativa/
  );
  assert.throws(
    () => normalizeAdminHoldCloseBody({ metodo_pago_codigo: "cortesia" }, { requireReason: true }),
    /motivo/
  );
  assert.deepEqual(
    normalizeAdminHoldCloseBody({
      metodo_pago_codigo: "recompensa",
      consentimiento: { metodo: "WhatsApp", referencia: "ok cliente", confirmado: true },
    }).consentimiento,
    { metodo: "whatsapp", referencia: "ok cliente", confirmado: true }
  );
});

test("assertAdminBenefitRequestAllowed protege promocion manual, recompensa y cortesia por rol", () => {
  const adminContext = { role: "admin", isSuperAdmin: false };
  const superContext = { role: "super_admin", isSuperAdmin: true };
  assert.throws(
    () => assertAdminBenefitRequestAllowed({
      beneficios: { promocionManualId: "promo-1", promocionManualMotivo: "cliente molesto" },
    }, adminContext),
    /promociones manuales/
  );
  assert.throws(
    () => assertAdminBenefitRequestAllowed({
      beneficios: { promocionManualId: "promo-1" },
    }, superContext),
    /motivo/
  );
  assert.throws(
    () => assertAdminBenefitRequestAllowed({
      beneficios: { recompensa: { aplicar: true } },
    }, adminContext),
    /consentimiento/
  );
  assert.throws(
    () => assertAdminBenefitRequestAllowed({
      beneficios: { cortesia: { aplicar: true, tipo: "total", valor: 100, motivo: "VIP" } },
    }, adminContext),
    /cortesias/
  );
  assert.doesNotThrow(() => assertAdminBenefitRequestAllowed({
    beneficios: {
      promocionManualId: "promo-1",
      promocionManualMotivo: "retencion",
      recompensa: {
        aplicar: true,
        consentimiento: { confirmado: true, medio: "presencial" },
      },
      cortesia: { aplicar: true, tipo: "porcentaje", valor: 50, motivo: "garantia" },
    },
  }, superContext));
});

function createAdminConfirmClient({ failOnGroupComplete = false } = {}) {
  const calls = [];
  const client = {
    calls,
    released: false,
    async query(sql, params = []) {
      const text = String(sql).trim();
      calls.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT") || text.startsWith("ROLLBACK TO SAVEPOINT")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.sucursales")) {
        return { rows: [{ id_sucursal: BRANCH_ID, nombre_sucursal: "Central" }], rowCount: 1 };
      }
      if (text.includes("FROM public.citas_grupos cg") && text.includes("FOR UPDATE")) {
        return { rows: [{ id_grupo_cita: GROUP_ID, estado_grupo_codigo: "activo" }], rowCount: 1 };
      }
      if (text.includes("BOOL_OR(c.estado_cita_codigo")) {
        return {
          rows: [{
            id_sucursal: BRANCH_ID,
            id_cliente: CLIENT_ID,
            id_persona: PERSON_ID,
            citas_count: 1,
            total_pagar_hnl: 150,
            has_confirmed: false,
            has_consumed_hold: false,
            has_active_hold: true,
          }],
          rowCount: 1,
        };
      }
      if (text.startsWith("SELECT id_cita")) {
        return { rows: [{ id_cita: "88888888-8888-4888-8888-888888888888" }], rowCount: 1 };
      }
      if (text.startsWith("UPDATE public.citas") && text.includes("SET estado_cita_codigo = 'confirmada'")) {
        return { rows: [{ id_cita: "88888888-8888-4888-8888-888888888888", estado_cita_codigo: "confirmada" }], rowCount: 1 };
      }
      if (text.startsWith("UPDATE public.citas_holds")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE public.payment_intents")) return { rows: [], rowCount: 0 };
      if (text.startsWith("INSERT INTO public.audit_logs")) return { rows: [], rowCount: 1 };
      if (text.startsWith("UPDATE public.citas_grupos")) {
        if (failOnGroupComplete) throw new Error("group update failed");
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("promociones_usos")) return { rows: [], rowCount: 0 };
      if (text.startsWith("INSERT INTO public.seguridad_audit_logs")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {
      this.released = true;
    },
  };
  return client;
}

function createAdminConfirmApp(client) {
  return {
    db: {
      connect: async () => client,
    },
  };
}

function adminConfirmRequest(body = {}) {
  return {
    id: "req-admin-confirm",
    ip: "127.0.0.1",
    params: { idGrupoCita: GROUP_ID },
    body,
    claims: {
      roles: ["super_admin"],
      user: { id_usuario: USER_ID },
    },
  };
}

test("confirmAdminBookingHold efectivo confirma cita sin inventar estado de pago", async () => {
  const client = createAdminConfirmClient();
  const result = await confirmAdminBookingHold(
    createAdminConfirmApp(client),
    adminConfirmRequest({ metodo_pago_codigo: "efectivo", motivo: "cobro en caja" })
  );

  assert.equal(result.estado_cita_codigo, "confirmada");
  assert.equal(result.estado_hold_codigo, "consumido");
  assert.equal(result.metodo_pago_codigo, "efectivo");
  assert.equal(result.estado_pago_codigo, null);
  assert.equal(result.pago_registrado, false);
  assert.equal(result.monto_cobrado_hnl, 0);
  assert.equal(client.calls.filter((call) => call.sql === "BEGIN").length, 1);
  assert.equal(client.calls.filter((call) => call.sql === "COMMIT").length, 1);
  assert.equal(client.calls.filter((call) => call.sql === "ROLLBACK").length, 0);
  assert.equal(client.released, true);

  const audit = client.calls.find((call) => call.sql.startsWith("INSERT INTO public.seguridad_audit_logs"));
  const metadata = JSON.parse(audit.params[7]);
  assert.equal(metadata.metodo_pago_codigo, "efectivo");
  assert.equal(metadata.estado_pago_codigo, null);
  assert.equal(metadata.rol, "super_admin");
});

test("confirmAdminBookingHold cobertura registra fuente sin crear pago", async () => {
  const client = createAdminConfirmClient();
  const result = await confirmAdminBookingHold(
    createAdminConfirmApp(client),
    adminConfirmRequest({ metodo_pago_codigo: "membresia" })
  );

  assert.equal(result.estado_cita_codigo, "confirmada");
  assert.equal(result.estado_pago_codigo, null);
  assert.equal(result.fuente_cobertura_codigo, "membresia");
  assert.equal(result.pago_registrado, false);
});

test("confirmAdminBookingHold ejecuta rollback ante fallo transaccional", async () => {
  const client = createAdminConfirmClient({ failOnGroupComplete: true });
  await assert.rejects(
    () => confirmAdminBookingHold(
      createAdminConfirmApp(client),
      adminConfirmRequest({ metodo_pago_codigo: "sin_pago" })
    ),
    /No se pudo confirmar el hold administrativo/
  );

  assert.equal(client.calls.filter((call) => call.sql === "BEGIN").length, 1);
  assert.equal(client.calls.filter((call) => call.sql === "COMMIT").length, 0);
  assert.equal(client.calls.filter((call) => call.sql === "ROLLBACK").length, 1);
  assert.equal(client.released, true);
});
