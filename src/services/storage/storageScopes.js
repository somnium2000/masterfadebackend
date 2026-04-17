const MB = 1024 * 1024;

export const STORAGE_VISIBILITY = {
  PUBLIC: "public",
  PRIVATE: "private",
};

export const STORAGE_PUBLIC_BUCKET =
  String(process.env.SUPABASE_STORAGE_BUCKET_PUBLIC || "imagenes_publicas").trim() || "imagenes_publicas";
export const STORAGE_PRIVATE_BUCKET =
  String(process.env.SUPABASE_STORAGE_BUCKET_PRIVATE || "imagenes_privadas").trim() || "imagenes_privadas";

export const STORAGE_SCOPE_REGISTRY = Object.freeze({
  public_promotion_main: {
    key: "public_promotion_main",
    bucket: STORAGE_PUBLIC_BUCKET,
    visibility: STORAGE_VISIBILITY.PUBLIC,
    prefix: "promociones",
    entityType: "promocion",
    variant: "principal",
    requiresBranchId: true,
    requiresEntityId: false,
    allowedRoles: ["super_admin", "admin"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
  public_promotion_mobile: {
    key: "public_promotion_mobile",
    bucket: STORAGE_PUBLIC_BUCKET,
    visibility: STORAGE_VISIBILITY.PUBLIC,
    prefix: "promociones",
    entityType: "promocion",
    variant: "mobile",
    requiresBranchId: true,
    requiresEntityId: false,
    allowedRoles: ["super_admin", "admin"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
  public_branding: {
    key: "public_branding",
    bucket: STORAGE_PUBLIC_BUCKET,
    visibility: STORAGE_VISIBILITY.PUBLIC,
    prefix: "branding",
    entityType: "branding",
    variant: "principal",
    requiresBranchId: false,
    requiresEntityId: false,
    allowedRoles: ["super_admin"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
  private_client_profile: {
    key: "private_client_profile",
    bucket: STORAGE_PRIVATE_BUCKET,
    visibility: STORAGE_VISIBILITY.PRIVATE,
    prefix: "clientes",
    entityType: "cliente",
    variant: "avatar",
    requiresBranchId: false,
    requiresEntityId: true,
    // AM: La subida de foto privada del cliente es exclusivamente self-service del cliente.
    allowedRoles: ["cliente"],
    allowSelfService: true,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
  public_barber_profile: {
    key: "public_barber_profile",
    bucket: STORAGE_PUBLIC_BUCKET,
    visibility: STORAGE_VISIBILITY.PUBLIC,
    prefix: "barberos",
    entityType: "barbero",
    variant: "perfil",
    requiresBranchId: true,
    requiresEntityId: true,
    allowedRoles: ["super_admin", "admin"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
  public_gallery_item: {
    key: "public_gallery_item",
    bucket: STORAGE_PUBLIC_BUCKET,
    visibility: STORAGE_VISIBILITY.PUBLIC,
    prefix: "galeria",
    entityType: "galeria",
    variant: "item",
    requiresBranchId: true,
    requiresEntityId: true,
    allowedRoles: ["super_admin", "admin"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
  public_service_image: {
    key: "public_service_image",
    bucket: STORAGE_PUBLIC_BUCKET,
    visibility: STORAGE_VISIBILITY.PUBLIC,
    prefix: "servicios",
    entityType: "servicio",
    variant: "principal",
    requiresBranchId: true,
    requiresEntityId: true,
    allowedRoles: ["super_admin", "admin"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
  public_branch_cover: {
    key: "public_branch_cover",
    bucket: STORAGE_PUBLIC_BUCKET,
    visibility: STORAGE_VISIBILITY.PUBLIC,
    prefix: "sucursales",
    entityType: "sucursal",
    variant: "cover",
    requiresBranchId: true,
    requiresEntityId: true,
    allowedRoles: ["super_admin", "admin"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
});

export function getStorageScope(scopeKey) {
  if (!scopeKey) return null;
  return STORAGE_SCOPE_REGISTRY[String(scopeKey).trim()] || null;
}
