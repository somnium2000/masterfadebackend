import { AppError } from "../../utils/errors.js";
import {
  bindAndActivateAsset,
  createTemporalAsset,
  findActiveAssetForEntity,
  getAssetById,
  markAssetStatus,
} from "./storageAssetsRepo.js";
import { buildStorageObjectPath, resolveExtensionForMime } from "./storagePath.js";
import { getStorageScope, STORAGE_VISIBILITY } from "./storageScopes.js";
import {
  assertBranchAccess,
  assertScopeBranch,
  assertScopeEntityType,
  assertScopeFileRules,
  assertScopeRole,
  assertUuid,
  normalizeOptionalText,
  userHasRole,
} from "./storageValidation.js";

const SIGNED_UPLOAD_EXPIRES_IN = Math.max(
  60,
  Number(process.env.STORAGE_SIGNED_UPLOAD_EXPIRES_IN || 7200)
);
const SIGNED_READ_EXPIRES_IN = Math.max(
  30,
  Number(process.env.STORAGE_SIGNED_READ_EXPIRES_IN || 300)
);

function ensureSupabaseStorageAdmin(app) {
  if (!app.supabaseAdmin) {
    throw new AppError(500, "Supabase Admin no esta configurado para Storage", {
      code: "STORAGE_SUPABASE_ADMIN_NOT_CONFIGURED",
    });
  }
  return app.supabaseAdmin;
}

function isNotFoundStorageError(error) {
  const text = String(error?.message || "").toLowerCase();
  return text.includes("not found") || text.includes("does not exist");
}

function resolvePublicUrl(app, bucket, objectPath) {
  const supabase = ensureSupabaseStorageAdmin(app);
  const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
  return data?.publicUrl || null;
}

async function loadClienteStorageContext(client, idCliente) {
  const { rows } = await client.query(
    `
      SELECT
        c.id_cliente,
        c.id_sucursal_origen,
        c.id_usuario
      FROM public.clientes c
      WHERE c.id_cliente = $1::uuid
        AND c.deleted_at IS NULL
      LIMIT 1
    `,
    [idCliente]
  );
  return rows[0] ?? null;
}

async function loadBarberStorageContext(client, idEmpleado) {
  const { rows } = await client.query(
    `
      SELECT
        e.id_empleado,
        e.id_sucursal,
        u.id_usuario,
        EXISTS (
          SELECT 1
          FROM public.roles_usuarios ru
          INNER JOIN public.roles r ON r.id_rol = ru.id_rol
          WHERE ru.id_usuario = u.id_usuario
            AND r.nombre = 'super_admin'
        ) AS has_super_admin,
        EXISTS (
          SELECT 1
          FROM public.app_protected_users apu
          WHERE apu.id_usuario = u.id_usuario
            AND apu.activo = TRUE
        ) AS is_protected
      FROM public.empleados e
      LEFT JOIN public.usuarios u
        ON u.id_persona = e.id_persona
        AND u.deleted_at IS NULL
      WHERE e.id_empleado = $1::uuid
        AND e.deleted_at IS NULL
      LIMIT 1
    `,
    [idEmpleado]
  );
  return rows[0] ?? null;
}

async function loadPromocionStorageContext(client, idPromocion, idSucursal = null) {
  const { rows } = await client.query(
    `
      SELECT
        p.id_promocion,
        ps.id_sucursal
      FROM public.promociones p
      LEFT JOIN public.promociones_sucursal ps
        ON ps.id_promocion = p.id_promocion
      WHERE p.id_promocion = $1::uuid
        AND ($2::uuid IS NULL OR ps.id_sucursal = $2::uuid)
      LIMIT 1
    `,
    [idPromocion, idSucursal]
  );
  return rows[0] ?? null;
}

function assertAssetAccessByClaims(claims, asset) {
  if (userHasRole(claims, "super_admin")) return;

  if (userHasRole(claims, "admin")) {
    if (asset.id_sucursal) {
      assertBranchAccess(claims, asset.id_sucursal);
    }
    return;
  }

  if (userHasRole(claims, "barbero")) {
    if (asset.id_sucursal) {
      assertBranchAccess(claims, asset.id_sucursal);
    }
    return;
  }

  if (userHasRole(claims, "cliente")) {
    const ownClienteId = String(claims?.cliente_id || "");
    const ownerClienteId = String(asset.owner_cliente_id || asset.entity_id || "");
    if (!ownClienteId || ownClienteId !== ownerClienteId) {
      throw new AppError(403, "No tienes permisos sobre este asset", {
        code: "STORAGE_ASSET_FORBIDDEN",
      });
    }
    return;
  }

  throw new AppError(403, "No tienes permisos sobre este asset", {
    code: "STORAGE_ASSET_FORBIDDEN",
  });
}

function isAdminBarberProfileContext(claims, scopeKey, entityType) {
  return userHasRole(claims, "admin")
    && String(scopeKey || "") === "public_barber_profile"
    && String(entityType || "") === "barbero";
}

async function assertBarberProfileContext(client, {
  claims,
  entityId,
  idSucursal,
}) {
  if (!entityId) return null;
  const barber = await loadBarberStorageContext(client, entityId);
  if (!barber) {
    throw new AppError(404, "Empleado no encontrado para el scope de Storage", {
      code: "STORAGE_BARBER_NOT_FOUND",
    });
  }
  if (idSucursal && String(barber.id_sucursal) !== String(idSucursal)) {
    throw new AppError(409, "La sucursal no corresponde al empleado", {
      code: "STORAGE_BARBER_BRANCH_MISMATCH",
    });
  }
  if (
    userHasRole(claims, "admin")
    && !userHasRole(claims, "super_admin")
    && (barber.has_super_admin || barber.is_protected)
  ) {
    throw new AppError(403, "Un administrador no puede gestionar esta cuenta privilegiada", {
      code: "STORAGE_PRIVILEGED_BARBER_FORBIDDEN",
    });
  }
  return barber;
}

function assertContextualAssetAccess(claims, asset, context = null) {
  const hasVerifiedBarberContext = context
    && isAdminBarberProfileContext(claims, context.scopeKey, context.entityType)
    && context.entityId
    && context.idSucursal
    && String(asset?.scope_key || "") === String(context.scopeKey)
    && String(asset?.entity_type || "") === String(context.entityType)
    && String(asset?.entity_id || "") === String(context.entityId)
    && String(asset?.id_sucursal || "") === String(context.idSucursal);
  if (hasVerifiedBarberContext) return;
  assertAssetAccessByClaims(claims, asset);
}

async function validateScopeEntityContext(client, scope, {
  entityId,
  idSucursal,
  claims,
  isSelfService = false,
}) {
  let normalizedEntityId = entityId;
  let normalizedSucursalId = idSucursal;
  let ownerClienteId = null;

  if (scope.entityType === "cliente") {
    const safeClienteId = assertUuid(normalizedEntityId, "entity_id", {
      required: true,
      code: "STORAGE_CLIENT_ID_REQUIRED",
    });
    const cliente = await loadClienteStorageContext(client, safeClienteId);
    if (!cliente) {
      throw new AppError(404, "Cliente no encontrado para el scope de Storage", {
        code: "STORAGE_CLIENT_NOT_FOUND",
      });
    }

    if (isSelfService || userHasRole(claims, "cliente")) {
      if (String(claims?.cliente_id || "") !== String(cliente.id_cliente)) {
        throw new AppError(403, "Solo puedes operar sobre tu propio perfil", {
          code: "STORAGE_SELF_CLIENT_FORBIDDEN",
        });
      }
    } else if (userHasRole(claims, "admin") && !userHasRole(claims, "super_admin") && cliente.id_sucursal_origen) {
      assertBranchAccess(claims, cliente.id_sucursal_origen);
    }

    normalizedEntityId = cliente.id_cliente;
    normalizedSucursalId = cliente.id_sucursal_origen ?? normalizedSucursalId;
    ownerClienteId = cliente.id_cliente;
  } else if (scope.entityType === "promocion" && normalizedEntityId) {
    const safePromotionId = assertUuid(normalizedEntityId, "entity_id", {
      required: false,
      code: "STORAGE_PROMOTION_ID_INVALID",
    });
    if (safePromotionId) {
      const promotion = await loadPromocionStorageContext(client, safePromotionId, normalizedSucursalId);
      if (!promotion) {
        throw new AppError(404, "Promocion no encontrada para el scope de Storage", {
          code: "STORAGE_PROMOTION_NOT_FOUND",
        });
      }
      normalizedEntityId = promotion.id_promocion;
      if (!normalizedSucursalId && promotion.id_sucursal) {
        normalizedSucursalId = promotion.id_sucursal;
      }
    }
  } else if (scope.key === "public_barber_profile" && scope.entityType === "barbero") {
    const barber = await assertBarberProfileContext(client, {
      claims,
      entityId: normalizedEntityId,
      idSucursal: normalizedSucursalId,
    });
    if (barber) {
      normalizedEntityId = barber.id_empleado;
      normalizedSucursalId = barber.id_sucursal;
    }
  }

  return {
    entityId: normalizedEntityId,
    idSucursal: normalizedSucursalId,
    ownerClienteId,
  };
}

export async function resolveAssetForBinding(client, {
  assetId,
  scopeKey,
  entityType,
  entityId = null,
  idSucursal = null,
  claims = null,
  allowUnboundEntity = true,
  allowedStatuses = ["temporal", "activo"],
}) {
  const idAsset = assertUuid(assetId, "asset_id", {
    required: true,
    code: "STORAGE_ASSET_ID_REQUIRED",
  });
  const asset = await getAssetById(client, idAsset);
  if (!asset || asset.deleted_at) {
    throw new AppError(404, "Asset no encontrado", {
      code: "STORAGE_ASSET_NOT_FOUND",
    });
  }
  if (!allowedStatuses.includes(String(asset.status || ""))) {
    throw new AppError(409, "El asset no esta disponible para asociar", {
      code: "STORAGE_ASSET_STATUS_INVALID",
      details: { status: asset.status },
    });
  }
  if (scopeKey && String(asset.scope_key) !== String(scopeKey)) {
    throw new AppError(400, "El asset no pertenece al scope esperado", {
      code: "STORAGE_ASSET_SCOPE_MISMATCH",
      details: { expected_scope: scopeKey, received_scope: asset.scope_key },
    });
  }
  if (entityType && String(asset.entity_type) !== String(entityType)) {
    throw new AppError(400, "El asset no pertenece al entity_type esperado", {
      code: "STORAGE_ASSET_ENTITY_TYPE_MISMATCH",
    });
  }
  if (entityId && asset.entity_id && String(asset.entity_id) !== String(entityId)) {
    throw new AppError(409, "El asset ya esta vinculado a otra entidad", {
      code: "STORAGE_ASSET_ENTITY_MISMATCH",
    });
  }
  if (!allowUnboundEntity && !entityId && !asset.entity_id) {
    throw new AppError(400, "El asset requiere una entidad vinculada", {
      code: "STORAGE_ASSET_ENTITY_REQUIRED",
    });
  }
  if (idSucursal && asset.id_sucursal && String(asset.id_sucursal) !== String(idSucursal)) {
    throw new AppError(409, "El asset pertenece a otra sucursal", {
      code: "STORAGE_ASSET_BRANCH_MISMATCH",
    });
  }
  let barberContext = null;
  if (scopeKey === "public_barber_profile" && entityType === "barbero" && entityId && idSucursal) {
    barberContext = await assertBarberProfileContext(client, { claims, entityId, idSucursal });
  }
  if (claims) {
    assertContextualAssetAccess(claims, asset, barberContext ? {
      scopeKey,
      entityType,
      entityId,
      idSucursal,
    } : null);
  }
  return asset;
}

export async function prepareStorageUpload(app, {
  claims,
  scopeKey,
  entityType,
  entityId = null,
  idSucursal = null,
  fileName,
  contentType,
  sizeBytes,
  selfService = false,
  label = "",
}) {
  const supabase = ensureSupabaseStorageAdmin(app);
  const scope = getStorageScope(scopeKey);
  if (!scope) {
    throw new AppError(400, "scope_key invalido", {
      code: "STORAGE_SCOPE_INVALID",
    });
  }
  if (selfService && scope.key !== "private_client_profile") {
    throw new AppError(403, "El endpoint general de Storage no permite este scope", {
      code: "STORAGE_SCOPE_FORBIDDEN",
    });
  }

  assertScopeRole(scope, claims);
  assertScopeEntityType(scope, entityType);
  const file = assertScopeFileRules(scope, { contentType, sizeBytes, fileName });

  let safeSucursalId = assertScopeBranch(scope, idSucursal);
  let safeEntityId = assertUuid(entityId, "entity_id", {
    required: Boolean(scope.requiresEntityId),
    code: "STORAGE_ENTITY_ID_REQUIRED",
  });

  if (selfService && scope.key === "private_client_profile") {
    safeEntityId = assertUuid(claims?.cliente_id, "cliente_id", {
      required: true,
      code: "STORAGE_SELF_CLIENT_REQUIRED",
    });
  }

  const client = await app.db.connect();
  try {
    const entityContext = await validateScopeEntityContext(client, scope, {
      entityId: safeEntityId,
      idSucursal: safeSucursalId,
      claims,
      isSelfService: selfService,
    });
    safeEntityId = entityContext.entityId;
    safeSucursalId = entityContext.idSucursal ?? safeSucursalId;
    if (scope.requiresBranchId) {
      safeSucursalId = assertUuid(safeSucursalId, "id_sucursal", {
        required: true,
        code: "STORAGE_BRANCH_REQUIRED",
      });
    }

    if (safeSucursalId && !isAdminBarberProfileContext(claims, scope.key, scope.entityType)) {
      assertBranchAccess(claims, safeSucursalId);
    }

    const extension = resolveExtensionForMime(file.contentType);
    if (!extension) {
      throw new AppError(400, "No se pudo resolver extension para content_type", {
        code: "STORAGE_EXTENSION_RESOLVE_ERROR",
      });
    }

    const objectPath = buildStorageObjectPath(scope, {
      branchId: safeSucursalId,
      entityId: safeEntityId,
      originalFileName: file.fileName,
      contentType: file.contentType,
      label,
    });
    const publicUrl = scope.visibility === STORAGE_VISIBILITY.PUBLIC
      ? resolvePublicUrl(app, scope.bucket, objectPath)
      : null;

    const asset = await createTemporalAsset(client, {
      bucketName: scope.bucket,
      objectPath,
      publicUrl,
      scopeKey: scope.key,
      visibility: scope.visibility,
      entityType: scope.entityType,
      entityId: safeEntityId,
      idSucursal: safeSucursalId,
      ownerUserId: claims?.user?.id_usuario ?? null,
      ownerClienteId: entityContext.ownerClienteId,
      mimeType: file.contentType,
      bytes: file.sizeBytes,
      originalFileName: file.fileName,
      extension,
      metadata: {
        prepared_at: new Date().toISOString(),
        prepared_from: selfService ? "self" : "admin",
      },
      uploadedBy: claims?.user?.id_usuario ?? null,
    });

    const { data, error } = await supabase.storage
      .from(scope.bucket)
      .createSignedUploadUrl(objectPath);
    if (error) {
      await markAssetStatus(client, {
        idAsset: asset.id_asset,
        status: "fallido",
        metadata: {
          prepare_upload_error: error.message || "SIGNED_UPLOAD_URL_ERROR",
        },
      });
      throw new AppError(502, "No se pudo generar signed upload URL", {
        code: "STORAGE_SIGNED_UPLOAD_ERROR",
        details: error.message || "SIGNED_UPLOAD_URL_ERROR",
      });
    }

    return {
      asset_id: asset.id_asset,
      bucket: scope.bucket,
      path: objectPath,
      token: data?.token ?? null,
      visibility: scope.visibility,
      public_url: publicUrl,
      signed_read_url: null,
      expires_in: SIGNED_UPLOAD_EXPIRES_IN,
      max_bytes: scope.maxBytes,
      content_type: file.contentType,
    };
  } finally {
    client.release();
  }
}

export async function buildAssetReadUrl(app, { claims, assetId, expiresIn = SIGNED_READ_EXPIRES_IN }) {
  const supabase = ensureSupabaseStorageAdmin(app);
  const client = await app.db.connect();
  try {
    const idAsset = assertUuid(assetId, "id_asset", {
      required: true,
      code: "STORAGE_ASSET_ID_REQUIRED",
    });
    const asset = await getAssetById(client, idAsset);
    if (!asset || asset.deleted_at) {
      throw new AppError(404, "Asset no encontrado", {
        code: "STORAGE_ASSET_NOT_FOUND",
      });
    }

    assertAssetAccessByClaims(claims, asset);

    if (asset.visibility === STORAGE_VISIBILITY.PUBLIC) {
      const url = asset.public_url || resolvePublicUrl(app, asset.bucket_name, asset.object_path);
      return {
        asset_id: asset.id_asset,
        visibility: asset.visibility,
        expires_in: 0,
        url,
      };
    }

    const ttl = Math.max(30, Number(expiresIn) || SIGNED_READ_EXPIRES_IN);
    const { data, error } = await supabase.storage
      .from(asset.bucket_name)
      .createSignedUrl(asset.object_path, ttl);
    if (error) {
      throw new AppError(502, "No se pudo generar signed read URL", {
        code: "STORAGE_SIGNED_READ_ERROR",
        details: error.message || "SIGNED_READ_URL_ERROR",
      });
    }

    return {
      asset_id: asset.id_asset,
      visibility: asset.visibility,
      expires_in: ttl,
      url: data?.signedUrl || null,
    };
  } finally {
    client.release();
  }
}

export async function buildPersonasClientProfileReadUrl(app, {
  claims,
  clientId,
  assetId,
  expiresIn = SIGNED_READ_EXPIRES_IN,
}) {
  if (!userHasRole(claims, "admin") && !userHasRole(claims, "super_admin")) {
    throw new AppError(403, "No tienes permisos sobre este asset", {
      code: "STORAGE_ASSET_FORBIDDEN",
    });
  }

  const safeClientId = assertUuid(clientId, "id_cliente", {
    required: true,
    code: "STORAGE_CLIENT_ID_REQUIRED",
  });
  const safeAssetId = assertUuid(assetId, "id_asset", {
    required: true,
    code: "STORAGE_ASSET_ID_REQUIRED",
  });
  const supabase = ensureSupabaseStorageAdmin(app);
  const client = await app.db.connect();
  try {
    const { rows } = await client.query(
      `
        SELECT c.id_cliente, p.foto_perfil_asset_id
        FROM public.clientes c
        INNER JOIN public.personas p ON p.id_persona = c.id_persona
        WHERE c.id_cliente = $1::uuid
          AND c.deleted_at IS NULL
        LIMIT 1
      `,
      [safeClientId]
    );
    const cliente = rows[0] ?? null;
    if (!cliente) {
      throw new AppError(404, "Cliente no encontrado", { code: "STORAGE_CLIENT_NOT_FOUND" });
    }
    if (String(cliente.foto_perfil_asset_id || "") !== safeAssetId) {
      throw new AppError(403, "El asset no corresponde a la fotografia actual del cliente", {
        code: "STORAGE_CLIENT_PROFILE_ASSET_FORBIDDEN",
      });
    }

    const asset = await getAssetById(client, safeAssetId);
    if (!asset || asset.deleted_at) {
      throw new AppError(404, "Asset no encontrado", { code: "STORAGE_ASSET_NOT_FOUND" });
    }
    if (
      asset.scope_key !== "private_client_profile"
      || asset.entity_type !== "cliente"
      || asset.visibility !== STORAGE_VISIBILITY.PRIVATE
    ) {
      throw new AppError(403, "El asset no corresponde al perfil privado del cliente", {
        code: "STORAGE_CLIENT_PROFILE_ASSET_FORBIDDEN",
      });
    }
    const ownershipIds = [asset.entity_id, asset.owner_cliente_id]
      .filter(Boolean)
      .map((value) => String(value));
    if (!ownershipIds.length || ownershipIds.some((value) => value !== safeClientId)) {
      throw new AppError(403, "El asset no corresponde al cliente consultado", {
        code: "STORAGE_CLIENT_PROFILE_ASSET_FORBIDDEN",
      });
    }

    const ttl = Math.max(30, Number(expiresIn) || SIGNED_READ_EXPIRES_IN);
    const { data, error } = await supabase.storage
      .from(asset.bucket_name)
      .createSignedUrl(asset.object_path, ttl);
    if (error) {
      throw new AppError(502, "No se pudo generar signed read URL", {
        code: "STORAGE_SIGNED_READ_ERROR",
      });
    }
    return {
      asset_id: asset.id_asset,
      visibility: asset.visibility,
      expires_in: ttl,
      url: data?.signedUrl || null,
    };
  } finally {
    client.release();
  }
}

export async function removeStorageObjectBestEffort(app, bucketName, objectPath, logger = null) {
  const supabase = ensureSupabaseStorageAdmin(app);
  const { error } = await supabase.storage.from(bucketName).remove([objectPath]);
  if (!error || isNotFoundStorageError(error)) return;
  if (logger?.warn) {
    logger.warn({ err: error, bucket: bucketName, path: objectPath }, "No se pudo eliminar objeto de Storage");
  }
}

async function assertAssetNotLinked(client, asset) {
  if (asset.scope_key === "public_promotion_main") {
    const linked = await client.query(
      `
        SELECT 1
        FROM public.promociones
        WHERE imagen_principal_asset_id = $1::uuid
        LIMIT 1
      `,
      [asset.id_asset]
    );
    if (linked.rowCount) {
      throw new AppError(409, "No se puede eliminar: asset activo en promociones", {
        code: "STORAGE_ASSET_IN_USE",
      });
    }
  } else if (asset.scope_key === "public_promotion_mobile") {
    const linked = await client.query(
      `
        SELECT 1
        FROM public.promociones
        WHERE imagen_mobile_asset_id = $1::uuid
        LIMIT 1
      `,
      [asset.id_asset]
    );
    if (linked.rowCount) {
      throw new AppError(409, "No se puede eliminar: asset activo en promociones", {
        code: "STORAGE_ASSET_IN_USE",
      });
    }
  } else if (asset.scope_key === "private_client_profile") {
    const linked = await client.query(
      `
        SELECT 1
        FROM public.personas
        WHERE foto_perfil_asset_id = $1::uuid
        LIMIT 1
      `,
      [asset.id_asset]
    );
    if (linked.rowCount) {
      throw new AppError(409, "No se puede eliminar: asset activo en perfil de cliente", {
        code: "STORAGE_ASSET_IN_USE",
      });
    }
  }
}

export async function deleteAsset(app, { claims, assetId }) {
  const client = await app.db.connect();
  try {
    const idAsset = assertUuid(assetId, "id_asset", {
      required: true,
      code: "STORAGE_ASSET_ID_REQUIRED",
    });
    const asset = await getAssetById(client, idAsset);
    if (!asset || asset.deleted_at) {
      throw new AppError(404, "Asset no encontrado", {
        code: "STORAGE_ASSET_NOT_FOUND",
      });
    }

    assertAssetAccessByClaims(claims, asset);
    await assertAssetNotLinked(client, asset);

    await removeStorageObjectBestEffort(app, asset.bucket_name, asset.object_path);

    const updated = await markAssetStatus(client, {
      idAsset: asset.id_asset,
      status: "eliminado",
      metadata: {
        deleted_by: claims?.user?.id_usuario ?? null,
      },
      deletedAt: new Date().toISOString(),
    });

    return {
      id_asset: updated?.id_asset || asset.id_asset,
      status: updated?.status || "eliminado",
    };
  } finally {
    client.release();
  }
}

export async function activateAssetForEntity(app, client, {
  assetId,
  scopeKey,
  entityType,
  entityId = null,
  idSucursal = null,
  ownerClienteId = null,
  claims = null,
  replaceCurrent = false,
}) {
  const asset = await resolveAssetForBinding(client, {
    assetId,
    scopeKey,
    entityType,
    entityId,
    idSucursal,
    claims,
    allowUnboundEntity: true,
    allowedStatuses: ["temporal", "activo"],
  });

  const activeAsset = await bindAndActivateAsset(client, {
    idAsset: asset.id_asset,
    entityId,
    idSucursal,
    ownerUserId: claims?.user?.id_usuario ?? null,
    ownerClienteId,
    metadata: {
      activated_at: new Date().toISOString(),
    },
  });

  let replacedAsset = null;
  if (replaceCurrent && entityId) {
    replacedAsset = await findActiveAssetForEntity(client, {
      scopeKey,
      entityType,
      entityId,
      excludeAssetId: activeAsset.id_asset,
    });
    if (replacedAsset) {
      await markAssetStatus(client, {
        idAsset: replacedAsset.id_asset,
        status: "reemplazado",
        metadata: {
          replaced_by_asset_id: activeAsset.id_asset,
          replaced_at: new Date().toISOString(),
        },
      });
    }
  }

  if (replacedAsset) {
    await removeStorageObjectBestEffort(app, replacedAsset.bucket_name, replacedAsset.object_path);
  }

  return {
    asset: activeAsset,
    replacedAsset,
  };
}

export async function replaceAssetIfNeeded(app, client, {
  previousAssetId,
  nextAssetId,
  claims = null,
  scopeKey = null,
  entityType = null,
  entityId = null,
  idSucursal = null,
  prevalidatedAsset = null,
  logger = null,
}) {
  const previousId = normalizeOptionalText(previousAssetId);
  const nextId = normalizeOptionalText(nextAssetId);
  if (!previousId || previousId === nextId) return null;

  const previous = prevalidatedAsset || await getAssetById(client, previousId);
  if (!previous || previous.deleted_at) return null;

  if (!prevalidatedAsset) {
    await validateAssetReplacement(client, {
      previousAssetId: previousId,
      nextAssetId: nextId,
      claims,
      scopeKey,
      entityType,
      entityId,
      idSucursal,
      asset: previous,
    });
  }

  await markAssetStatus(client, {
    idAsset: previous.id_asset,
    status: "reemplazado",
    metadata: {
      replaced_by_asset_id: nextId || null,
      replaced_at: new Date().toISOString(),
    },
  });
  await removeStorageObjectBestEffort(app, previous.bucket_name, previous.object_path, logger);
  return previous;
}

export async function validateAssetReplacement(client, {
  previousAssetId,
  nextAssetId,
  claims = null,
  scopeKey = null,
  entityType = null,
  entityId = null,
  idSucursal = null,
  asset = null,
}) {
  const previousId = normalizeOptionalText(previousAssetId);
  const nextId = normalizeOptionalText(nextAssetId);
  if (!previousId || previousId === nextId) return null;
  const contextValues = [scopeKey, entityType, entityId, idSucursal];
  const hasContext = contextValues.some(Boolean);
  const hasCompleteContext = contextValues.every(Boolean);
  if (hasContext && !hasCompleteContext) {
    throw new AppError(400, "El contexto de reemplazo de Storage esta incompleto", {
      code: "STORAGE_REPLACEMENT_CONTEXT_INCOMPLETE",
    });
  }
  const previous = asset || await getAssetById(client, previousId);
  if (!previous || previous.deleted_at) {
    if (hasContext) {
      throw new AppError(404, "Asset anterior no encontrado", {
        code: "STORAGE_ASSET_NOT_FOUND",
      });
    }
    return null;
  }
  if (scopeKey && String(previous.scope_key) !== String(scopeKey)) {
    throw new AppError(400, "El asset anterior no pertenece al scope esperado", {
      code: "STORAGE_ASSET_SCOPE_MISMATCH",
    });
  }
  if (entityType && String(previous.entity_type) !== String(entityType)) {
    throw new AppError(400, "El asset anterior no pertenece al entity_type esperado", {
      code: "STORAGE_ASSET_ENTITY_TYPE_MISMATCH",
    });
  }
  if (hasContext && String(previous.entity_id || "") !== String(entityId)) {
    throw new AppError(409, "El asset anterior no esta vinculado a la entidad esperada", {
      code: "STORAGE_ASSET_ENTITY_MISMATCH",
    });
  }
  if (idSucursal && String(previous.id_sucursal || "") !== String(idSucursal)) {
    throw new AppError(409, "El asset anterior pertenece a otra sucursal", {
      code: "STORAGE_ASSET_BRANCH_MISMATCH",
    });
  }
  let barberContext = null;
  if (hasContext) {
    if (scopeKey !== "public_barber_profile" || entityType !== "barbero") {
      throw new AppError(403, "El contexto no permite una excepcion transversal de Storage", {
        code: "STORAGE_REPLACEMENT_CONTEXT_FORBIDDEN",
      });
    }
    barberContext = await assertBarberProfileContext(client, { claims, entityId, idSucursal });
  }
  if (claims) {
    assertContextualAssetAccess(claims, previous, barberContext ? {
      scopeKey,
      entityType,
      entityId,
      idSucursal,
    } : null);
  }
  return previous;
}
