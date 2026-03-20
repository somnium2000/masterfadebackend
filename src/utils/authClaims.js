export const AUTH_CLAIMS_SQL = `
  WITH base_user AS (
    SELECT
      u.id_usuario,
      u.id_persona,
      p.nombres,
      p.apellidos,
      COALESCE(NULLIF(c.direccion_correo::text, ''), NULLIF(au.email::text, '')) AS email
    FROM public.usuarios u
    LEFT JOIN public.personas p
      ON p.id_persona = u.id_persona
    LEFT JOIN auth.users au
      ON au.id = u.id_usuario
    LEFT JOIN LATERAL (
      SELECT c.direccion_correo
      FROM public.correos c
      WHERE c.id_persona = u.id_persona
      ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
      LIMIT 1
    ) c ON TRUE
    WHERE u.id_usuario = $1::uuid
      AND u.deleted_at IS NULL
      AND u.estado IS TRUE
      AND u.estado_acceso <> 'bloqueado'
      AND u.estado_acceso <> 'inactivo'
  ),
  role_scope AS (
    SELECT
      COALESCE(
        array_agg(DISTINCT r.nombre ORDER BY r.nombre) FILTER (WHERE r.nombre IS NOT NULL),
        ARRAY[]::text[]
      ) AS roles,
      COALESCE(
        array_agg(DISTINCT ru.id_sucursal) FILTER (WHERE ru.id_sucursal IS NOT NULL),
        ARRAY[]::uuid[]
      ) AS branch_ids
    FROM public.roles_usuarios ru
    JOIN public.roles r
      ON r.id_rol = ru.id_rol
    WHERE ru.id_usuario = $1::uuid
      AND ru.activo IS TRUE
  ),
  empresa_scope AS (
    SELECT
      CASE
        WHEN COUNT(DISTINCT s.id_empresa) = 1 THEN ((array_agg(DISTINCT s.id_empresa::text ORDER BY s.id_empresa::text))[1])::uuid
        ELSE NULL
      END AS empresa_id
    FROM public.roles_usuarios ru
    JOIN public.sucursales s
      ON s.id_sucursal = ru.id_sucursal
    WHERE ru.id_usuario = $1::uuid
      AND ru.activo IS TRUE
      AND ru.id_sucursal IS NOT NULL
      AND s.deleted_at IS NULL
      AND s.estado IS TRUE
  ),
  empleado_scope AS (
    SELECT ((array_agg(e.id_empleado::text ORDER BY e.id_empleado::text))[1])::uuid AS empleado_id
    FROM base_user bu
    JOIN public.empleados e
      ON e.id_persona = bu.id_persona
    WHERE e.estado IS TRUE
      AND e.deleted_at IS NULL
  ),
  cliente_scope AS (
    SELECT ((array_agg(c.id_cliente::text ORDER BY c.id_cliente::text))[1])::uuid AS cliente_id
    FROM public.clientes c
    WHERE c.id_usuario = $1::uuid
      AND c.estado IS TRUE
      AND c.deleted_at IS NULL
  )
  SELECT
    bu.id_usuario,
    bu.id_persona,
    bu.email,
    bu.nombres,
    bu.apellidos,
    rs.roles,
    rs.branch_ids,
    es.empresa_id,
    ems.empleado_id,
    cls.cliente_id
  FROM base_user bu
  CROSS JOIN role_scope rs
  CROSS JOIN empresa_scope es
  CROSS JOIN empleado_scope ems
  CROSS JOIN cliente_scope cls
`;

export async function getAuthClaims(app, userId) {
  if (!app.db) {
    throw new Error("DB_NOT_CONFIGURED");
  }

  const { rows } = await app.db.query(AUTH_CLAIMS_SQL, [userId]);
  const row = rows?.[0];

  if (!row) {
    return null;
  }

  return {
    user: {
      id_usuario: row.id_usuario,
      id_persona: row.id_persona ?? null,
      email: row.email ?? null,
      nombres: row.nombres ?? null,
      apellidos: row.apellidos ?? null,
    },
    roles: Array.isArray(row.roles) ? row.roles : [],
    branch_ids: Array.isArray(row.branch_ids) ? row.branch_ids : [],
    empresa_id: row.empresa_id ?? null,
    empleado_id: row.empleado_id ?? null,
    cliente_id: row.cliente_id ?? null,
  };
}
