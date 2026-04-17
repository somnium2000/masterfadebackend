import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { cancelMembership, getClienteMembershipState } from "../../../services/membershipService.js";
import { resolveBranchIdsForClaims } from "../../../services/agendaService.js";

const ADMIN_MEMBERSHIP_ALLOWED_ROLES = ["admin", "super_admin"];

function handleError(reply, request, error, fallbackMessage, fallbackCode) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, fallbackMessage);
  return sendError(reply, 500, fallbackMessage, {
    code: fallbackCode,
    details: error instanceof Error ? error.message : fallbackMessage,
    requestId: request.id,
  });
}

function normalizeUuid(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new AppError(400, `${fieldName} es obligatorio`, {
      code: "ADMIN_MEMBERSHIP_UUID_REQUIRED",
      details: { field: fieldName },
    });
  }
  return normalized;
}

async function assertClientMembershipInScope(client, idCliente, branchIds) {
  const { rows } = await client.query(
    `
      SELECT
        s.id_suscripcion,
        s.id_cliente,
        s.id_sucursal_contratada,
        s.estado_suscripcion_codigo
      FROM public.subscriptions s
      WHERE s.id_cliente = $1::uuid
        AND s.estado_suscripcion_codigo = 'activa'
      ORDER BY s.inicio_at DESC, s.created_at DESC
      LIMIT 1
    `,
    [idCliente]
  );

  const active = rows[0] ?? null;
  if (!active) return null;

  if (active.id_sucursal_contratada && Array.isArray(branchIds) && branchIds.length > 0) {
    if (!branchIds.includes(active.id_sucursal_contratada)) {
      throw new AppError(403, "No puedes cancelar membresías fuera de tu alcance de sucursales", {
        code: "ADMIN_MEMBERSHIP_SCOPE_FORBIDDEN",
        details: {
          id_cliente: idCliente,
          id_sucursal_contratada: active.id_sucursal_contratada,
        },
      });
    }
  }

  return active;
}

export default async function adminMembershipRoutes(app) {
  app.post(
    "/clientes/:id_cliente/cancelar",
    { preHandler: app.requireRoles(ADMIN_MEMBERSHIP_ALLOWED_ROLES) },
    async (request, reply) => {
      const client = await app.db.connect();
      let txStarted = false;
      try {
        const idCliente = normalizeUuid(request.params?.id_cliente, "id_cliente");
        const branchIds = await resolveBranchIdsForClaims(app, request.claims);

        await client.query("BEGIN");
        txStarted = true;

        await assertClientMembershipInScope(client, idCliente, branchIds);
        const cancelled = await cancelMembership(client, {
          clienteId: idCliente,
          motivoFinCodigo: request.body?.motivo_fin_codigo || "cancelacion",
        });

        await client.query("COMMIT");
        txStarted = false;

        const estado = await getClienteMembershipState(client, idCliente);
        return sendOk(reply, {
          cancelacion: cancelled,
          estado_plan: estado,
        }, { requestId: request.id });
      } catch (error) {
        if (txStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return handleError(
          reply,
          request,
          error,
          "No se pudo cancelar la membresía del cliente",
          "ADMIN_MEMBERSHIP_CANCEL_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );
}
