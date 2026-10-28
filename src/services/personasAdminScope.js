import { AppError } from "../utils/errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function forbiddenBranch() {
  return new AppError(403, "No tienes permisos para gestionar este registro en su sucursal", {
    code: "AUTH_FORBIDDEN_BRANCH",
  });
}

export async function getPersonasAdminScope(client, claims, { lock = false } = {}) {
  if (claims?.roles?.includes("super_admin")) return { global: true, branchIds: [] };
  const userId = claims?.user?.id_usuario;
  if (!claims?.roles?.includes("admin") || !UUID_PATTERN.test(String(userId || ""))) {
    throw forbiddenBranch();
  }
  // AM: branch_ids mezcla roles; solo las asignaciones admin activas conceden alcance.
  const { rows } = await client.query(
    `/* AM: PERSONAS_ADMIN_BRANCHES */
     SELECT ru.id_sucursal
     FROM public.roles_usuarios ru
     JOIN public.roles r ON r.id_rol = ru.id_rol
     WHERE ru.id_usuario = $1::uuid
       AND ru.activo IS TRUE
       AND r.nombre = 'admin'
       AND ru.id_sucursal IS NOT NULL
     ${lock ? "FOR SHARE OF ru" : ""}`,
    [userId]
  );
  return {
    global: false,
    branchIds: [...new Set(rows.map((row) => String(row.id_sucursal || "").toLowerCase()).filter((id) => UUID_PATTERN.test(id)))],
  };
}

export function assertPersonasBranchScope(scope, branchId) {
  if (!scope.global && !scope.branchIds.includes(String(branchId || "").toLowerCase())) throw forbiddenBranch();
}

function personaScopePredicate(personaColumn, branchParameter) {
  // AM: Se oculta la cuenta completa si comparte datos o ciclo de vida con otro alcance.
  return `(
    EXISTS (
      SELECT 1 FROM public.empleados scope_employee
      WHERE scope_employee.id_persona = ${personaColumn}
        AND scope_employee.deleted_at IS NULL
        AND scope_employee.id_sucursal = ANY(${branchParameter}::uuid[])
      UNION ALL
      SELECT 1 FROM public.clientes scope_client
      WHERE scope_client.id_persona = ${personaColumn}
        AND scope_client.deleted_at IS NULL
        AND scope_client.id_sucursal_origen = ANY(${branchParameter}::uuid[])
      UNION ALL
      SELECT 1 FROM public.usuarios scope_user
      JOIN public.roles_usuarios scope_role ON scope_role.id_usuario = scope_user.id_usuario
      JOIN public.roles scope_role_name ON scope_role_name.id_rol = scope_role.id_rol
      WHERE scope_user.id_persona = ${personaColumn}
        AND scope_user.deleted_at IS NULL
        AND scope_role.activo IS TRUE
        AND scope_role_name.nombre = 'admin'
        AND scope_role.id_sucursal = ANY(${branchParameter}::uuid[])
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.empleados scope_employee
      WHERE scope_employee.id_persona = ${personaColumn}
        AND scope_employee.deleted_at IS NULL
        AND (scope_employee.id_sucursal IS NULL
          OR NOT (scope_employee.id_sucursal = ANY(${branchParameter}::uuid[])))
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.clientes scope_client
      WHERE scope_client.id_persona = ${personaColumn}
        AND scope_client.deleted_at IS NULL
        AND (scope_client.id_sucursal_origen IS NULL
          OR NOT (scope_client.id_sucursal_origen = ANY(${branchParameter}::uuid[])))
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.clientes scope_client
      JOIN public.usuarios scope_owner ON scope_owner.id_usuario = scope_client.id_usuario
      WHERE scope_client.deleted_at IS NULL
        AND (scope_client.id_persona = ${personaColumn} OR scope_owner.id_persona = ${personaColumn})
        AND scope_client.id_persona IS DISTINCT FROM scope_owner.id_persona
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.usuarios scope_user
      JOIN public.app_protected_users scope_protected
        ON scope_protected.id_usuario = scope_user.id_usuario AND scope_protected.activo IS TRUE
      WHERE scope_user.id_persona = ${personaColumn}
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.usuarios scope_user
      JOIN public.roles_usuarios scope_role ON scope_role.id_usuario = scope_user.id_usuario
      JOIN public.roles scope_role_name ON scope_role_name.id_rol = scope_role.id_rol
      WHERE scope_user.id_persona = ${personaColumn}
        AND (
          scope_role_name.nombre IN ('root', 'super_admin')
          OR (scope_role.id_sucursal IS NOT NULL
            AND NOT (scope_role.id_sucursal = ANY(${branchParameter}::uuid[])))
          OR (scope_role.id_sucursal IS NULL AND (
            scope_role_name.nombre <> 'cliente'
            OR NOT EXISTS (
              SELECT 1 FROM public.clientes scope_client
              WHERE scope_client.id_usuario = scope_user.id_usuario
                AND scope_client.deleted_at IS NULL
                AND scope_client.id_sucursal_origen = ANY(${branchParameter}::uuid[])
            )
          ))
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.empleados scope_employee
      WHERE scope_employee.id_persona = ${personaColumn}
        AND scope_employee.deleted_at IS NULL
        AND scope_employee.roles_reactivacion IS NOT NULL
        AND (
          jsonb_typeof(scope_employee.roles_reactivacion) <> 'array'
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(scope_employee.roles_reactivacion) = 'array'
                THEN scope_employee.roles_reactivacion ELSE '[]'::jsonb END
            ) restored_role
            WHERE restored_role->>'rol' IN ('root', 'super_admin')
              OR restored_role->>'sucursal' IS NULL
              OR NOT (restored_role->>'sucursal' = ANY(
                ARRAY(SELECT unnest(${branchParameter}::uuid[])::text)
              ))
          )
        )
    )
  )`;
}

const READ_RULES = {
  empleado: { marker: "  WHERE e.deleted_at IS NULL", persona: "e.id_persona", branch: "e.id_sucursal" },
  cliente: { marker: "  WHERE c.deleted_at IS NULL", persona: "c.id_persona", branch: "c.id_sucursal_origen" },
  usuario: { marker: "  WHERE u.deleted_at IS NULL", persona: "u.id_persona" },
  catalogo: { marker: "WHERE deleted_at IS NULL", branch: "id_sucursal" },
};

export function scopePersonasQuery(sql, params, scope, kind) {
  if (scope.global) return { text: sql, values: params };
  const rule = READ_RULES[kind];
  if (!rule || !sql.includes(rule.marker)) throw new Error("PERSONAS_SCOPE_QUERY_UNSUPPORTED");
  const parameter = `$${params.length + 1}`;
  // AM: Un administrador sin perfil empleado/cliente se acredita por su asignación real.
  const source = kind === "usuario"
    ? sql.replace("AND r_sa.nombre = 'super_admin'", `AND r_sa.nombre = 'admin' AND ru_sa.id_sucursal = ANY(${parameter}::uuid[])`)
    : sql;
  const conditions = [];
  if (rule.branch) conditions.push(`${rule.branch} = ANY(${parameter}::uuid[])`);
  if (rule.persona) conditions.push(personaScopePredicate(rule.persona, parameter));
  // AM: El predicado queda antes de búsqueda, agregación, conteo, LIMIT y OFFSET.
  const filter = ` AND /* AM: PERSONAS_SCOPE_BEGIN */ ${conditions.join(" AND ")} /* AM: PERSONAS_SCOPE_END */`;
  return {
    text: `/* AM: PERSONAS_SCOPE_READ */ ${source.replace(rule.marker, rule.marker + filter)}`,
    values: [...params, scope.branchIds],
  };
}

const TARGET_RULES = {
  empleado: { table: "empleados", column: "id_empleado", join: "target.id_persona = p.id_persona" },
  cliente: { table: "clientes", column: "id_cliente", join: "target.id_persona = p.id_persona" },
  usuario: { table: "usuarios", column: "id_usuario", join: "target.id_persona = p.id_persona" },
  persona: null,
};

export async function assertPersonasTargetScope(client, scope, kind, id, { lock = false } = {}) {
  if (scope.global) return;
  if (!UUID_PATTERN.test(String(id || "")) || !Object.hasOwn(TARGET_RULES, kind)) throw forbiddenBranch();
  const rule = TARGET_RULES[kind];
  const { rowCount } = await client.query(
    `/* AM: PERSONAS_SCOPE_TARGET */
     SELECT p.id_persona
     FROM public.personas p
     ${rule ? `JOIN public.${rule.table} target ON ${rule.join}` : ""}
     WHERE p.deleted_at IS NULL
       AND ${rule ? `target.${rule.column}` : "p.id_persona"} = $1::uuid
       ${rule ? "AND target.deleted_at IS NULL" : ""}
       AND ${personaScopePredicate("p.id_persona", "$2")}
     LIMIT 1
     ${lock ? `FOR UPDATE OF p${rule ? ", target" : ""}` : ""}`,
    [id, scope.branchIds]
  );
  if (!rowCount) throw forbiddenBranch();
}

export async function authorizePersonasMutation(client, claims, { kind, id, branchId, lock = false } = {}) {
  const scope = await getPersonasAdminScope(client, claims, { lock });
  if (branchId !== undefined) assertPersonasBranchScope(scope, branchId);
  if (id) await assertPersonasTargetScope(client, scope, kind, id, { lock });
  return scope;
}
