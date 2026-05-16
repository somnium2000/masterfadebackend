import { AppError } from "../utils/errors.js";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeNullableUuid(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function buildForbiddenError(message, code) {
  return new AppError(403, message, { code });
}

export async function releaseAppointmentHoldGroup(client, {
  groupId,
  mode = "public",
  releaseToken = null,
  clienteId = null,
  personaId = null,
} = {}) {
  const safeGroupId = normalizeNullableUuid(groupId);
  if (!safeGroupId) {
    throw new AppError(400, "id_grupo_cita es obligatorio", {
      code: "CITAS_HOLD_GROUP_REQUIRED",
    });
  }

  const normalizedMode = normalizeText(mode).toLowerCase() || "public";
  const isPublicRelease = normalizedMode === "public";
  const isAuthenticatedRelease = normalizedMode === "authenticated";
  const safeReleaseToken = normalizeText(releaseToken);
  const safeClienteId = normalizeNullableUuid(clienteId);
  const safePersonaId = normalizeNullableUuid(personaId);

  if (isPublicRelease && !safeReleaseToken) {
    throw new AppError(400, "release_token es obligatorio para liberar un hold publico", {
      code: "PUBLIC_CITAS_HOLD_RELEASE_TOKEN_REQUIRED",
    });
  }

  if (isAuthenticatedRelease && !safeClienteId && !safePersonaId) {
    throw new AppError(409, "No fue posible validar el contexto cliente de la reserva", {
      code: "CITAS_CLIENT_CONTEXT_REQUIRED",
    });
  }

  let txStarted = false;
  try {
    await client.query("BEGIN");
    txStarted = true;

    const groupResult = await client.query(
      `
        SELECT
          id_grupo_cita,
          id_cliente_titular,
          id_persona_titular,
          origen_codigo,
          estado_grupo_codigo,
          release_token
        FROM public.citas_grupos
        WHERE id_grupo_cita = $1::uuid
        FOR UPDATE
      `,
      [safeGroupId]
    );
    const group = groupResult.rows[0] || null;
    if (!group) {
      throw new AppError(404, "La reserva temporal indicada no existe", {
        code: "CITAS_HOLD_GROUP_NOT_FOUND",
      });
    }

    const groupState = normalizeText(group.estado_grupo_codigo).toLowerCase();
    if (groupState && groupState !== "activo") {
      throw new AppError(409, "La reserva temporal ya no esta activa", {
        code: "CITAS_HOLD_RELEASE_NOT_ACTIVE",
        details: { estado_grupo_codigo: groupState },
      });
    }

    if (isPublicRelease) {
      const origin = normalizeText(group.origen_codigo).toLowerCase();
      if (origin && origin !== "publico") {
        throw buildForbiddenError(
          "Este hold no pertenece al flujo publico",
          "PUBLIC_CITAS_HOLD_RELEASE_CONTEXT_INVALID"
        );
      }
      if (!group.release_token || safeReleaseToken !== normalizeText(group.release_token)) {
        throw buildForbiddenError(
          "No tienes permisos para liberar esta reserva temporal",
          "PUBLIC_CITAS_HOLD_RELEASE_TOKEN_INVALID"
        );
      }
    }

    if (isAuthenticatedRelease) {
      const ownsByClient = safeClienteId && normalizeText(group.id_cliente_titular) === safeClienteId;
      const ownsByPersona = safePersonaId && normalizeText(group.id_persona_titular) === safePersonaId;
      if (!ownsByClient && !ownsByPersona) {
        throw buildForbiddenError(
          "No tienes permisos para liberar esta reserva temporal",
          "CITAS_HOLD_RELEASE_FORBIDDEN"
        );
      }
    }

    const statusResult = await client.query(
      `
        SELECT
          COUNT(*)::int AS total_citas,
          COUNT(*) FILTER (
            WHERE c.estado_cita_codigo NOT IN ('en_espera', 'pendiente_pago')
              OR c.estado_cita_codigo IS NULL
          )::int AS citas_no_liberables,
          COUNT(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM public.citas_holds h
              WHERE h.id_cita = c.id_cita
                AND h.estado_hold_codigo = 'activo'
                AND h.expires_at > now()
            )
          )::int AS citas_sin_hold_activo,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1
              FROM public.citas_holds h
              JOIN public.payment_intents pi
                ON pi.id_hold = h.id_hold OR pi.id_cita = c.id_cita
              WHERE h.id_cita = c.id_cita
                AND pi.estado_intent_codigo IN ('confirmado', 'pagado', 'paid', 'pendiente_confirmacion')
            )
          )::int AS citas_con_pago
        FROM public.citas c
        WHERE c.id_grupo_cita = $1::uuid
          AND c.deleted_at IS NULL
      `,
      [safeGroupId]
    );

    const status = statusResult.rows[0] || {};
    const totalCitas = Number(status.total_citas || 0);
    if (totalCitas <= 0) {
      throw new AppError(404, "La reserva temporal indicada no tiene citas activas", {
        code: "CITAS_HOLD_GROUP_NOT_FOUND",
      });
    }

    if (Number(status.citas_con_pago || 0) > 0) {
      throw new AppError(409, "No se puede liberar un hold con pago registrado o en confirmacion", {
        code: "CITAS_HOLD_RELEASE_PAID_NOT_ALLOWED",
      });
    }

    if (Number(status.citas_no_liberables || 0) > 0) {
      throw new AppError(409, "No se puede liberar un hold confirmado, pagado o en proceso", {
        code: "CITAS_HOLD_RELEASE_STATE_NOT_ALLOWED",
      });
    }

    if (Number(status.citas_sin_hold_activo || 0) > 0) {
      throw new AppError(409, "No se puede liberar un hold vencido o inactivo", {
        code: "CITAS_HOLD_RELEASE_EXPIRED_NOT_ALLOWED",
      });
    }

    const citasResult = await client.query(
      `
        UPDATE public.citas
        SET estado_cita_codigo = 'cancelada',
            updated_at = now()
        WHERE id_grupo_cita = $1::uuid
          AND estado_cita_codigo IN ('en_espera', 'pendiente_pago')
          AND deleted_at IS NULL
        RETURNING id_cita
      `,
      [safeGroupId]
    );
    const citaIds = citasResult.rows.map((row) => row.id_cita).filter(Boolean);

    if (citaIds.length > 0) {
      await client.query(
        `
          UPDATE public.citas_holds
          SET estado_hold_codigo = 'cancelado',
              updated_at = now()
          WHERE id_cita = ANY($1::uuid[])
            AND estado_hold_codigo = 'activo'
        `,
        [citaIds]
      );
    }

    await client.query(
      `
        UPDATE public.citas_grupos
        SET estado_grupo_codigo = 'cancelado',
            release_token = NULL,
            updated_at = now()
        WHERE id_grupo_cita = $1::uuid
      `,
      [safeGroupId]
    );

    await client.query("COMMIT");
    txStarted = false;

    return {
      id_grupo_cita: safeGroupId,
      released: true,
      estado_grupo_codigo: "cancelado",
      citas_liberadas: citaIds.length,
    };
  } catch (error) {
    if (txStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // no-op
      }
    }
    throw error;
  }
}
