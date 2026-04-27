import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import {
  activateAssetForEntity,
  buildAssetReadUrl,
  deleteAsset,
  prepareStorageUpload,
  replaceAssetIfNeeded,
} from "../../services/storage/storageService.js";
import {
  createMembershipPurchaseOrder,
  createMembershipOrderPaymentIntent,
  confirmMembershipPaymentAndActivateSubscription,
  acquireMembershipPlan,
  cancelMembership,
  cancelMembershipBySubscription,
  getClienteMembershipState,
  registerSubscriptionAlertEvent,
} from "../../services/membershipService.js";

const CLIENT_ROLES = ["cliente"];
const requestIdSchema = { type: "string" };

let clienteProfileCapabilitiesCache = null;

function extractPlainText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const normalized = value.normalize("NFC").trim();
    if (!normalized) return "";
    if (
      (normalized.startsWith("{") && normalized.endsWith("}"))
      || (normalized.startsWith("[") && normalized.endsWith("]"))
      || (normalized.startsWith("\"") && normalized.endsWith("\""))
    ) {
      try {
        return extractPlainText(JSON.parse(normalized));
      } catch {
        return normalized;
      }
    }
    return normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const list = value
      .map((item) => extractPlainText(item))
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    return list.join(", ");
  }
  if (typeof value === "object") {
    const candidateKeys = ["value", "text", "texto", "preferencias", "content", "descripcion", "description"];
    for (const key of candidateKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const resolved = extractPlainText(value[key]);
        if (resolved) return resolved;
      }
    }

    const firstStringValue = Object.values(value)
      .map((item) => extractPlainText(item))
      .map((item) => String(item || "").trim())
      .find(Boolean);
    return firstStringValue || "";
  }
  return "";
}

function normalizeOptionalText(value) {
  if (value === undefined) return undefined;
  const normalized = extractPlainText(value);
  return normalized || null;
}

function normalizeDateOnly(value) {
  if (value === undefined) return undefined;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, "fecha_nacimiento invalida", {
      code: "CLIENTE_PROFILE_DATE_INVALID",
    });
  }
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (parsed.getTime() > todayUtc) {
    throw new AppError(400, "fecha_nacimiento no puede estar en el futuro", {
      code: "CLIENTE_PROFILE_DATE_FUTURE",
    });
  }
  return raw;
}

function resolveFieldPresence(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function buildProfileCompletion(profile) {
  const required = [
    "telefono_principal",
    "fecha_nacimiento",
    "genero_codigo",
    "direccion_texto",
  ];
  const recommended = ["preferencias_corte"];

  const missingFields = required.filter((field) => !resolveFieldPresence(profile?.[field]));
  const missingRecommended = recommended.filter((field) => !resolveFieldPresence(profile?.[field]));
  const completionPercent = Math.round(((required.length - missingFields.length) / required.length) * 100);

  return {
    is_complete: missingFields.length === 0,
    completion_percent: completionPercent,
    missing_fields: missingFields,
    recommended_fields: missingRecommended,
  };
}

function ensureClienteContext(request) {
  const clienteId = String(request.claims?.cliente_id || "").trim();
  if (!clienteId) {
    throw new AppError(409, "No tienes un perfil de cliente activo", {
      code: "CLIENTE_CONTEXT_REQUIRED",
    });
  }
  return {
    clienteId,
    personaId: request.claims?.user?.id_persona ?? null,
    userId: request.claims?.user?.id_usuario ?? null,
  };
}

async function loadClienteProfileCapabilities(client) {
  if (clienteProfileCapabilitiesCache) {
    return clienteProfileCapabilitiesCache;
  }

  const { rows } = await client.query(
    `
      SELECT table_name, column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'clientes' AND column_name IN ('preferencias', 'updated_at'))
          OR
          (table_name = 'personas' AND column_name IN ('foto_perfil_asset_id', 'foto_perfil_path', 'updated_at'))
        )
    `
  );

  const byTableColumn = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  const preferenciasColumn = rows.find(
    (row) => row.table_name === "clientes" && row.column_name === "preferencias"
  );
  const preferenciasDataType = String(preferenciasColumn?.data_type || "").toLowerCase();
  const preferenciasUdtName = String(preferenciasColumn?.udt_name || "").toLowerCase();
  const preferenciasDbType = (preferenciasDataType === "json" || preferenciasDataType === "jsonb")
    ? preferenciasDataType
    : ((preferenciasUdtName === "json" || preferenciasUdtName === "jsonb") ? preferenciasUdtName : "text");

  clienteProfileCapabilitiesCache = {
    hasPreferencias: byTableColumn.has("clientes.preferencias"),
    preferenciasDbType,
    hasFotoPerfilAssetId: byTableColumn.has("personas.foto_perfil_asset_id"),
    hasFotoPerfilPath: byTableColumn.has("personas.foto_perfil_path"),
    hasClientesUpdatedAt: byTableColumn.has("clientes.updated_at"),
    hasPersonasUpdatedAt: byTableColumn.has("personas.updated_at"),
  };

  return clienteProfileCapabilitiesCache;
}

async function resolveMasterPuntosBalance(client, clienteId, logger) {
  try {
    const { rows } = await client.query(
      `
        SELECT COALESCE(balance_puntos, 0)::int AS balance_puntos
        FROM public.vw_points_balance
        WHERE id_cliente = $1::uuid
      `,
      [clienteId]
    );

    return Number(rows?.[0]?.balance_puntos ?? 0);
  } catch (error) {
    if (error?.code === "42P01") {
      logger?.warn(
        { err: error, id_cliente: clienteId },
        "vw_points_balance no disponible; se devuelve balance de masterpuntos en cero"
      );
      return 0;
    }
    throw error;
  }
}

async function queryClienteProfileRow(client, clienteId, capabilities) {
  const preferenciasSelect = capabilities.hasPreferencias
    ? "c.preferencias AS preferencias_corte"
    : "NULL::text AS preferencias_corte";

  const fotoAssetSelect = capabilities.hasFotoPerfilAssetId
    ? "p.foto_perfil_asset_id"
    : "NULL::uuid AS foto_perfil_asset_id";

  const fotoPathSelect = capabilities.hasFotoPerfilPath
    ? "p.foto_perfil_path"
    : "NULL::text AS foto_perfil_path";

  const { rows } = await client.query(
    `
      SELECT
        c.id_cliente,
        c.id_persona,
        c.id_usuario,
        c.id_sucursal_origen,
        s.nombre_sucursal,
        COALESCE(c.estado, TRUE) AS estado_cliente,
        COALESCE(c.acepta_terminos, FALSE) AS acepta_terminos,
        COALESCE(c.consentimiento_marketing, FALSE) AS consentimiento_marketing,
        c.acepta_terminos_at,
        c.consentimiento_marketing_at,
        p.nombres,
        p.apellidos,
        p.fecha_nacimiento,
        p.genero_codigo,
        g.descripcion AS genero_descripcion,
        p.telefono_principal,
        p.direccion_texto,
        p.observaciones,
        ${preferenciasSelect},
        ${fotoAssetSelect},
        ${fotoPathSelect},
        cp.email AS correo_principal
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
      LEFT JOIN public.generos g
        ON g.genero_codigo = p.genero_codigo
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = c.id_sucursal_origen
      LEFT JOIN LATERAL (
        SELECT c2.direccion_correo::text AS email
        FROM public.correos c2
        WHERE c2.id_persona = c.id_persona
          AND c2.deleted_at IS NULL
        ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
        LIMIT 1
      ) cp ON TRUE
      WHERE c.id_cliente = $1::uuid
        AND c.deleted_at IS NULL
      LIMIT 1
    `,
    [clienteId]
  );

  return rows?.[0] ?? null;
}

function serializePreferenciasForDb(preferenciasText, capabilities) {
  if (preferenciasText === null || preferenciasText === undefined) return null;
  if (capabilities.preferenciasDbType === "json" || capabilities.preferenciasDbType === "jsonb") {
    return JSON.stringify(preferenciasText);
  }
  return preferenciasText;
}

async function resolveGeneroCodigoForUpdate(client, rawGeneroInput) {
  if (rawGeneroInput === undefined) return undefined;
  if (rawGeneroInput === null) return null;

  const normalizedGenero = normalizeOptionalText(rawGeneroInput);
  if (!normalizedGenero) return null;

  const aliases = new Map([
    ["masculino", "M"],
    ["femenino", "F"],
    ["prefiero_no_decir", "N"],
    ["prefiere no decir", "N"],
    ["no_binario", "NB"],
    ["no binario", "NB"],
    ["otro", "O"],
  ]);

  const aliasResolved = aliases.get(normalizedGenero.toLowerCase());
  const generoCandidate = aliasResolved || normalizedGenero;

  const { rows } = await client.query(
    `
      SELECT genero_codigo, descripcion
      FROM public.generos
      WHERE UPPER(genero_codigo) = UPPER($1)
         OR LOWER(descripcion) = LOWER($1)
      LIMIT 1
    `,
    [generoCandidate]
  );

  const matchedCode = rows?.[0]?.genero_codigo ? String(rows[0].genero_codigo).trim() : "";
  if (!matchedCode) {
    throw new AppError(422, "Genero invalido. Usa un valor permitido.", {
      code: "CLIENTE_PROFILE_GENERO_INVALID",
      details: { input: normalizedGenero },
    });
  }

  return matchedCode;
}

async function buildClienteMePayload(app, claims, { expiresIn = 300 } = {}) {
  const clienteId = String(claims?.cliente_id || "").trim();
  if (!clienteId) {
    throw new AppError(409, "No tienes un perfil de cliente activo", {
      code: "CLIENTE_CONTEXT_REQUIRED",
    });
  }

  const client = await app.db.connect();
  try {
    const capabilities = await loadClienteProfileCapabilities(client);
    const row = await queryClienteProfileRow(client, clienteId, capabilities);

    if (!row) {
      throw new AppError(404, "No se encontro el perfil del cliente autenticado", {
        code: "CLIENTE_PROFILE_NOT_FOUND",
      });
    }

    const masterpuntos = await resolveMasterPuntosBalance(client, clienteId, app.log);

    let fotoPerfilSignedUrl = null;
    if (row.foto_perfil_asset_id) {
      try {
        const readUrl = await buildAssetReadUrl(app, {
          claims,
          assetId: row.foto_perfil_asset_id,
          expiresIn,
        });
        fotoPerfilSignedUrl = readUrl?.url ?? null;
      } catch (error) {
        app.log.warn(
          { err: error, id_asset: row.foto_perfil_asset_id, id_cliente: clienteId },
          "No se pudo generar signed URL para foto privada del cliente"
        );
      }
    }

    const profile = {
      id_cliente: row.id_cliente,
      id_sucursal_origen: row.id_sucursal_origen ?? null,
      nombre_sucursal: row.nombre_sucursal ?? null,
      estado_cliente: Boolean(row.estado_cliente),
      nombres: row.nombres ?? "",
      apellidos: row.apellidos ?? "",
      nombre_completo: `${String(row.nombres || "").trim()} ${String(row.apellidos || "").trim()}`.trim(),
      correo_principal: row.correo_principal ?? null,
      telefono_principal: row.telefono_principal ?? null,
      fecha_nacimiento: row.fecha_nacimiento ?? null,
      genero_codigo: row.genero_codigo ?? null,
      genero_descripcion: row.genero_descripcion ?? null,
      direccion_texto: row.direccion_texto ?? null,
      preferencias_corte: normalizeOptionalText(
        row.preferencias_corte ?? row.observaciones ?? null
      ),
      masterpuntos,
      acepta_terminos: Boolean(row.acepta_terminos),
      consentimiento_marketing: Boolean(row.consentimiento_marketing),
      acepta_terminos_at: row.acepta_terminos_at ?? null,
      consentimiento_marketing_at: row.consentimiento_marketing_at ?? null,
      foto_perfil_asset_id: row.foto_perfil_asset_id ?? null,
      foto_perfil_signed_url: fotoPerfilSignedUrl,
    };

    return {
      cliente: profile,
      profile_completion: buildProfileCompletion(profile),
    };
  } finally {
    client.release();
  }
}

async function getClienteMailContext(client, clienteId) {
  const { rows } = await client.query(
    `
      SELECT
        c.id_cliente,
        COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Cliente') AS nombre_completo,
        cp.email AS correo_principal
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
      LEFT JOIN LATERAL (
        SELECT c2.direccion_correo::text AS email
        FROM public.correos c2
        WHERE c2.id_persona = c.id_persona
          AND c2.deleted_at IS NULL
        ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
        LIMIT 1
      ) cp ON TRUE
      WHERE c.id_cliente = $1::uuid
        AND c.deleted_at IS NULL
      LIMIT 1
    `,
    [clienteId]
  );

  return rows?.[0] ?? null;
}

async function getMembershipSubscriptionMailSummary(client, {
  clienteId,
  idSuscripcion,
} = {}) {
  const safeClienteId = String(clienteId || "").trim();
  const safeSubscriptionId = String(idSuscripcion || "").trim();
  if (!safeClienteId || !safeSubscriptionId) return null;

  const { rows } = await client.query(
    `
      SELECT
        s.id_suscripcion,
        s.inicio_at,
        s.fin_at,
        mp.nombre_plan,
        COALESCE(mpo.total_hnl, mpo.subtotal_hnl, 0)::numeric AS total_pagado_hnl
      FROM public.subscriptions s
      JOIN public.membership_plans mp
        ON mp.id_plan = s.id_plan
      LEFT JOIN LATERAL (
        SELECT mo.total_hnl, mo.subtotal_hnl
        FROM public.membership_purchase_orders mo
        WHERE mo.id_suscripcion = s.id_suscripcion
        ORDER BY mo.created_at DESC
        LIMIT 1
      ) mpo ON TRUE
      WHERE s.id_suscripcion = $1::uuid
        AND s.id_cliente = $2::uuid
      LIMIT 1
    `,
    [safeSubscriptionId, safeClienteId]
  );

  return rows?.[0] ?? null;
}

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
    requestId: request.id,
  });
}

export default async function clienteRoutes(app) {
  app.get(
    "/me",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  cliente: { type: "object", additionalProperties: true },
                  profile_completion: { type: "object", additionalProperties: true },
                },
                required: ["cliente", "profile_completion"],
                additionalProperties: true,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const payload = await buildClienteMePayload(app, request.claims, { expiresIn: 300 });
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo consultar el perfil del cliente", "CLIENTE_ME_ERROR");
      }
    }
  );

  app.patch(
    "/me",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            telefono_principal: { type: ["string", "null"], maxLength: 40 },
            fecha_nacimiento: { type: ["string", "null"], format: "date" },
            genero_codigo: { type: ["string", "null"], maxLength: 40 },
            direccion_texto: { type: ["string", "null"], maxLength: 300 },
            preferencias_corte: { type: ["string", "null"], maxLength: 1000 },
            foto_perfil_asset_id: { type: ["string", "null"], format: "uuid" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const body = request.body || {};
      const hasFotoPerfilPatch = Object.prototype.hasOwnProperty.call(body, "foto_perfil_asset_id");

      const client = await app.db.connect();
      let transactionStarted = false;
      try {
        const capabilities = await loadClienteProfileCapabilities(client);
        if (hasFotoPerfilPatch && (!capabilities.hasFotoPerfilAssetId || !capabilities.hasFotoPerfilPath)) {
          throw new AppError(500, "Falta aplicar migracion de foto privada en personas", {
            code: "CLIENTE_PROFILE_STORAGE_MIGRATION_REQUIRED",
          });
        }

        const current = await queryClienteProfileRow(client, context.clienteId, capabilities);
        if (!current) {
          throw new AppError(404, "No se encontro el perfil del cliente autenticado", {
            code: "CLIENTE_PROFILE_NOT_FOUND",
          });
        }

        const hasAnyPatch = [
          "telefono_principal",
          "fecha_nacimiento",
          "genero_codigo",
          "direccion_texto",
          "preferencias_corte",
          "foto_perfil_asset_id",
        ].some((key) => Object.prototype.hasOwnProperty.call(body, key));

        if (!hasAnyPatch) {
          throw new AppError(400, "No hay cambios para actualizar en el perfil", {
            code: "CLIENTE_PROFILE_PATCH_EMPTY",
          });
        }

        const nextTelefono = Object.prototype.hasOwnProperty.call(body, "telefono_principal")
          ? normalizeOptionalText(body.telefono_principal)
          : current.telefono_principal;
        const nextFechaNacimiento = Object.prototype.hasOwnProperty.call(body, "fecha_nacimiento")
          ? normalizeDateOnly(body.fecha_nacimiento)
          : current.fecha_nacimiento;
        const nextGenero = Object.prototype.hasOwnProperty.call(body, "genero_codigo")
          ? await resolveGeneroCodigoForUpdate(client, body.genero_codigo)
          : current.genero_codigo;
        const nextDireccion = Object.prototype.hasOwnProperty.call(body, "direccion_texto")
          ? normalizeOptionalText(body.direccion_texto)
          : current.direccion_texto;
        const nextPreferencias = Object.prototype.hasOwnProperty.call(body, "preferencias_corte")
          ? normalizeOptionalText(body.preferencias_corte)
          : (capabilities.hasPreferencias
            ? normalizeOptionalText(current.preferencias_corte)
            : normalizeOptionalText(current.observaciones));
        const nextObservaciones = capabilities.hasPreferencias
          ? current.observaciones
          : nextPreferencias;
        const serializedPreferencias = serializePreferenciasForDb(nextPreferencias, capabilities);

        await client.query("BEGIN");
        transactionStarted = true;

        const personasSet = [
          "telefono_principal = $2",
          "fecha_nacimiento = $3::date",
          "genero_codigo = $4",
          "direccion_texto = $5",
          "observaciones = $6",
        ];
        if (capabilities.hasPersonasUpdatedAt) {
          personasSet.push("updated_at = NOW()");
        }

        await client.query(
          `
            UPDATE public.personas
            SET ${personasSet.join(", ")}
            WHERE id_persona = $1::uuid
          `,
          [
            current.id_persona,
            nextTelefono,
            nextFechaNacimiento,
            nextGenero,
            nextDireccion,
            nextObservaciones,
          ]
        );

        if (capabilities.hasPreferencias && Object.prototype.hasOwnProperty.call(body, "preferencias_corte")) {
          const preferenciasValueExpression = capabilities.preferenciasDbType === "json"
            ? "$2::json"
            : (capabilities.preferenciasDbType === "jsonb" ? "$2::jsonb" : "$2");
          const clientesSet = [`preferencias = ${preferenciasValueExpression}`];
          if (capabilities.hasClientesUpdatedAt) {
            clientesSet.push("updated_at = NOW()");
          }

          await client.query(
            `
              UPDATE public.clientes
              SET ${clientesSet.join(", ")}
              WHERE id_cliente = $1::uuid
            `,
            [context.clienteId, serializedPreferencias]
          );
        }

        let nextFotoPerfilAssetId = current.foto_perfil_asset_id ?? null;
        let nextFotoPerfilPath = current.foto_perfil_path ?? null;
        if (hasFotoPerfilPatch) {
          const requestedAssetId = normalizeOptionalText(body.foto_perfil_asset_id ?? null);
          if (requestedAssetId) {
            const activation = await activateAssetForEntity(app, client, {
              assetId: requestedAssetId,
              scopeKey: "private_client_profile",
              entityType: "cliente",
              entityId: context.clienteId,
              ownerClienteId: context.clienteId,
              claims: request.claims,
              replaceCurrent: false,
            });
            nextFotoPerfilAssetId = activation.asset.id_asset;
            nextFotoPerfilPath = activation.asset.object_path;
          } else {
            nextFotoPerfilAssetId = null;
            nextFotoPerfilPath = null;
          }

          await client.query(
            `
              UPDATE public.personas
              SET foto_perfil_asset_id = $2::uuid,
                  foto_perfil_path = $3
                  ${capabilities.hasPersonasUpdatedAt ? ", updated_at = NOW()" : ""}
              WHERE id_persona = $1::uuid
            `,
            [current.id_persona, nextFotoPerfilAssetId, nextFotoPerfilPath]
          );
        }

        if (hasFotoPerfilPatch && String(current.foto_perfil_asset_id || "") !== String(nextFotoPerfilAssetId || "")) {
          await replaceAssetIfNeeded(app, client, {
            previousAssetId: current.foto_perfil_asset_id,
            nextAssetId: nextFotoPerfilAssetId,
            claims: request.claims,
          });
        }

        await client.query("COMMIT");
        transactionStarted = false;

        const payload = await buildClienteMePayload(app, request.claims, { expiresIn: 300 });
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        request.log.error(
          {
            err: error,
            id_cliente: context.clienteId,
            payload: body,
          },
          "Fallo actualizando perfil self-service de cliente"
        );
        if (transactionStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(reply, request, error, "No se pudo actualizar el perfil del cliente", "CLIENTE_PROFILE_UPDATE_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/planes/estado",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const client = await app.db.connect();
      try {
        const estado = await getClienteMembershipState(client, context.clienteId);
        return sendOk(reply, estado, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo consultar el estado de la membresía del cliente",
          "CLIENTE_MEMBERSHIP_STATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/planes/orden",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["id_plan_sucursal"],
          properties: {
            id_plan_sucursal: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_order: { type: "string", format: "uuid" },
                  estado_orden_codigo: { type: "string" },
                  plan: { type: "object", additionalProperties: true },
                  totales: { type: "object", additionalProperties: true },
                  cliente: { type: "object", additionalProperties: true },
                },
                required: ["id_order", "estado_orden_codigo", "plan", "totales", "cliente"],
                additionalProperties: true,
              },
              requestId: requestIdSchema,
            },
            required: ["success", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const client = await app.db.connect();
      let txStarted = false;

      try {
        await client.query("BEGIN");
        txStarted = true;

        const order = await createMembershipPurchaseOrder(client, {
          clienteId: context.clienteId,
          usuarioId: context.userId ?? null,
          idPlanSucursal: request.body.id_plan_sucursal,
        });

        await client.query("COMMIT");
        txStarted = false;

        return reply.code(201).send({
          success: true,
          data: order,
          requestId: request.id,
        });
      } catch (error) {
        if (txStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo crear la orden de compra del plan",
          "CLIENTE_MEMBERSHIP_ORDER_CREATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/planes/pago-intent",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["id_order"],
          properties: {
            id_order: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_payment_intent: { type: "string", format: "uuid" },
                  id_order: { type: "string", format: "uuid" },
                  origen_pago_codigo: { type: "string" },
                  monto: { type: "number" },
                  moneda_codigo: { type: "string" },
                  client_secret: { type: "string" },
                },
                required: [
                  "id_payment_intent",
                  "id_order",
                  "origen_pago_codigo",
                  "monto",
                  "moneda_codigo",
                  "client_secret",
                ],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const client = await app.db.connect();
      let txStarted = false;

      try {
        await client.query("BEGIN");
        txStarted = true;

        const intent = await createMembershipOrderPaymentIntent(client, {
          idOrder: request.body.id_order,
          clienteId: context.clienteId,
          usuarioId: context.userId ?? null,
        });

        await client.query("COMMIT");
        txStarted = false;

        return sendOk(reply, intent, { statusCode: 201, requestId: request.id });
      } catch (error) {
        if (txStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo crear el intent de pago para la orden de plan",
          "CLIENTE_MEMBERSHIP_PAYMENT_INTENT_CREATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/planes/confirmar-pago",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["id_payment_intent"],
          properties: {
            id_payment_intent: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_suscripcion: { type: "string", format: "uuid" },
                  estado: { type: "string" },
                  email_enviado: { type: "boolean" },
                },
                required: ["id_suscripcion", "estado", "email_enviado"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const client = await app.db.connect();
      let txStarted = false;

      try {
        await client.query("BEGIN");
        txStarted = true;

        const confirmation = await confirmMembershipPaymentAndActivateSubscription(client, {
          idPaymentIntent: request.body.id_payment_intent,
          clienteId: context.clienteId,
        });

        await client.query("COMMIT");
        txStarted = false;

        let emailEnviado = false;
        try {
          if (app.mailer?.configured && confirmation?.id_suscripcion) {
            const [mailContext, summary] = await Promise.all([
              getClienteMailContext(client, context.clienteId),
              getMembershipSubscriptionMailSummary(client, {
                clienteId: context.clienteId,
                idSuscripcion: confirmation.id_suscripcion,
              }),
            ]);

            if (mailContext?.correo_principal && summary?.nombre_plan) {
              const delivery = await app.mailer.sendMembershipPlanAcquiredEmail({
                to: mailContext.correo_principal,
                fullName: mailContext.nombre_completo,
                planName: summary.nombre_plan,
                startAt: summary.inicio_at,
                endAt: summary.fin_at,
                amountHnl: Number(summary.total_pagado_hnl || 0),
              });
              emailEnviado = Boolean(delivery?.sent);
            }
          }
        } catch (mailError) {
          request.log.warn(
            { err: mailError, id_suscripcion: confirmation?.id_suscripcion, id_cliente: context.clienteId },
            "No se pudo enviar correo de activacion de plan"
          );
          emailEnviado = false;
        }

        return sendOk(reply, {
          ...confirmation,
          email_enviado: emailEnviado,
        }, { requestId: request.id });
      } catch (error) {
        if (txStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo confirmar el pago del plan",
          "CLIENTE_MEMBERSHIP_PAYMENT_CONFIRM_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/planes/adquirir",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["id_plan", "id_sucursal"],
          properties: {
            id_plan: { type: "string", format: "uuid" },
            id_sucursal: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const client = await app.db.connect();
      let txStarted = false;

      try {
        const idPlan = String(request.body?.id_plan || "").trim();
        const idSucursal = String(request.body?.id_sucursal || "").trim();

        if (!idPlan || !idSucursal) {
          throw new AppError(400, "Debes indicar id_plan e id_sucursal para adquirir el plan", {
            code: "CLIENTE_MEMBERSHIP_ACQUIRE_INVALID_BODY",
          });
        }

        await client.query("BEGIN");
        txStarted = true;

        const acquisition = await acquireMembershipPlan(client, {
          clienteId: context.clienteId,
          usuarioId: context.userId,
          idPlan,
          idSucursal,
        });

        const alertPayload = {
          tipo: "adquisicion",
          id_plan: acquisition?.plan?.id_plan || idPlan,
          nombre_plan: acquisition?.plan?.nombre_plan || null,
          precio_hnl: acquisition?.plan?.precio_hnl ?? null,
        };
        const shouldSendAcquisitionMail = await registerSubscriptionAlertEvent(client, {
          idSuscripcion: acquisition.subscription.id_suscripcion,
          alertType: "adquisicion",
          payload: alertPayload,
        });

        await client.query("COMMIT");
        txStarted = false;

        const estado = await getClienteMembershipState(client, context.clienteId);
        const mailContext = shouldSendAcquisitionMail
          ? await getClienteMailContext(client, context.clienteId)
          : null;

        if (shouldSendAcquisitionMail && app.mailer?.configured && mailContext?.correo_principal) {
          void app.mailer.sendMembershipPlanAcquiredEmail({
            to: mailContext.correo_principal,
            fullName: mailContext.nombre_completo,
            planName: acquisition?.plan?.nombre_plan || "Plan MasterFade",
            startAt: acquisition?.subscription?.inicio_at,
            endAt: acquisition?.subscription?.fin_at,
            amountHnl: acquisition?.plan?.precio_hnl ?? null,
          });
        }

        return sendOk(
          reply,
          {
            adquisicion: {
              id_suscripcion: acquisition.subscription.id_suscripcion,
              id_plan: acquisition.plan.id_plan,
              nombre_plan: acquisition.plan.nombre_plan,
              categoria_nivel: acquisition.plan.categoria_nivel,
              precio_hnl: acquisition.plan.precio_hnl,
              inicio_at: acquisition.subscription.inicio_at,
              fin_at: acquisition.subscription.fin_at,
              transicion: acquisition.transition || null,
            },
            estado_plan: estado,
          },
          { statusCode: 201, requestId: request.id }
        );
      } catch (error) {
        if (txStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo adquirir el plan de membresía",
          "CLIENTE_MEMBERSHIP_ACQUIRE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/planes/cancelar",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            motivo_fin_codigo: { type: "string", minLength: 3, maxLength: 40 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const client = await app.db.connect();
      let txStarted = false;

      try {
        await client.query("BEGIN");
        txStarted = true;
        const cancelled = await cancelMembership(client, {
          clienteId: context.clienteId,
          motivoFinCodigo: request.body?.motivo_fin_codigo || "cancelacion",
        });
        await client.query("COMMIT");
        txStarted = false;

        const estado = await getClienteMembershipState(client, context.clienteId);
        return sendOk(
          reply,
          {
            cancelacion: cancelled,
            estado_plan: estado,
          },
          { requestId: request.id }
        );
      } catch (error) {
        if (txStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo cancelar la membresía",
          "CLIENTE_MEMBERSHIP_CANCEL_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/planes/:id_suscripcion/cancelar",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        params: {
          type: "object",
          required: ["id_suscripcion"],
          properties: {
            id_suscripcion: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_suscripcion: { type: "string", format: "uuid" },
                  estado_suscripcion_codigo: { type: "string" },
                },
                required: ["id_suscripcion", "estado_suscripcion_codigo"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const client = await app.db.connect();
      let txStarted = false;

      try {
        await client.query("BEGIN");
        txStarted = true;

        const cancelled = await cancelMembershipBySubscription(client, {
          clienteId: context.clienteId,
          idSuscripcion: request.params.id_suscripcion,
        });

        await client.query("COMMIT");
        txStarted = false;
        return sendOk(reply, cancelled, { requestId: request.id });
      } catch (error) {
        if (txStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo cancelar la suscripcion del plan",
          "CLIENTE_MEMBERSHIP_CANCEL_BY_SUBSCRIPTION_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/me/profile-image/prepare",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            file_name: { type: "string", minLength: 1, maxLength: 180 },
            content_type: { type: "string", minLength: 3, maxLength: 80 },
            size_bytes: { type: "integer", minimum: 1, maximum: 5242880 },
            label: { type: ["string", "null"], maxLength: 120 },
          },
          required: ["file_name", "content_type", "size_bytes"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const context = ensureClienteContext(request);
        const prepared = await prepareStorageUpload(app, {
          claims: request.claims,
          scopeKey: "private_client_profile",
          entityType: "cliente",
          entityId: context.clienteId,
          idSucursal: null,
          fileName: request.body.file_name,
          contentType: request.body.content_type,
          sizeBytes: request.body.size_bytes,
          selfService: true,
          label: request.body.label ?? "perfil-cliente",
        });
        return sendOk(reply, prepared, { statusCode: 201, requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo preparar la carga de foto de perfil", "CLIENTE_PROFILE_IMAGE_PREPARE_ERROR");
      }
    }
  );

  app.post(
    "/me/profile-image/read-url",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            asset_id: { type: ["string", "null"], format: "uuid" },
            expires_in: { type: "integer", minimum: 30, maximum: 7200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const context = ensureClienteContext(request);
        const capabilities = await loadClienteProfileCapabilities(app.db);
        const current = await queryClienteProfileRow(app.db, context.clienteId, capabilities);
        if (!current) {
          throw new AppError(404, "No se encontro el perfil del cliente autenticado", {
            code: "CLIENTE_PROFILE_NOT_FOUND",
          });
        }

        const requestedAssetId = normalizeOptionalText(request.body?.asset_id ?? null);
        const assetId = requestedAssetId || current.foto_perfil_asset_id;
        if (!assetId) {
          throw new AppError(404, "El cliente no tiene foto privada asociada", {
            code: "CLIENTE_PROFILE_IMAGE_NOT_FOUND",
          });
        }

        const payload = await buildAssetReadUrl(app, {
          claims: request.claims,
          assetId,
          expiresIn: request.body?.expires_in,
        });
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo generar URL temporal de foto privada", "CLIENTE_PROFILE_IMAGE_READ_URL_ERROR");
      }
    }
  );

  app.delete(
    "/me/profile-image",
    {
      preHandler: app.requireRoles(CLIENT_ROLES),
    },
    async (request, reply) => {
      const context = ensureClienteContext(request);
      const client = await app.db.connect();
      let transactionStarted = false;

      try {
        const capabilities = await loadClienteProfileCapabilities(client);
        if (!capabilities.hasFotoPerfilAssetId || !capabilities.hasFotoPerfilPath) {
          throw new AppError(500, "Falta aplicar migracion de foto privada en personas", {
            code: "CLIENTE_PROFILE_STORAGE_MIGRATION_REQUIRED",
          });
        }

        const current = await queryClienteProfileRow(client, context.clienteId, capabilities);
        if (!current) {
          throw new AppError(404, "No se encontro el perfil del cliente autenticado", {
            code: "CLIENTE_PROFILE_NOT_FOUND",
          });
        }

        if (!current.foto_perfil_asset_id) {
          return sendOk(reply, {
            removed: false,
            message: "No hay foto privada asociada para eliminar.",
          }, { requestId: request.id });
        }

        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(
          `
            UPDATE public.personas
            SET foto_perfil_asset_id = NULL,
                foto_perfil_path = NULL
                ${capabilities.hasPersonasUpdatedAt ? ", updated_at = NOW()" : ""}
            WHERE id_persona = $1::uuid
          `,
          [current.id_persona]
        );
        await client.query("COMMIT");
        transactionStarted = false;

        await deleteAsset(app, {
          claims: request.claims,
          assetId: current.foto_perfil_asset_id,
        });

        const payload = await buildClienteMePayload(app, request.claims, { expiresIn: 300 });
        return sendOk(reply, {
          removed: true,
          profile: payload,
        }, { requestId: request.id });
      } catch (error) {
        if (transactionStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(reply, request, error, "No se pudo eliminar la foto privada del cliente", "CLIENTE_PROFILE_IMAGE_DELETE_ERROR");
      } finally {
        client.release();
      }
    }
  );
}

