import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateDiscount,
  evaluatePromotions,
  resolvePromotionConflicts,
  validatePromotionCandidate,
} from "../src/services/promociones/promocionesEngine.js";
import { isGroupScopedBonificationPromotion } from "../src/services/promociones/promocionesService.js";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const OTHER_SERVICE = "22222222-2222-4222-8222-222222222222";

function line({ key, service = SERVICE, price, quantity = 1, appointment = "cita-a", member = "member-a" }) {
  return {
    line_key: key,
    id_servicio: service,
    id_cita: appointment,
    id_cita_integrante: member,
    cantidad: quantity,
    precio_unitario_hnl: price,
    subtotal_hnl: price * quantity,
    base_disponible_hnl: price * quantity,
  };
}

function candidate(overrides = {}) {
  return {
    id_promocion: "promo-a",
    id_promocion_regla: "rule-a",
    nombre_promocion_snapshot: "Promo A",
    estado_promocion: "publicada",
    regla_activa: true,
    visible_publico: true,
    aplica_a_codigo: "servicio",
    tipo_descuento_codigo: "porcentaje",
    valor_descuento: 10,
    prioridad_aplicacion: 10,
    es_acumulable: false,
    scope_evaluacion_codigo: "grupo_cita",
    items: [{ id_servicio: SERVICE, cantidad_minima: 1 }],
    restricciones: [],
    cupos: [],
    codes: [],
    ...overrides,
  };
}

function context(overrides = {}) {
  const discountLines = [
    line({ key: "a", price: 100 }),
    line({ key: "b", service: OTHER_SERVICE, price: 80 }),
  ];
  return {
    canal: "public",
    fecha_operativa: "2026-11-01",
    hora: "10:00",
    id_grupo_cita: "group-a",
    id_cita: "cita-a",
    id_cita_integrante: "member-a",
    orden_integrante: 1,
    subtotal_hnl: 180,
    discount_lines: discountLines,
    servicios: discountLines,
    ...overrides,
  };
}

test("porcentaje y monto fijo usan solo lineas elegibles y nunca exceden su base", () => {
  const booking = context();
  assert.equal(calculateDiscount(booking, candidate()), 10);
  assert.equal(calculateDiscount(booking, candidate({
    tipo_descuento_codigo: "monto_fijo",
    valor_descuento: 150,
  })), 100);
});

test("2x1 grupal bonifica una sola unidad elegible de menor precio sin duplicar bloques", () => {
  const lines = [
    line({ key: "expensive", price: 120, appointment: "cita-a", member: "member-a" }),
    line({ key: "cheap", price: 80, appointment: "cita-b", member: "member-b" }),
    line({ key: "third", price: 70, appointment: "cita-c", member: "member-c" }),
    line({ key: "fourth", price: 60, appointment: "cita-d", member: "member-d" }),
  ];
  const promo = candidate({
    mecanica: "dos_por_uno",
    tipo_descuento_codigo: "bonificacion",
    cantidad_requerida: 2,
    cantidad_bonificada: 1,
    bonificacion_modo_codigo: "menor_precio",
    scope_evaluacion_codigo: "grupo_cita",
    items: [{ id_servicio: SERVICE, cantidad_minima: 2 }],
  });
  const booking = context({ subtotal_hnl: 330, discount_lines: lines, servicios: lines });
  const evaluated = evaluatePromotions(booking, [promo]);

  assert.equal(evaluated[0].descuento_calculado_hnl, 60);
  assert.deepEqual(evaluated[0].line_allocations, [{ line_key: "fourth", descuento_hnl: 60 }]);
});

test("scope cita e integrante no toman unidades de otra reserva o persona", () => {
  const lines = [
    line({ key: "current", price: 100, appointment: "cita-a", member: "member-a" }),
    line({ key: "foreign", price: 50, appointment: "cita-b", member: "member-b" }),
  ];
  const twoForOne = candidate({
    mecanica: "dos_por_uno",
    tipo_descuento_codigo: "bonificacion",
    cantidad_requerida: 2,
    cantidad_bonificada: 1,
    bonificacion_modo_codigo: "menor_precio",
    items: [{ id_servicio: SERVICE, cantidad_minima: 2 }],
  });
  const booking = context({ subtotal_hnl: 150, discount_lines: lines, servicios: lines });

  assert.equal(calculateDiscount(booking, { ...twoForOne, scope_evaluacion_codigo: "cita" }), 0);
  assert.equal(calculateDiscount(booking, { ...twoForOne, scope_evaluacion_codigo: "integrante" }), 0);
  assert.equal(calculateDiscount(booking, { ...twoForOne, scope_evaluacion_codigo: "grupo_cita" }), 50);
});

test("dos promociones no acumulables sobre el mismo servicio aplican una sola vez", () => {
  const booking = context();
  const evaluated = evaluatePromotions(booking, [
    candidate({ id_promocion_regla: "rule-first", prioridad_aplicacion: 1, valor_descuento: 20 }),
    candidate({ id_promocion_regla: "rule-second", prioridad_aplicacion: 2, valor_descuento: 50 }),
  ]);
  const resolved = resolvePromotionConflicts(booking, evaluated, new Map());

  assert.deepEqual(resolved.applied.map((row) => row.id_promocion_regla), ["rule-first"]);
  assert.equal(resolved.discarded[0].reasonCode, "PROMOCION_NO_COMPATIBLE");
});

test("cupo agotado impide reutilizar la regla", () => {
  const promo = candidate({
    cupos: [{ activo: true, periodo_codigo: "dia", limite_usos: 1 }],
  });
  const stats = {
    byRule: new Map(),
    byRuleClient: new Map(),
    byRulePeriod: new Map([["rule-a:dia:2026-11-01", 1]]),
  };
  const evaluated = evaluatePromotions(context(), [promo], stats);

  assert.equal(evaluated[0].isValid, false);
  assert.equal(evaluated[0].reasonCode, "PROMOCION_CUPO_AGOTADO");
  assert.equal(evaluated[0].descuento_calculado_hnl, 0);
});

test("fechas timestamp se normalizan antes de validar vigencia", () => {
  const validation = validatePromotionCandidate(context({ fecha_operativa: "2026-11-01T05:30:00.000Z" }), candidate({
    vigencia_desde: new Date("2026-11-01T00:00:00.000Z"),
    vigencia_hasta: new Date("2026-11-01T23:59:59.000Z"),
  }));
  assert.equal(validation.valid, true);
});

test("solo bonificacion con scope grupo_cita se clasifica como promocion grupal", () => {
  assert.equal(isGroupScopedBonificationPromotion(candidate({
    tipo_descuento_codigo: "bonificacion",
    scope_evaluacion_codigo: "grupo_cita",
  })), true);
  assert.equal(isGroupScopedBonificationPromotion(candidate({
    tipo_descuento_codigo: "bonificacion",
    scope_evaluacion_codigo: "cita",
  })), false);
});
