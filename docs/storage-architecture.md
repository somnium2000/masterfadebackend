# Storage Architecture (MasterFade)

## Resumen
Arquitectura de dos niveles:

1. **Publico**: bucket `imagenes_publicas` (URLs publicas, cache agresivo).
2. **Privado**: bucket `imagenes_privadas` (solo signed read URLs temporales).

Uploads desde frontend:
- **No** usan `service_role`.
- Flujo: `prepare` en backend -> `uploadToSignedUrl` directo navegador -> asociación por `asset_id`.

## Buckets
- `imagenes_publicas` (public = true)
  - MIME: `image/jpeg`, `image/png`, `image/webp`, `image/svg+xml`
  - limite: 5MB
- `imagenes_privadas` (public = false)
  - MIME: `image/jpeg`, `image/png`, `image/webp`
  - limite: 5MB

## Scopes cerrados
Definidos en `src/services/storage/storageScopes.js`:

- `public_promotion_main`
- `public_promotion_mobile`
- `public_branding`
- `private_client_profile`

Preparados para futuro:
- `public_barber_profile`
- `public_gallery_item`
- `public_service_image`
- `public_branch_cover`

## Tabla central
`public.storage_assets`:
- estado: `temporal | activo | reemplazado | eliminado | fallido`
- visibilidad: `public | private`
- referencias por `scope_key`, `entity_type`, `entity_id`, `id_sucursal`

## Flujo operativo
1. Frontend llama `POST /v1/admin/storage/uploads/prepare`.
2. Backend valida:
   - rol
   - scope
   - MIME
   - tamaño
   - contexto entidad/sucursal
3. Backend:
   - genera path único
   - crea registro `storage_assets` en `temporal`
   - retorna token firmado
4. Frontend sube binario a Supabase con `uploadToSignedUrl`.
5. Frontend guarda entidad (promo/cliente) enviando `asset_id`.
6. Backend valida `asset_id`, activa y vincula asset.
7. En reemplazos:
   - asset anterior -> `reemplazado`
   - se intenta remover objeto viejo en bucket.

## Integraciones actuales
### Promociones (publico)
- `imagen_principal_asset_id`, `imagen_principal_path`
- `imagen_mobile_asset_id`, `imagen_mobile_path`
- compatibilidad legacy preservada:
  - `imagen_principal_url`
  - `imagen_mobile_url`

### Clientes (privado)
- `public.personas.foto_perfil_asset_id`
- `public.personas.foto_perfil_path`
- detalle de cliente devuelve `foto_perfil_signed_url` temporal.

## Rutas backend
### Admin
- `POST /v1/admin/storage/uploads/prepare`
- `POST /v1/admin/storage/assets/:id/read-url`
- `DELETE /v1/admin/storage/assets/:id`

### Autenticada general (self-service base)
- `POST /v1/storage/uploads/prepare`
- `POST /v1/storage/assets/:id/read-url`

## Seguridad
- `SUPABASE_SERVICE_ROLE_KEY` solo backend.
- No se acepta `path` libre ni `folder` libre.
- Scopes cerrados y entity_type validado.
- Admin no super_admin limitado por `claims.branch_ids`.
- Cliente solo puede operar su `claims.cliente_id` en self-service.

## Cleanup de temporales
Script:
- `scripts/storage-cleanup-temporales.mjs`
- Busca assets `temporal` viejos
- intenta borrar objeto de Storage
- marca `eliminado` o `fallido` según resultado.

Variables:
- `STORAGE_CLEANUP_TEMP_HOURS` (default 24)
- `STORAGE_CLEANUP_TEMP_LIMIT` (default 250)
