import { AppError } from "../utils/errors.js";

function safeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function roundMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function buildComprobanteCode({ idGrupoCita, now = new Date() }) {
  const dateLabel = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("");
  const compactGroup = String(idGrupoCita || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  const suffix = compactGroup || "RESERVA";
  return `MF-COMP-${dateLabel}-${suffix}`;
}

async function loadReceiptContext(client, idGrupoCita) {
  const groupResult = await client.query(
    `
      SELECT
        cg.id_grupo_cita,
        cg.id_sucursal,
        cg.id_usuario_titular,
        cg.id_cliente_titular,
        cg.id_persona_titular,
        cg.estado_grupo_codigo,
        cg.codigo_reserva,
        cg.origen_codigo,
        cg.total_hnl AS total_grupo_hnl,
        s.nombre_sucursal
      FROM public.citas_grupos cg
      JOIN public.sucursales s
        ON s.id_sucursal = cg.id_sucursal
      WHERE cg.id_grupo_cita = $1::uuid
      LIMIT 1
    `,
    [idGrupoCita]
  );

  const group = groupResult.rows[0];
  if (!group) {
    throw new AppError(409, "No fue posible preparar el comprobante de la reserva.", {
      code: "BOOKING_RECEIPT_PAYLOAD_INVALID",
    });
  }

  const membersResult = await client.query(
    `
      SELECT
        id_cita_integrante,
        orden_integrante,
        rol_integrante_codigo,
        tipo_cliente_codigo,
        contacto_nombre_snapshot,
        contacto_email_snapshot,
        contacto_telefono_snapshot,
        alias_integrante
      FROM public.citas_integrantes
      WHERE id_grupo_cita = $1::uuid
      ORDER BY orden_integrante ASC, created_at ASC
    `,
    [idGrupoCita]
  );

  const citasResult = await client.query(
    `
      SELECT
        c.id_cita,
        c.id_cita_integrante,
        c.orden_integrante,
        c.selection_type,
        c.id_paquete,
        c.inicio_at,
        c.fin_at,
        c.id_empleado_barbero AS id_barbero,
        c.subtotal_servicios_hnl,
        c.descuento_hnl,
        c.total_pagar_hnl,
        cp.id_cita_paquete,
        cp.id_paquete AS paquete_id,
        cp.nombre_paquete_snapshot,
        cp.total_hnl AS paquete_total_hnl
      FROM public.citas c
      LEFT JOIN public.citas_paquetes cp
        ON cp.id_cita = c.id_cita
      WHERE c.id_grupo_cita = $1::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.orden_integrante ASC, c.created_at ASC
    `,
    [idGrupoCita]
  );

  const detailsResult = await client.query(
    `
      SELECT
        cd.id_cita,
        cd.id_servicio,
        cd.id_cita_paquete,
        cd.origen_item_codigo,
        cd.nombre_servicio_snapshot,
        cd.duracion_min,
        cd.buffer_min,
        cd.precio_referencia_hnl,
        cd.precio_unitario_hnl,
        cd.subtotal_hnl,
        cd.descuento_hnl,
        cd.isv_hnl,
        cd.total_linea_hnl
      FROM public.citas_detalles cd
      JOIN public.citas c
        ON c.id_cita = cd.id_cita
      WHERE c.id_grupo_cita = $1::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.orden_integrante ASC, cd.created_at ASC
    `,
    [idGrupoCita]
  );

  const promotionsResult = await client.query(
    `
      SELECT
        id_cita,
        id_promocion,
        id_promocion_regla,
        aplica_a_codigo,
        nombre_promocion_snapshot,
        tipo_descuento_codigo,
        valor_descuento,
        base_calculo_hnl,
        descuento_calculado_hnl
      FROM public.citas_promociones
      WHERE id_grupo_cita = $1::uuid
      ORDER BY prioridad_aplicacion ASC, created_at ASC
    `,
    [idGrupoCita]
  );

  return {
    group,
    members: membersResult.rows,
    citas: citasResult.rows,
    details: detailsResult.rows,
    promotions: promotionsResult.rows,
  };
}

function buildPayloadResumen({ context, agendamientoConfig }) {
  const { group, members, citas, details, promotions } = context;
  const membersById = new Map(members.map((row) => [row.id_cita_integrante, row]));
  const detailsByCita = new Map();
  for (const row of details) {
    const key = row.id_cita;
    if (!detailsByCita.has(key)) detailsByCita.set(key, []);
    detailsByCita.get(key).push({
      id_servicio: row.id_servicio,
      id_cita_paquete: row.id_cita_paquete || null,
      origen_item_codigo: row.origen_item_codigo,
      nombre_servicio_snapshot: row.nombre_servicio_snapshot || null,
      duracion_min: Number(row.duracion_min || 0),
      buffer_min: Number(row.buffer_min || 0),
      precio_referencia_hnl: roundMoney(row.precio_referencia_hnl || 0),
      precio_unitario_hnl: roundMoney(row.precio_unitario_hnl || 0),
      subtotal_hnl: roundMoney(row.subtotal_hnl || 0),
      descuento_hnl: roundMoney(row.descuento_hnl || 0),
      isv_hnl: 0,
      total_linea_hnl: roundMoney(row.total_linea_hnl || 0),
    });
  }

  const promotionsByCita = new Map();
  for (const row of promotions) {
    const key = row.id_cita || "__GRUPO__";
    if (!promotionsByCita.has(key)) promotionsByCita.set(key, []);
    promotionsByCita.get(key).push({
      id_promocion: row.id_promocion,
      id_promocion_regla: row.id_promocion_regla || null,
      aplica_a_codigo: row.aplica_a_codigo,
      nombre_promocion_snapshot: row.nombre_promocion_snapshot,
      tipo_descuento_codigo: row.tipo_descuento_codigo,
      valor_descuento: roundMoney(row.valor_descuento || 0),
      base_calculo_hnl: roundMoney(row.base_calculo_hnl || 0),
      descuento_hnl: roundMoney(row.descuento_calculado_hnl || 0),
      isv_hnl: 0,
    });
  }

  const citasPayload = citas.map((row) => {
    const member = membersById.get(row.id_cita_integrante) || {};
    const services = detailsByCita.get(row.id_cita) || [];
    const promos = promotionsByCita.get(row.id_cita) || [];
    return {
      id_cita: row.id_cita,
      id_cita_integrante: row.id_cita_integrante,
      orden_integrante: Number(row.orden_integrante || 0),
      rol_integrante_codigo: member.rol_integrante_codigo || null,
      fecha_inicio: row.inicio_at ? new Date(row.inicio_at).toISOString() : null,
      fecha_fin: row.fin_at ? new Date(row.fin_at).toISOString() : null,
      id_barbero: row.id_barbero,
      selection_type: row.selection_type || "services",
      paquete: row.id_cita_paquete ? {
        id_cita_paquete: row.id_cita_paquete,
        id_paquete: row.paquete_id || row.id_paquete || null,
        nombre_paquete_snapshot: row.nombre_paquete_snapshot || null,
        total_hnl: roundMoney(row.paquete_total_hnl || 0),
      } : null,
      servicios: services,
      promociones: promos,
      subtotal_hnl: roundMoney(row.subtotal_servicios_hnl || 0),
      descuento_hnl: roundMoney(row.descuento_hnl || 0),
      isv_hnl: 0,
      total_hnl: roundMoney(row.total_pagar_hnl || 0),
      total_pagar_hnl: roundMoney(row.total_pagar_hnl || 0),
    };
  });

  const subtotal = roundMoney(citas.reduce((sum, row) => sum + Number(row.subtotal_servicios_hnl || 0), 0));
  const descuento = roundMoney(citas.reduce((sum, row) => sum + Number(row.descuento_hnl || 0), 0));
  const totalPagar = roundMoney(citas.reduce((sum, row) => sum + Number(row.total_pagar_hnl || 0), 0));

  const titular = members.find((row) => row.rol_integrante_codigo === "titular") || members[0] || {};
  return {
    id_grupo_cita: group.id_grupo_cita,
    codigo_reserva: group.codigo_reserva,
    estado_grupo_codigo: group.estado_grupo_codigo || "activo",
    resultado_reserva_codigo: "pendiente",
    sucursal: {
      id_sucursal: group.id_sucursal,
      nombre_sucursal: group.nombre_sucursal || "Sucursal",
    },
    titular: {
      nombre: titular.contacto_nombre_snapshot || "Cliente",
      email: titular.contacto_email_snapshot || null,
      telefono: titular.contacto_telefono_snapshot || null,
    },
    integrantes: members.map((row) => ({
      orden_integrante: Number(row.orden_integrante || 0),
      rol_integrante_codigo: row.rol_integrante_codigo,
      nombre: row.contacto_nombre_snapshot || "Cliente",
      email: row.contacto_email_snapshot || null,
      telefono: row.contacto_telefono_snapshot || null,
      alias_integrante: row.alias_integrante || null,
    })),
    citas: citasPayload,
    promociones_grupo: promotionsByCita.get("__GRUPO__") || [],
    totales: {
      subtotal_hnl: subtotal,
      descuento_hnl: descuento,
      isv_hnl: 0,
      total_hnl: totalPagar,
      total_pagar_hnl: totalPagar,
    },
    flags: {
      es_fiscal: false,
      cai_emitido: false,
      sar_integrado: false,
      facturacion_cai_habilitada: Boolean(agendamientoConfig?.facturacionCaiHabilitada),
      emitir_factura_fiscal: Boolean(agendamientoConfig?.emitirFacturaFiscal),
    },
  };
}

async function insertComprobanteAgendamiento(client, {
  context,
  payloadResumen,
  agendamientoConfig,
  logger,
}) {
  const group = context.group;
  const titular = context.members.find((row) => row.rol_integrante_codigo === "titular") || context.members[0] || {};
  const codigoComprobante = buildComprobanteCode({ idGrupoCita: group.id_grupo_cita });
  const totals = payloadResumen.totales || {};

  const forcedIsvHabilitado = Boolean(agendamientoConfig?.isvHabilitado);
  const isvPorcentaje = forcedIsvHabilitado ? roundMoney(agendamientoConfig?.isvPorcentajeDefault || 0) : 0;
  const isvHnl = 0;

  if (forcedIsvHabilitado && logger?.warn) {
    logger.warn(
      { code: "BOOKING_RECEIPT_ISV_FORCED_ZERO", id_grupo_cita: group.id_grupo_cita },
      "ISV habilitado en configuracion, pero comprobante de agendamiento se mantiene no fiscal en esta fase."
    );
  }

  const { rows } = await client.query(
    `
      INSERT INTO public.comprobantes_agendamiento (
        id_grupo_cita,
        codigo_comprobante,
        codigo_reserva_snapshot,
        tipo_comprobante_codigo,
        estado_comprobante_codigo,
        resultado_reserva_codigo,
        id_sucursal,
        id_usuario_titular,
        id_cliente_titular,
        id_persona_titular,
        titular_nombre_snapshot,
        titular_email_snapshot,
        titular_telefono_snapshot,
        moneda_codigo,
        subtotal_hnl,
        descuento_hnl,
        isv_porcentaje,
        isv_hnl,
        total_hnl,
        email_enviado,
        email_intentos,
        payload_resumen,
        facturacion_fiscal_habilitada_snapshot,
        cai_preparado_snapshot,
        id_factura_futura
      )
      VALUES (
        $1::uuid,
        $2::text,
        $3::text,
        'agendamiento_no_fiscal',
        'generado',
        'pendiente',
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8,
        $9,
        $10,
        'HNL',
        $11::numeric,
        $12::numeric,
        $13::numeric,
        $14::numeric,
        $15::numeric,
        FALSE,
        0,
        $16::jsonb,
        $17::boolean,
        $18::boolean,
        NULL
      )
      RETURNING id_comprobante_agendamiento, codigo_comprobante, estado_comprobante_codigo, resultado_reserva_codigo
    `,
    [
      group.id_grupo_cita,
      codigoComprobante,
      group.codigo_reserva,
      group.id_sucursal,
      group.id_usuario_titular || null,
      group.id_cliente_titular || null,
      group.id_persona_titular || null,
      titular.contacto_nombre_snapshot || "Cliente",
      titular.contacto_email_snapshot || null,
      titular.contacto_telefono_snapshot || null,
      roundMoney(totals.subtotal_hnl || 0),
      roundMoney(totals.descuento_hnl || 0),
      isvPorcentaje,
      isvHnl,
      roundMoney(totals.total_hnl || 0),
      JSON.stringify(payloadResumen),
      Boolean(agendamientoConfig?.facturacionCaiHabilitada),
      Boolean(agendamientoConfig?.facturacionCaiIntegracionSarHabilitada),
    ]
  );

  return rows[0];
}

async function insertReceiptRecipients(client, {
  idComprobanteAgendamiento,
  members,
}) {
  const dedupEmails = new Set();
  const recipients = [];

  for (const member of members) {
    const rawEmail = member.contacto_email_snapshot;
    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email)) continue;
    if (dedupEmails.has(email)) continue;
    dedupEmails.add(email);

    const tipo = member.rol_integrante_codigo === "titular" ? "titular" : "acompanante";
    recipients.push({
      tipo_destinatario_codigo: tipo,
      nombre_destinatario_snapshot: safeText(member.contacto_nombre_snapshot) || safeText(member.alias_integrante) || "Cliente",
      email_destinatario_snapshot: email,
    });
  }

  for (const recipient of recipients) {
    await client.query(
      `
        INSERT INTO public.comprobantes_agendamiento_destinatarios (
          id_comprobante_agendamiento,
          tipo_destinatario_codigo,
          nombre_destinatario_snapshot,
          email_destinatario_snapshot,
          estado_envio_codigo,
          intento_envio_count
        )
        VALUES (
          $1::uuid,
          $2::text,
          $3,
          $4::text,
          'pendiente',
          0
        )
      `,
      [
        idComprobanteAgendamiento,
        recipient.tipo_destinatario_codigo,
        recipient.nombre_destinatario_snapshot,
        recipient.email_destinatario_snapshot,
      ]
    );
  }

  return recipients;
}

export async function crearComprobanteAgendamientoNoFiscal({
  client,
  logger = null,
  agendamientoConfig = null,
  id_grupo_cita,
} = {}) {
  if (!client || typeof client.query !== "function") {
    throw new AppError(500, "No se pudo crear el comprobante de la reserva.", {
      code: "BOOKING_RECEIPT_CREATION_FAILED",
    });
  }

  try {
    const context = await loadReceiptContext(client, id_grupo_cita);
    const payloadResumen = buildPayloadResumen({
      context,
      agendamientoConfig,
    });
    const comprobante = await insertComprobanteAgendamiento(client, {
      context,
      payloadResumen,
      agendamientoConfig,
      logger,
    });

    let recipients = [];
    if (agendamientoConfig?.comprobanteEmailHabilitado) {
      recipients = await insertReceiptRecipients(client, {
        idComprobanteAgendamiento: comprobante.id_comprobante_agendamiento,
        members: context.members,
      });
    } else if (logger?.warn) {
      logger.warn(
        { code: "BOOKING_RECEIPT_EMAIL_DISABLED", id_grupo_cita },
        "Comprobante creado sin destinatarios porque comprobanteEmailHabilitado=false."
      );
    }

    return {
      id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento,
      codigo_comprobante: comprobante.codigo_comprobante,
      estado_comprobante_codigo: comprobante.estado_comprobante_codigo,
      resultado_reserva_codigo: comprobante.resultado_reserva_codigo,
      destinatarios: recipients.map((row) => ({
        tipo_destinatario_codigo: row.tipo_destinatario_codigo,
        email_destinatario_snapshot: row.email_destinatario_snapshot,
      })),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, "No se pudo crear el comprobante de la reserva.", {
      code: "BOOKING_RECEIPT_CREATION_FAILED",
    });
  }
}
