# Storage Test Checklist

## 1) Preparacion
- [ ] Migraciones aplicadas (`storage_assets`, columnas en promociones/personas, buckets).
- [ ] Backend con `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] Frontend con `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

## 2) Promociones (publico)
### Crear
- [ ] Abrir Admin > Configuracion > Promociones.
- [ ] Subir imagen principal con uploader (scope `public_promotion_main`).
- [ ] Guardar promocion enviando `imagen_principal_asset_id`.
- [ ] Validar que responde `imagen_principal_url`.

### Editar/reemplazar
- [ ] Reemplazar imagen principal.
- [ ] Validar nuevo `asset_id` y `path`.
- [ ] Validar asset previo marcado como `reemplazado`.
- [ ] Validar intento de borrado del objeto anterior.

### Publico
- [ ] Abrir `PromotionsPage.jsx`.
- [ ] Confirmar render por `imagen_principal_url` sin cambios de contrato.

## 3) Cliente (privado)
### Editar cliente
- [ ] Abrir Admin > Personas > Clientes > Editar.
- [ ] Subir foto privada (scope `private_client_profile`).
- [ ] Guardar cliente con `foto_perfil_asset_id`.
- [ ] Verificar que detalle devuelve `foto_perfil_signed_url`.

### Reemplazo
- [ ] Cambiar foto privada.
- [ ] Validar asset anterior marcado `reemplazado`.

## 4) Seguridad
- [ ] Intentar prepare con `scope_key` invalido -> rechazo.
- [ ] Intentar MIME invalido -> rechazo.
- [ ] Intentar archivo > max bytes -> rechazo.
- [ ] Admin no super_admin fuera de sucursal permitida -> rechazo.
- [ ] Cliente (self-service) operando otro `cliente_id` -> rechazo.

## 5) Mantenimiento
- [ ] Ejecutar `node scripts/storage-cleanup-temporales.mjs`.
- [ ] Validar que temporales viejos pasan a `eliminado` o `fallido`.

## 6) Verificacion tecnica
- [ ] `npm run lint` backend.
- [ ] `npm run lint` frontend.
- [ ] `npm run build` frontend.
