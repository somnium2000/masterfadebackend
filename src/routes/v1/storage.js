import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import { buildAssetReadUrl, prepareStorageUpload } from "../../services/storage/storageService.js";

const STORAGE_UPLOAD_ROLES = ["cliente"];
const STORAGE_READ_ROLES = ["super_admin", "admin", "barbero", "cliente"];

function sendHandled(reply, request, error, fallbackMessage, fallbackCode) {
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

export default async function storageRoutes(app) {
  app.post(
    "/uploads/prepare",
    {
      preHandler: app.requireRoles(STORAGE_UPLOAD_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            scope_key: { type: "string", minLength: 3, maxLength: 80 },
            entity_type: { type: "string", minLength: 3, maxLength: 80 },
            file_name: { type: "string", minLength: 1, maxLength: 180 },
            content_type: { type: "string", minLength: 3, maxLength: 80 },
            size_bytes: { type: "integer", minimum: 1, maximum: 52428800 },
            label: { type: ["string", "null"], maxLength: 120 },
          },
          required: ["scope_key", "entity_type", "file_name", "content_type", "size_bytes"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const prepared = await prepareStorageUpload(app, {
          claims: request.claims,
          scopeKey: request.body.scope_key,
          entityType: request.body.entity_type,
          entityId: null,
          idSucursal: null,
          fileName: request.body.file_name,
          contentType: request.body.content_type,
          sizeBytes: request.body.size_bytes,
          selfService: true,
          label: request.body.label ?? "",
        });
        return sendOk(reply, prepared, { statusCode: 201, requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo preparar el upload de Storage",
          "STORAGE_PREPARE_ERROR"
        );
      }
    }
  );

  app.post(
    "/assets/:id/read-url",
    {
      preHandler: app.requireRoles(STORAGE_READ_ROLES),
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
          additionalProperties: false,
        },
        body: {
          type: "object",
          properties: {
            expires_in: { type: "integer", minimum: 30, maximum: 7200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const payload = await buildAssetReadUrl(app, {
          claims: request.claims,
          assetId: request.params.id,
          expiresIn: request.body?.expires_in,
        });
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo generar URL de lectura para asset",
          "STORAGE_READ_URL_ERROR"
        );
      }
    }
  );
}
