import { AppError } from "../../utils/errors.js";

export async function createTemporalAsset(client, payload) {
  const { rows } = await client.query(
    `
      INSERT INTO public.storage_assets (
        bucket_name,
        object_path,
        public_url,
        scope_key,
        visibility,
        entity_type,
        entity_id,
        id_sucursal,
        owner_user_id,
        owner_cliente_id,
        mime_type,
        bytes,
        original_filename,
        extension,
        status,
        metadata,
        uploaded_by
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
        $11, $12::bigint, $13, $14, 'temporal', $15::jsonb, $16::uuid
      )
      RETURNING *
    `,
    [
      payload.bucketName,
      payload.objectPath,
      payload.publicUrl ?? null,
      payload.scopeKey,
      payload.visibility,
      payload.entityType,
      payload.entityId ?? null,
      payload.idSucursal ?? null,
      payload.ownerUserId ?? null,
      payload.ownerClienteId ?? null,
      payload.mimeType,
      payload.bytes,
      payload.originalFileName ?? null,
      payload.extension ?? null,
      JSON.stringify(payload.metadata || {}),
      payload.uploadedBy ?? null,
    ]
  );

  return rows[0];
}

export async function getAssetById(client, idAsset) {
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.storage_assets
      WHERE id_asset = $1::uuid
      LIMIT 1
    `,
    [idAsset]
  );
  return rows[0] ?? null;
}

export async function bindAndActivateAsset(client, {
  idAsset,
  entityId = null,
  idSucursal = null,
  ownerUserId = null,
  ownerClienteId = null,
  metadata = {},
}) {
  const { rows } = await client.query(
    `
      UPDATE public.storage_assets
      SET
        entity_id = COALESCE($2::uuid, entity_id),
        id_sucursal = COALESCE($3::uuid, id_sucursal),
        owner_user_id = COALESCE($4::uuid, owner_user_id),
        owner_cliente_id = COALESCE($5::uuid, owner_cliente_id),
        status = 'activo',
        metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
        updated_at = NOW()
      WHERE id_asset = $1::uuid
      RETURNING *
    `,
    [idAsset, entityId, idSucursal, ownerUserId, ownerClienteId, JSON.stringify(metadata || {})]
  );
  if (!rows[0]) {
    throw new AppError(404, "Asset no encontrado para activar", {
      code: "STORAGE_ASSET_NOT_FOUND",
    });
  }
  return rows[0];
}

export async function markAssetStatus(client, {
  idAsset,
  status,
  metadata = {},
  deletedAt = null,
}) {
  const { rows } = await client.query(
    `
      UPDATE public.storage_assets
      SET
        status = $2,
        metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
        deleted_at = CASE
          WHEN $4::timestamptz IS NULL THEN deleted_at
          ELSE $4::timestamptz
        END,
        updated_at = NOW()
      WHERE id_asset = $1::uuid
      RETURNING *
    `,
    [idAsset, status, JSON.stringify(metadata || {}), deletedAt]
  );
  return rows[0] ?? null;
}

export async function findActiveAssetForEntity(client, {
  scopeKey,
  entityType,
  entityId,
  excludeAssetId = null,
}) {
  if (!scopeKey || !entityType || !entityId) return null;
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.storage_assets
      WHERE scope_key = $1
        AND entity_type = $2
        AND entity_id = $3::uuid
        AND deleted_at IS NULL
        AND status = 'activo'
        AND ($4::uuid IS NULL OR id_asset <> $4::uuid)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    [scopeKey, entityType, entityId, excludeAssetId]
  );
  return rows[0] ?? null;
}

export async function listOldTemporalAssets(client, {
  limit = 100,
  olderThanHours = 24,
}) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const safeHours = Math.max(1, Math.min(720, Number(olderThanHours) || 24));
  const { rows } = await client.query(
    `
      SELECT *
      FROM public.storage_assets
      WHERE status = 'temporal'
        AND deleted_at IS NULL
        AND created_at <= NOW() - ($1::text || ' hours')::interval
      ORDER BY created_at ASC
      LIMIT $2::int
    `,
    [String(safeHours), safeLimit]
  );
  return rows;
}
