import { AppError } from "../utils/errors.js";
import { resolveRedeemContextForHold } from "./pointsService.js";

function normalizeText(value) {
  const safe = String(value || "").trim();
  return safe || null;
}

function toMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function hasPromotionsRequested(items = []) {
  return (Array.isArray(items) ? items : []).some((item) =>
    Array.isArray(item?.promotionIds) && item.promotionIds.length > 0
  );
}

function mapRedeemError(error) {
  if (!(error instanceof AppError)) return null;
  const code = String(error.code || "").trim().toUpperCase();
  const mapping = {
    POINTS_REDEEM_CONTEXT_INVALID: { statusCode: 409, code: "REDEEM_CONTEXT_INVALID", message: "No fue posible validar el canje seleccionado." },
    POINTS_REDEEM_CONTEXT_VERSION_INVALID: { statusCode: 409, code: "REDEEM_CONTEXT_INVALID", message: "No fue posible validar el canje seleccionado." },
    POINTS_REDEEM_CONTEXT_EXPIRED: { statusCode: 409, code: "REDEEM_EXPIRED", message: "El canje seleccionado ya no esta disponible." },
    POINTS_REDEEM_CONTEXT_FORBIDDEN: { statusCode: 403, code: "REDEEM_NOT_OWNED_BY_USER", message: "El canje seleccionado no pertenece a la sesion activa." },
    POINTS_REDEEM_CONTEXT_BRANCH_MISMATCH: { statusCode: 409, code: "REDEEM_NOT_APPLICABLE", message: "El canje seleccionado no aplica a esta reserva." },
    POINTS_REDEEM_INSUFFICIENT_BALANCE_CONFIRM: { statusCode: 409, code: "REDEEM_AMOUNT_INVALID", message: "No fue posible calcular el beneficio del canje." },
    POINTS_REDEEM_SERVICE_MISMATCH: { statusCode: 409, code: "REDEEM_NOT_APPLICABLE", message: "El canje seleccionado no aplica a esta reserva." },
    POINTS_REDEEM_SERVICE_INVALID_ON_CONFIRM: { statusCode: 409, code: "REDEEM_NOT_APPLICABLE", message: "El canje seleccionado no aplica a esta reserva." },
    POINTS_REDEEM_SERVICE_AMBIGUOUS: { statusCode: 409, code: "REDEEM_NOT_APPLICABLE", message: "El canje seleccionado no aplica a esta reserva." },
    POINTS_REDEEM_ALREADY_APPLIED: { statusCode: 409, code: "REDEEM_TRANSACTION_ALREADY_USED", message: "El canje seleccionado ya fue utilizado." },
  };
  const mapped = mapping[code];
  if (!mapped) return null;
  return new AppError(mapped.statusCode, mapped.message, { code: mapped.code });
}

async function validateRequestedRedeemTransaction(client, {
  idPointsTxCanje,
  idCliente,
}) {
  const safeIdPointsTx = normalizeText(idPointsTxCanje);
  if (!safeIdPointsTx || !isUuid(safeIdPointsTx)) return null;

  const txResult = await client.query(
    `
      SELECT
        id_points_tx,
        id_cliente,
        id_cita,
        tipo_puntos_codigo
      FROM public.points_transactions
      WHERE id_points_tx = $1::uuid
      LIMIT 1
    `,
    [safeIdPointsTx]
  );
  const tx = txResult.rows[0] || null;
  if (!tx) {
    throw new AppError(409, "No fue posible validar el canje seleccionado.", {
      code: "REDEEM_TRANSACTION_NOT_FOUND",
    });
  }
  if (String(tx.id_cliente || "") !== String(idCliente || "")) {
    throw new AppError(403, "El canje seleccionado no pertenece a la sesion activa.", {
      code: "REDEEM_NOT_OWNED_BY_USER",
    });
  }
  if (String(tx.tipo_puntos_codigo || "").trim().toLowerCase() === "canjear" && tx.id_cita) {
    throw new AppError(409, "El canje seleccionado ya fue utilizado.", {
      code: "REDEEM_TRANSACTION_ALREADY_USED",
    });
  }
  return {
    id_points_tx_canje: tx.id_points_tx,
    tipo_puntos_codigo: tx.tipo_puntos_codigo,
  };
}

export async function prepararBeneficioCanjeAgendamiento({
  client,
  logger = null,
  actor = null,
  id_sucursal,
  canje_context_token = null,
  id_points_tx_canje = null,
  blocks = [],
} = {}) {
  const idCliente = normalizeText(actor?.id_cliente);
  const idUsuario = normalizeText(actor?.id_usuario);
  if (!idCliente || !idUsuario) {
    throw new AppError(409, "No fue posible validar el contexto de canje para esta sesion.", {
      code: "BOOKING_AUTH_CONTEXT_INVALID",
    });
  }

  const candidateToken = normalizeText(canje_context_token) || normalizeText(id_points_tx_canje);
  if (!candidateToken) {
    return { aplica: false };
  }
  if (hasPromotionsRequested(blocks)) {
    throw new AppError(409, "El canje seleccionado no aplica a esta reserva.", {
      code: "REDEEM_NOT_APPLICABLE",
    });
  }

  try {
    const redeemContext = await resolveRedeemContextForHold(client, {
      idCliente,
      canjeContextToken: candidateToken,
      idSucursal: id_sucursal,
    });
    const txHint = await validateRequestedRedeemTransaction(client, {
      idPointsTxCanje: id_points_tx_canje,
      idCliente,
    });

    return {
      aplica: true,
      tipo_beneficio_codigo: "canje_recompensa",
      canje_context_token: redeemContext.canje_context_token,
      id_points_tx_canje: txHint?.id_points_tx_canje || null,
      id_cliente: redeemContext.id_cliente,
      id_usuario: idUsuario,
      id_servicio_objetivo: redeemContext.id_servicio_canje,
      puntos_requeridos: Number(redeemContext.puntos_requeridos || 0),
      saldo_referencia_hnl: 0,
      monto_cubierto_hnl: 0,
      monto_pendiente_hnl: 0,
      requiere_confirmacion_canje: true,
      consumir_en_confirmacion: true,
      metadata_segura: {
        servicio_nombre: redeemContext.servicio_nombre || null,
      },
    };
  } catch (error) {
    const mapped = mapRedeemError(error);
    if (mapped) throw mapped;
    logger?.error?.({ err: error }, "No fue posible preparar beneficio de canje.");
    throw new AppError(409, "No fue posible completar la reserva con el canje seleccionado.", {
      code: "BOOKING_REDEEM_CONSISTENCY_FAILED",
    });
  }
}

export function calcularCoberturaCanjeSobreSeleccion({
  beneficioAgendamiento = null,
  member = null,
  normalizedSelection = null,
  totalDespuesPromocionesHnl = 0,
} = {}) {
  if (!beneficioAgendamiento?.aplica) {
    return { aplica: false, monto_cubierto_hnl: 0, monto_pendiente_hnl: toMoney(totalDespuesPromocionesHnl) };
  }
  if (!member || member.rol_integrante_codigo !== "titular") {
    return { aplica: false, monto_cubierto_hnl: 0, monto_pendiente_hnl: toMoney(totalDespuesPromocionesHnl) };
  }

  const targetServiceId = normalizeText(beneficioAgendamiento.id_servicio_objetivo);
  if (!targetServiceId) {
    throw new AppError(409, "No fue posible validar el canje seleccionado.", {
      code: "REDEEM_CONTEXT_INVALID",
    });
  }

  const detalleItems = Array.isArray(normalizedSelection?.detalles) ? normalizedSelection.detalles : [];
  const cobrables = detalleItems.filter((item) => {
    const origin = String(item?.origen_item_codigo || "").trim().toLowerCase();
    return origin === "servicio_manual" || origin === "servicio_extra";
  });
  const lineasObjetivo = cobrables.filter((item) => String(item?.id_servicio || "").trim() === targetServiceId);
  if (!lineasObjetivo.length) {
    throw new AppError(409, "El canje seleccionado no aplica a esta reserva.", {
      code: "REDEEM_NOT_APPLICABLE",
    });
  }

  const totalLineaObjetivo = toMoney(lineasObjetivo.reduce((sum, row) => sum + Number(row?.total_linea_hnl || 0), 0));
  if (totalLineaObjetivo <= 0) {
    throw new AppError(409, "No fue posible calcular el beneficio del canje.", {
      code: "REDEEM_AMOUNT_INVALID",
    });
  }

  const totalBase = toMoney(totalDespuesPromocionesHnl);
  const montoCubierto = toMoney(Math.min(totalBase, totalLineaObjetivo));
  const montoPendiente = toMoney(Math.max(0, totalBase - montoCubierto));

  return {
    aplica: montoCubierto > 0,
    monto_cubierto_hnl: montoCubierto,
    monto_pendiente_hnl: montoPendiente,
    id_servicio_objetivo: targetServiceId,
  };
}

