import { AppError } from "../../utils/errors.js";

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function toMinutes(value) {
  if (!value) return null;
  const text = String(value).trim();
  const parts = text.split(":");
  if (parts.length < 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return (hour * 60) + minute;
}

export async function getCandidatePromotionRules(db, context = {}) {
  const idSucursal = String(context.id_sucursal || "").trim();
  if (!idSucursal) return [];

  const baseResult = await db.query(
    `
      SELECT
        pra.id_promocion_regla,
        pra.id_promocion,
        pra.tipo_promocion_agendamiento_codigo,
        pra.tipo_descuento_codigo,
        pra.aplica_a_codigo,
        pra.valor_descuento,
        pra.es_acumulable,
        pra.prioridad_aplicacion,
        pra.requiere_codigo,
        pra.codigo_promocional,
        pra.max_usos_por_reserva,
        pra.max_usos_por_cliente,
        pra.modo_aplicacion_codigo,
        pra.min_subtotal_hnl,
        pra.max_descuento_hnl,
        pra.activo AS regla_activa,
        p.id_promocion,
        p.titulo AS nombre_promocion_snapshot,
        p.estado AS estado_promocion,
        p.mecanica,
        p.cantidad_requerida,
        p.cantidad_bonificada,
        ps.id_promocion_sucursal,
        ps.id_sucursal,
        ps.visible_publico,
        ps.vigencia_desde,
        ps.vigencia_hasta,
        ps.vigencia_hora_desde,
        ps.vigencia_hora_hasta
      FROM public.promociones_reglas_agendamiento pra
      JOIN public.promociones p
        ON p.id_promocion = pra.id_promocion
      JOIN public.promociones_sucursal ps
        ON ps.id_promocion = p.id_promocion
      WHERE ps.id_sucursal = $1::uuid
    `,
    [idSucursal]
  );

  const rules = baseResult.rows || [];
  if (!rules.length) return [];

  const ruleIds = rules.map((row) => row.id_promocion_regla);

  const [itemsResult, restrictionsResult, cupsResult] = await Promise.all([
    db.query(
      `
        SELECT id_promocion_item, id_promocion_regla, tipo_item_codigo, id_servicio, id_paquete, cantidad_minima
        FROM public.promociones_items_agendamiento
        WHERE id_promocion_regla = ANY($1::uuid[])
      `,
      [ruleIds]
    ),
    db.query(
      `
        SELECT
          id_promocion_restriccion,
          id_promocion_regla,
          id_promocion_sucursal,
          id_sucursal,
          id_empleado_barbero,
          dia_semana,
          hora_inicio,
          hora_fin,
          vigencia_desde,
          vigencia_hasta,
          solo_cliente_autenticado,
          solo_titular
        FROM public.promociones_restricciones_agendamiento
        WHERE id_promocion_regla = ANY($1::uuid[])
      `,
      [ruleIds]
    ),
    db.query(
      `
        SELECT
          id_promocion_regla_cupo,
          id_promocion_regla,
          id_promocion_sucursal,
          id_empleado_barbero,
          periodo_codigo,
          limite_usos,
          activo
        FROM public.promociones_reglas_cupos
        WHERE id_promocion_regla = ANY($1::uuid[])
      `,
      [ruleIds]
    ),
  ]);

  const itemsByRule = new Map();
  for (const row of itemsResult.rows || []) {
    if (!itemsByRule.has(row.id_promocion_regla)) itemsByRule.set(row.id_promocion_regla, []);
    itemsByRule.get(row.id_promocion_regla).push(row);
  }

  const restrictionsByRule = new Map();
  for (const row of restrictionsResult.rows || []) {
    if (!restrictionsByRule.has(row.id_promocion_regla)) restrictionsByRule.set(row.id_promocion_regla, []);
    restrictionsByRule.get(row.id_promocion_regla).push({
      ...row,
      hora_inicio_min: toMinutes(row.hora_inicio),
      hora_fin_min: toMinutes(row.hora_fin),
      vigencia_desde_d: toIsoDate(row.vigencia_desde),
      vigencia_hasta_d: toIsoDate(row.vigencia_hasta),
    });
  }

  const cupsByRule = new Map();
  for (const row of cupsResult.rows || []) {
    if (!cupsByRule.has(row.id_promocion_regla)) cupsByRule.set(row.id_promocion_regla, []);
    cupsByRule.get(row.id_promocion_regla).push(row);
  }

  return rules.map((row) => ({
    ...row,
    items: itemsByRule.get(row.id_promocion_regla) || [],
    restricciones: restrictionsByRule.get(row.id_promocion_regla) || [],
    cupos: cupsByRule.get(row.id_promocion_regla) || [],
  }));
}

export async function getPromotionRuleById(db, idPromocionRegla) {
  const id = String(idPromocionRegla || "").trim();
  if (!id) return null;
  const result = await db.query(
    `SELECT * FROM public.promociones_reglas_agendamiento WHERE id_promocion_regla = $1::uuid LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function getPromotionCodesByRules(db, ruleIds = []) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return [];
  const result = await db.query(
    `
      SELECT
        id_promocion_codigo,
        id_promocion_regla,
        codigo,
        max_usos,
        max_usos_por_cliente,
        vigencia_desde,
        vigencia_hasta,
        activo
      FROM public.promociones_codigos
      WHERE id_promocion_regla = ANY($1::uuid[])
    `,
    [ruleIds]
  );
  return result.rows || [];
}

export async function getPromotionCompatibility(db, ruleIds = []) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return [];
  const result = await db.query(
    `
      SELECT
        id_compatibilidad,
        id_promocion_regla_a,
        id_promocion_regla_b,
        compatible,
        motivo,
        activo
      FROM public.promociones_reglas_compatibilidad
      WHERE id_promocion_regla_a = ANY($1::uuid[])
         OR id_promocion_regla_b = ANY($1::uuid[])
    `,
    [ruleIds]
  );
  return result.rows || [];
}

export async function getPromotionUsageStats(db, context = {}, ruleIds = []) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return { byRule: new Map(), byRuleClient: new Map(), byRulePeriod: new Map() };

  const dateRef = String(context.fecha_operativa || context.fecha || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const idCliente = context.id_cliente ? String(context.id_cliente).trim() : null;
  const idPersona = context.id_persona ? String(context.id_persona).trim() : null;
  const idPromocionSucursal = context.id_promocion_sucursal ? String(context.id_promocion_sucursal).trim() : null;
  const idBarbero = context.id_empleado_barbero ? String(context.id_empleado_barbero).trim() : null;
  const idGrupoCita = context.id_grupo_cita ? String(context.id_grupo_cita).trim() : null;

  const result = await db.query(
    `
      SELECT
        pu.id_promocion_regla,
        pu.id_grupo_cita,
        pu.id_cliente,
        pu.id_persona,
        pu.id_promocion_sucursal,
        pu.fecha_operativa,
        pu.estado_uso_codigo
      FROM public.promociones_usos pu
      WHERE pu.id_promocion_regla = ANY($1::uuid[])
        AND pu.estado_uso_codigo IN ('reservado', 'consumido')
    `,
    [ruleIds]
  );

  const byRule = new Map();
  const byRuleClient = new Map();
  const byRulePeriod = new Map();

  const computeWeekKey = (dateIso) => {
    const date = new Date(`${dateIso}T00:00:00Z`);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    return date.toISOString().slice(0, 10);
  };

  for (const row of result.rows || []) {
    const ruleId = row.id_promocion_regla;
    if (idGrupoCita && String(row.id_grupo_cita || "") === idGrupoCita) {
      byRule.set(ruleId, (byRule.get(ruleId) || 0) + 1);
    }

    if (idCliente && String(row.id_cliente || "") === idCliente) {
      const key = `${ruleId}:${idCliente}`;
      byRuleClient.set(key, (byRuleClient.get(key) || 0) + 1);
    }
    if (!idCliente && idPersona && String(row.id_persona || "") === idPersona) {
      const key = `${ruleId}:${idPersona}`;
      byRuleClient.set(key, (byRuleClient.get(key) || 0) + 1);
    }

    const dateOp = String(row.fecha_operativa || "").slice(0, 10);
    const monthKey = dateOp.slice(0, 7);
    const weekKey = computeWeekKey(dateOp);
    const suffixes = [`total`];
    if (dateOp === dateRef) suffixes.push(`dia:${dateRef}`);
    if (monthKey === dateRef.slice(0, 7)) suffixes.push(`mes:${monthKey}`);
    if (weekKey === computeWeekKey(dateRef)) suffixes.push(`semana:${weekKey}`);

    for (const suffix of suffixes) {
      const baseKey = `${ruleId}:${suffix}`;
      byRulePeriod.set(baseKey, (byRulePeriod.get(baseKey) || 0) + 1);
      if (idPromocionSucursal && String(row.id_promocion_sucursal || "") === idPromocionSucursal) {
        const k = `${ruleId}:${suffix}:sucursal:${idPromocionSucursal}`;
        byRulePeriod.set(k, (byRulePeriod.get(k) || 0) + 1);
      }
      if (idBarbero && String(context.id_empleado_barbero || "") === idBarbero) {
        const k = `${ruleId}:${suffix}:barbero:${idBarbero}`;
        byRulePeriod.set(k, (byRulePeriod.get(k) || 0) + 1);
      }
    }
  }

  return { byRule, byRuleClient, byRulePeriod };
}

export async function insertAppointmentPromotionApplication(db, data = {}) {
  const params = [
    data.id_grupo_cita,
    data.id_cita || null,
    data.id_cita_integrante || null,
    data.id_cita_paquete || null,
    data.id_cita_detalle || null,
    data.id_promocion,
    data.id_promocion_regla,
    data.aplica_a_codigo,
    data.estado_aplicacion_codigo || "no_aplicada",
  ];
  const existing = await db.query(
    `
      SELECT id_cita_promocion
      FROM public.citas_promociones
      WHERE id_grupo_cita = $1::uuid
        AND id_cita IS NOT DISTINCT FROM $2::uuid
        AND id_cita_integrante IS NOT DISTINCT FROM $3::uuid
        AND id_cita_paquete IS NOT DISTINCT FROM $4::uuid
        AND id_cita_detalle IS NOT DISTINCT FROM $5::uuid
        AND id_promocion = $6::uuid
        AND id_promocion_regla = $7::uuid
        AND aplica_a_codigo = $8::text
        AND estado_aplicacion_codigo = $9::text
      ORDER BY created_at ASC
      LIMIT 1
    `,
    params
  );
  if (existing.rows[0]?.id_cita_promocion) {
    return existing.rows[0].id_cita_promocion;
  }

  const result = await db.query(
    `
      INSERT INTO public.citas_promociones (
        id_grupo_cita,
        id_cita,
        id_cita_integrante,
        id_cita_paquete,
        id_cita_detalle,
        id_promocion,
        id_promocion_regla,
        aplica_a_codigo,
        nombre_promocion_snapshot,
        tipo_descuento_codigo,
        valor_descuento,
        base_calculo_hnl,
        descuento_calculado_hnl,
        prioridad_aplicacion,
        es_acumulable,
        estado_aplicacion_codigo,
        motivo_no_aplicada
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8::text,
        $9::text,
        $10::text,
        $11::numeric,
        $12::numeric,
        $13::numeric,
        $14::int,
        $15::boolean,
        $16::text,
        $17::text
      )
      RETURNING id_cita_promocion
    `,
    [
      data.id_grupo_cita,
      data.id_cita || null,
      data.id_cita_integrante || null,
      data.id_cita_paquete || null,
      data.id_cita_detalle || null,
      data.id_promocion,
      data.id_promocion_regla,
      data.aplica_a_codigo,
      data.nombre_promocion_snapshot || "Promocion",
      data.tipo_descuento_codigo,
      Number(data.valor_descuento || 0),
      Number(data.base_calculo_hnl || 0),
      Number(data.descuento_calculado_hnl || 0),
      Number(data.prioridad_aplicacion || 100),
      Boolean(data.es_acumulable),
      data.estado_aplicacion_codigo || "no_aplicada",
      data.motivo_no_aplicada || null,
    ]
  );
  return result.rows[0]?.id_cita_promocion || null;
}

export async function insertPromotionUsage(db, data = {}) {
  if (!data.id_cita_promocion || !data.id_promocion_regla || !data.id_grupo_cita) {
    throw new AppError(409, "Datos incompletos para registrar uso de promocion", {
      code: "PROMOTIONS_USAGE_DATA_REQUIRED",
    });
  }

  const lockKey = [
    data.id_promocion_regla,
    data.id_promocion_sucursal || "sin_sucursal",
    data.id_cita || data.id_grupo_cita,
    String(data.fecha_operativa || new Date().toISOString().slice(0, 10)).slice(0, 10),
  ].join("|");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [lockKey]);
  await db.query(
    `
      SELECT id_cita_promocion
      FROM public.citas_promociones
      WHERE id_cita_promocion = $1::uuid
      FOR UPDATE
    `,
    [data.id_cita_promocion]
  );
  const existing = await db.query(
    `
      SELECT id_promocion_uso
      FROM public.promociones_usos
      WHERE id_cita_promocion = $1::uuid
        AND id_promocion_regla = $2::uuid
        AND id_grupo_cita = $3::uuid
        AND id_cita IS NOT DISTINCT FROM $4::uuid
        AND estado_uso_codigo IN ('reservado', 'consumido')
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE
    `,
    [
      data.id_cita_promocion,
      data.id_promocion_regla,
      data.id_grupo_cita,
      data.id_cita || null,
    ]
  );
  if (existing.rows[0]?.id_promocion_uso) {
    return existing.rows[0].id_promocion_uso;
  }

  const result = await db.query(
    `
      INSERT INTO public.promociones_usos (
        id_cita_promocion,
        id_promocion_regla,
        id_grupo_cita,
        id_cita,
        id_cliente,
        id_persona,
        id_promocion_sucursal,
        fecha_operativa,
        estado_uso_codigo,
        usado_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8::date,
        $9::text,
        NOW()
      )
      RETURNING id_promocion_uso
    `,
    [
      data.id_cita_promocion,
      data.id_promocion_regla,
      data.id_grupo_cita,
      data.id_cita || null,
      data.id_cliente || null,
      data.id_persona || null,
      data.id_promocion_sucursal || null,
      String(data.fecha_operativa || new Date().toISOString().slice(0, 10)).slice(0, 10),
      data.estado_uso_codigo || "consumido",
    ]
  );
  return result.rows[0]?.id_promocion_uso || null;
}
