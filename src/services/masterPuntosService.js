import { AppError } from "../utils/errors.js";
import { assertUuid, getSystemParameters, resolveBranchIdsForClaims } from "./agendaService.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_RULE = {
  id_rule: null,
  scope: "global",
  id_sucursal: null,
  umbral_monto_hnl: 250,
  puntos_por_cita: 1,
  puntos_para_premio: 10,
  expiracion_meses: 12,
  activo: true,
  servicios_redimibles: [],
};
let legacyMigrationSchemaSupportCache = null;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeOptionalText(value) {
  if (value === undefined) return undefined;
  const clean = normalizeText(value);
  return clean || null;
}

function normalizeMoney(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError(400, `${field} debe ser un numero mayor o igual a cero`, {
      code: "MASTERPUNTOS_INVALID_NUMBER",
      details: { field, value },
    });
  }
  return amount;
}

function normalizePositiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(400, `${field} debe ser un entero mayor a cero`, {
      code: "MASTERPUNTOS_INVALID_INTEGER",
      details: { field, value },
    });
  }
  return parsed;
}

function normalizeBoolean(value, field) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  throw new AppError(400, `${field} debe ser booleano`, {
    code: "MASTERPUNTOS_INVALID_BOOLEAN",
    details: { field, value },
  });
}

function parseUuidArray(items, field) {
  const source = Array.isArray(items) ? items : [];
  const unique = [];
  const seen = new Set();
  for (const item of source) {
    const safe = assertUuid(item, field);
    if (!seen.has(safe)) {
      unique.push(safe);
      seen.add(safe);
    }
  }
  return unique;
}

function mapRuleRow(row, services = []) {
  if (!row) return null;
  return {
    id_rule: row.id_rule,
    scope: row.id_sucursal ? "sucursal" : "global",
    id_sucursal: row.id_sucursal ?? null,
    umbral_monto_hnl: Number(row.umbral_monto_hnl ?? 250),
    puntos_por_cita: Number(row.puntos_por_cita ?? 1),
    puntos_para_premio: Number(row.puntos_para_premio ?? 10),
    expiracion_meses: Number(row.expiracion_meses ?? 12),
    activo: Boolean(row.activo),
    servicios_redimibles: services,
    updated_at: row.updated_at ?? null,
  };
}

function mapServiceRow(row) {
  return {
    id_servicio: row.id_servicio,
    nombre_servicio: row.nombre_servicio,
    grupo_catalogo: row.grupo_catalogo ?? null,
  };
}

async function getScope(app, claims) {
  const branchIds = await resolveBranchIdsForClaims(app, claims);
  if (!branchIds.length) {
    throw new AppError(403, "No tienes sucursales dentro de tu alcance para masterpuntos", {
      code: "MASTERPUNTOS_SCOPE_EMPTY",
    });
  }
  const isSuperAdmin = Array.isArray(claims?.roles) && claims.roles.includes("super_admin");
  return { branchIds, isSuperAdmin };
}

function assertBranchInScope(branchIds, branchId) {
  if (!branchId) return;
  if (!branchIds.includes(branchId)) {
    throw new AppError(403, "Sucursal fuera de tu alcance", {
      code: "MASTERPUNTOS_BRANCH_FORBIDDEN",
      details: { id_sucursal: branchId },
    });
  }
}

async function materializeExpiredCycles(client, idCliente = null) {
  await client.query("SELECT public.fn_points_materialize_expired_cycles($1::uuid)", [idCliente]);
}

async function getLegacyMigrationConfig(client) {
  const params = await getSystemParameters(client);
  return {
    migracion_manual_habilitada: Boolean(params?.masterpuntos_migracion_manual_habilitada?.valor_booleano ?? false),
  };
}

async function getLegacyMigrationSchemaSupport(client) {
  if (legacyMigrationSchemaSupportCache) return legacyMigrationSchemaSupportCache;
  const { rows } = await client.query(
    `
      SELECT to_regclass('public.points_legacy_migrations') IS NOT NULL AS has_points_legacy_migrations
    `
  );
  legacyMigrationSchemaSupportCache = {
    has_points_legacy_migrations: Boolean(rows?.[0]?.has_points_legacy_migrations),
  };
  return legacyMigrationSchemaSupportCache;
}

async function ensureServicesEligible(client, serviceIds, { idSucursal = null } = {}) {
  if (!serviceIds.length) return [];

  const params = [serviceIds];
  let extraWhere = "";
  if (idSucursal) {
    params.push(idSucursal);
    extraWhere = `
      AND EXISTS (
        SELECT 1
        FROM public.servicios_tarifas st
        WHERE st.id_servicio = s.id_servicio
          AND st.id_sucursal = $2::uuid
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND st.id_empleado IS NULL
          AND st.vigente_desde <= CURRENT_DATE
          AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
      )
    `;
  }

  const { rows } = await client.query(
    `
      SELECT
        s.id_servicio,
        s.nombre_servicio,
        s.grupo_catalogo
      FROM public.servicios s
      WHERE s.id_servicio = ANY($1::uuid[])
        AND s.deleted_at IS NULL
        AND s.activo IS TRUE
        ${extraWhere}
      ORDER BY s.nombre_servicio ASC
    `,
    params
  );

  if (rows.length !== serviceIds.length) {
    throw new AppError(409, "Uno o mas servicios seleccionados no son validos para el alcance indicado", {
      code: "MASTERPUNTOS_REWARD_SERVICES_INVALID",
      details: { solicitados: serviceIds, encontrados: rows.map((row) => row.id_servicio) },
    });
  }

  return rows.map(mapServiceRow);
}

async function listRulesByScope(client, branchIds) {
  const { rows } = await client.query(
    `
      WITH ranked AS (
        SELECT
          pr.id_rule,
          pr.id_sucursal,
          pr.umbral_monto_hnl,
          pr.puntos_por_cita,
          pr.puntos_para_premio,
          pr.expiracion_meses,
          pr.activo,
          pr.created_at,
          pr.updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(pr.id_sucursal, $2::uuid)
            ORDER BY pr.activo DESC, pr.updated_at DESC, pr.created_at DESC, pr.id_rule DESC
          ) AS rn
        FROM public.points_rules pr
        WHERE pr.id_sucursal IS NULL
           OR pr.id_sucursal = ANY($1::uuid[])
      )
      SELECT
        r.id_rule,
        r.id_sucursal,
        r.umbral_monto_hnl,
        r.puntos_por_cita,
        r.puntos_para_premio,
        r.expiracion_meses,
        r.activo,
        r.updated_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id_servicio', prs.id_servicio,
              'nombre_servicio', s.nombre_servicio,
              'grupo_catalogo', s.grupo_catalogo
            )
            ORDER BY s.nombre_servicio
          ) FILTER (WHERE prs.id_servicio IS NOT NULL),
          '[]'::jsonb
        ) AS servicios
      FROM ranked r
      LEFT JOIN public.points_rule_services prs
        ON prs.id_rule = r.id_rule
      LEFT JOIN public.servicios s
        ON s.id_servicio = prs.id_servicio
      WHERE r.rn = 1
      GROUP BY
        r.id_rule,
        r.id_sucursal,
        r.umbral_monto_hnl,
        r.puntos_por_cita,
        r.puntos_para_premio,
        r.expiracion_meses,
        r.activo,
        r.updated_at
      ORDER BY r.id_sucursal NULLS FIRST
    `,
    [branchIds, NIL_UUID]
  );

  const global = rows.find((row) => row.id_sucursal == null) ?? null;
  const byBranch = rows.filter((row) => row.id_sucursal != null);
  return {
    regla_global: global ? mapRuleRow(global, Array.isArray(global.servicios) ? global.servicios : []) : { ...DEFAULT_RULE },
    reglas_sucursal: byBranch.map((row) => mapRuleRow(row, Array.isArray(row.servicios) ? row.servicios : [])),
  };
}

function normalizeRulePayload(payload = {}, { branchIds, isSuperAdmin }) {
  const scope = normalizeText(payload.scope || "global").toLowerCase();
  if (!["global", "sucursal"].includes(scope)) {
    throw new AppError(400, "scope debe ser global o sucursal", {
      code: "MASTERPUNTOS_SCOPE_INVALID",
    });
  }

  let idSucursal = null;
  if (scope === "sucursal") {
    idSucursal = assertUuid(payload.id_sucursal, "id_sucursal");
    assertBranchInScope(branchIds, idSucursal);
  }

  if (scope === "global" && !isSuperAdmin) {
    throw new AppError(403, "Solo super_admin puede actualizar la regla global", {
      code: "MASTERPUNTOS_GLOBAL_RULE_FORBIDDEN",
    });
  }

  const umbralMontoHnl = normalizeMoney(payload.umbral_monto_hnl, "umbral_monto_hnl");
  const puntosParaPremio = normalizePositiveInt(payload.puntos_para_premio, "puntos_para_premio");
  const activo = payload.activo === undefined ? true : normalizeBoolean(payload.activo, "activo");
  const expiracionMeses = payload.expiracion_meses === undefined
    ? 12
    : normalizePositiveInt(payload.expiracion_meses, "expiracion_meses");

  if (expiracionMeses !== 12) {
    throw new AppError(400, "expiracion_meses esta fijado en 12 (regla anual)", {
      code: "MASTERPUNTOS_EXPIRY_FIXED",
    });
  }

  const serviciosRedimibles = parseUuidArray(payload.servicios_redimibles, "servicios_redimibles");
  if (!serviciosRedimibles.length) {
    throw new AppError(400, "Debes enviar al menos un servicio redimible", {
      code: "MASTERPUNTOS_REWARD_SERVICES_REQUIRED",
    });
  }

  return {
    scope,
    id_sucursal: idSucursal,
    umbral_monto_hnl: umbralMontoHnl,
    puntos_por_cita: 1,
    puntos_para_premio: puntosParaPremio,
    expiracion_meses: 12,
    activo,
    servicios_redimibles: serviciosRedimibles,
  };
}

async function getRuleById(client, idRule) {
  const { rows } = await client.query(
    `
      SELECT
        pr.id_rule,
        pr.id_sucursal,
        pr.umbral_monto_hnl,
        pr.puntos_por_cita,
        pr.puntos_para_premio,
        pr.expiracion_meses,
        pr.activo,
        pr.updated_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id_servicio', prs.id_servicio,
              'nombre_servicio', s.nombre_servicio,
              'grupo_catalogo', s.grupo_catalogo
            )
            ORDER BY s.nombre_servicio
          ) FILTER (WHERE prs.id_servicio IS NOT NULL),
          '[]'::jsonb
        ) AS servicios
      FROM public.points_rules pr
      LEFT JOIN public.points_rule_services prs
        ON prs.id_rule = pr.id_rule
      LEFT JOIN public.servicios s
        ON s.id_servicio = prs.id_servicio
      WHERE pr.id_rule = $1::uuid
      GROUP BY
        pr.id_rule,
        pr.id_sucursal,
        pr.umbral_monto_hnl,
        pr.puntos_por_cita,
        pr.puntos_para_premio,
        pr.expiracion_meses,
        pr.activo,
        pr.updated_at
      LIMIT 1
    `,
    [idRule]
  );

  return mapRuleRow(rows[0], Array.isArray(rows[0]?.servicios) ? rows[0].servicios : []);
}

async function getClientCardById(client, idCliente, branchIds) {
  const legacySupport = await getLegacyMigrationSchemaSupport(client);
  const legacySelectSql = legacySupport.has_points_legacy_migrations
    ? "plm.id_migracion IS NOT NULL AS legacy_migracion_aplicada,"
    : "FALSE AS legacy_migracion_aplicada,";
  const legacyJoinSql = legacySupport.has_points_legacy_migrations
    ? `
      LEFT JOIN public.points_legacy_migrations plm
        ON plm.id_cliente = c.id_cliente
    `
    : "";
  const { rows } = await client.query(
    `
      WITH rule_by_branch AS (
        SELECT DISTINCT ON (COALESCE(pr.id_sucursal, $2::uuid))
          pr.id_sucursal,
          pr.puntos_para_premio
        FROM public.points_rules pr
        WHERE pr.activo IS TRUE
          AND (pr.id_sucursal IS NULL OR pr.id_sucursal = ANY($1::uuid[]))
        ORDER BY
          COALESCE(pr.id_sucursal, $2::uuid),
          pr.updated_at DESC,
          pr.created_at DESC,
          pr.id_rule DESC
      ),
      global_rule AS (
        SELECT puntos_para_premio
        FROM rule_by_branch
        WHERE id_sucursal IS NULL
        LIMIT 1
      ),
      cycle AS (
        SELECT
          pc.id_cliente,
          pc.primer_acumulado_at,
          pc.vence_at,
          pc.estado_ciclo_codigo
        FROM public.points_cycles pc
        WHERE pc.id_cliente = $3::uuid
        ORDER BY
          CASE WHEN pc.estado_ciclo_codigo = 'activo' AND pc.vence_at > now() THEN 0 ELSE 1 END,
          pc.primer_acumulado_at DESC
        LIMIT 1
      )
      SELECT
        c.id_cliente,
        c.id_persona,
        c.id_sucursal_origen,
        s.nombre_sucursal,
        p.nombres,
        p.apellidos,
        p.telefono_principal,
        cp.email AS correo_principal,
        COALESCE(vpb.balance_puntos, 0)::int AS balance_puntos,
        COALESCE(rbb.puntos_para_premio, (SELECT puntos_para_premio FROM global_rule), 10)::int AS puntos_para_premio,
        ${legacySelectSql}
        cycle.primer_acumulado_at,
        cycle.vence_at
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = c.id_sucursal_origen
      LEFT JOIN public.vw_points_balance vpb
        ON vpb.id_cliente = c.id_cliente
      LEFT JOIN rule_by_branch rbb
        ON rbb.id_sucursal = c.id_sucursal_origen
      LEFT JOIN cycle
        ON cycle.id_cliente = c.id_cliente
      ${legacyJoinSql}
      LEFT JOIN LATERAL (
        SELECT c2.direccion_correo::text AS email
        FROM public.correos c2
        WHERE c2.id_persona = c.id_persona
          AND c2.deleted_at IS NULL
        ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
        LIMIT 1
      ) cp ON TRUE
      WHERE c.id_cliente = $3::uuid
        AND c.deleted_at IS NULL
        AND c.id_sucursal_origen = ANY($1::uuid[])
      LIMIT 1
    `,
    [branchIds, NIL_UUID, idCliente]
  );

  const row = rows[0];
  if (!row) return null;

  const balance = Number(row.balance_puntos || 0);
  const required = Number(row.puntos_para_premio || 10);
  const progress = Math.max(0, Math.min(balance, required));
  const stars = Math.max(0, balance);
  const daysRemaining = row.vence_at
    ? Math.max(0, Math.floor((new Date(row.vence_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  return {
    id_cliente: row.id_cliente,
    id_persona: row.id_persona,
    id_sucursal_origen: row.id_sucursal_origen ?? null,
    nombre_sucursal: row.nombre_sucursal ?? null,
    nombre_completo: `${String(row.nombres || "").trim()} ${String(row.apellidos || "").trim()}`.trim() || "Cliente",
    telefono_principal: row.telefono_principal ?? null,
    correo_principal: row.correo_principal ?? null,
    balance_puntos: balance,
    estrellas: stars,
    primer_acumulado_at: row.primer_acumulado_at ?? null,
    vence_at: row.vence_at ?? null,
    dias_restantes: daysRemaining,
    progreso_actual: progress,
    puntos_para_premio: required,
    premio_disponible: balance >= required,
    legacy_migracion_aplicada: Boolean(row.legacy_migracion_aplicada),
  };
}

async function ensureClientInScope(client, idCliente, branchIds) {
  const { rows } = await client.query(
    `
      SELECT
        c.id_cliente,
        c.id_sucursal_origen,
        c.id_usuario,
        p.nombres,
        p.apellidos
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
      WHERE c.id_cliente = $1::uuid
        AND c.deleted_at IS NULL
        AND c.id_sucursal_origen = ANY($2::uuid[])
      LIMIT 1
    `,
    [idCliente, branchIds]
  );

  if (!rows[0]) {
    throw new AppError(404, "Cliente no encontrado dentro de tu alcance", {
      code: "MASTERPUNTOS_CLIENT_NOT_FOUND",
      details: { id_cliente: idCliente },
    });
  }

  return rows[0];
}

export async function getMasterPuntosContext(app, claims) {
  const { branchIds } = await getScope(app, claims);
  const client = await app.db.connect();
  try {
    const [branchesResult, servicesResult, rules, config] = await Promise.all([
      client.query(
        `
          SELECT id_sucursal, nombre_sucursal
          FROM public.sucursales
          WHERE id_sucursal = ANY($1::uuid[])
            AND deleted_at IS NULL
            AND estado IS TRUE
          ORDER BY nombre_sucursal ASC
        `,
        [branchIds]
      ),
      client.query(
        `
          SELECT id_servicio, nombre_servicio, grupo_catalogo
          FROM public.servicios
          WHERE deleted_at IS NULL
            AND activo IS TRUE
          ORDER BY nombre_servicio ASC
        `
      ),
      listRulesByScope(client, branchIds),
      getLegacyMigrationConfig(client),
    ]);

    return {
      sucursales: branchesResult.rows,
      servicios_catalogo: servicesResult.rows.map(mapServiceRow),
      regla_global: rules.regla_global,
      reglas_sucursal: rules.reglas_sucursal,
      parametros: config,
    };
  } finally {
    client.release();
  }
}

export async function listMasterPuntosClientes(app, claims, query = {}) {
  const { branchIds } = await getScope(app, claims);
  const client = await app.db.connect();
  try {
    const [config, legacySupport] = await Promise.all([
      getLegacyMigrationConfig(client),
      getLegacyMigrationSchemaSupport(client),
    ]);
    const legacySelectSql = legacySupport.has_points_legacy_migrations
      ? "plm.id_migracion IS NOT NULL AS legacy_migracion_aplicada,"
      : "FALSE AS legacy_migracion_aplicada,";
    const legacyJoinSql = legacySupport.has_points_legacy_migrations
      ? `
        LEFT JOIN public.points_legacy_migrations plm
          ON plm.id_cliente = c.id_cliente
      `
      : "";

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = normalizeOptionalText(query.search ?? query.q);
    const soloPremio = String(query.solo_premio || '').toLowerCase() === 'true';

    // 1) COUNT QUERY Y PARAMETROS INDEPENDIENTES
    const countParams = [branchIds, NIL_UUID];
    const countWhere = [
      "c.deleted_at IS NULL",
      "c.id_sucursal_origen = ANY($1::uuid[])"
    ];

    if (search) {
      countParams.push(`%${search}%`);
      const idx = countParams.length;
      countWhere.push(`(
        CONCAT(COALESCE(p.nombres, ''), ' ', COALESCE(p.apellidos, '')) ILIKE ${idx}
        OR COALESCE(cp.email, '') ILIKE ${idx}
        OR COALESCE(p.telefono_principal, '') ILIKE ${idx}
      )`);
    }

    if (query.id_sucursal) {
      const idSucursal = assertUuid(query.id_sucursal, "id_sucursal");
      assertBranchInScope(branchIds, idSucursal);
      countParams.push(idSucursal);
      const idx = countParams.length;
      countWhere.push(`c.id_sucursal_origen = ${idx}::uuid`);
    }

    await materializeExpiredCycles(client, null);

    const countQuerySql = `
      WITH rules_by_branch AS (
        SELECT DISTINCT ON (COALESCE(pr.id_sucursal, $2::uuid))
          pr.id_sucursal,
          pr.puntos_para_premio
        FROM public.points_rules pr
        WHERE pr.activo IS TRUE
          AND (pr.id_sucursal IS NULL OR pr.id_sucursal = ANY($1::uuid[]))
        ORDER BY
          COALESCE(pr.id_sucursal, $2::uuid),
          pr.updated_at DESC,
          pr.created_at DESC,
          pr.id_rule DESC
      ),
      global_rule AS (
        SELECT puntos_para_premio
        FROM rules_by_branch
        WHERE id_sucursal IS NULL
        LIMIT 1
      )
      SELECT COUNT(*) AS total
      FROM public.clientes c
      JOIN public.personas p ON p.id_persona = c.id_persona
      LEFT JOIN LATERAL (
        SELECT c2.direccion_correo::text AS email
        FROM public.correos c2
        WHERE c2.id_persona = c.id_persona
          AND c2.deleted_at IS NULL
        ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
        LIMIT 1
      ) cp ON TRUE
      LEFT JOIN public.vw_points_balance vpb ON vpb.id_cliente = c.id_cliente
      LEFT JOIN rules_by_branch rbb ON rbb.id_sucursal = c.id_sucursal_origen
      WHERE ${countWhere.join(" AND ")}
        AND COALESCE(vpb.balance_puntos, 0) > 0
        ${soloPremio ? "AND COALESCE(vpb.balance_puntos, 0) >= COALESCE(rbb.puntos_para_premio, (SELECT puntos_para_premio FROM global_rule), 10)" : ""}
    `;
    const countResult = await client.query(countQuerySql, countParams);
    const total = parseInt(countResult.rows[0].total, 10);

    // 2) MAIN QUERY Y PARAMETROS INDEPENDIENTES
    const params = [branchIds, NIL_UUID];
    const mainWhere = [
      "c.deleted_at IS NULL",
      "c.id_sucursal_origen = ANY($1::uuid[])"
    ];

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      mainWhere.push(`(
        CONCAT(COALESCE(p.nombres, ''), ' ', COALESCE(p.apellidos, '')) ILIKE ${idx}
        OR COALESCE(cp.email, '') ILIKE ${idx}
        OR COALESCE(p.telefono_principal, '') ILIKE ${idx}
      )`);
    }

    if (query.id_sucursal) {
      const idSucursal = assertUuid(query.id_sucursal, "id_sucursal");
      params.push(idSucursal);
      const idx = params.length;
      mainWhere.push(`c.id_sucursal_origen = ${idx}::uuid`);
    }

    const { rows } = await client.query(
      `
        WITH scoped_clients AS (
          SELECT
            c.id_cliente,
            c.id_persona,
            c.id_sucursal_origen
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
          LEFT JOIN public.vw_points_balance vpb ON vpb.id_cliente = c.id_cliente
          LEFT JOIN (
            SELECT DISTINCT ON (COALESCE(pr.id_sucursal, $2::uuid))
              pr.id_sucursal,
              pr.puntos_para_premio
            FROM public.points_rules pr
            WHERE pr.activo IS TRUE
              AND (pr.id_sucursal IS NULL OR pr.id_sucursal = ANY($1::uuid[]))
            ORDER BY
              COALESCE(pr.id_sucursal, $2::uuid),
              pr.updated_at DESC,
              pr.created_at DESC,
              pr.id_rule DESC
          ) rbb ON rbb.id_sucursal = c.id_sucursal_origen
          WHERE ${mainWhere.join(" AND ")}
            AND COALESCE(vpb.balance_puntos, 0) > 0
            ${soloPremio ? "AND COALESCE(vpb.balance_puntos, 0) >= COALESCE(rbb.puntos_para_premio, 10)" : ""}
        ),
        rules_by_branch AS (
          SELECT DISTINCT ON (COALESCE(pr.id_sucursal, $2::uuid))
            pr.id_sucursal,
            pr.puntos_para_premio
          FROM public.points_rules pr
          WHERE pr.activo IS TRUE
            AND (pr.id_sucursal IS NULL OR pr.id_sucursal = ANY($1::uuid[]))
          ORDER BY
            COALESCE(pr.id_sucursal, $2::uuid),
            pr.updated_at DESC,
            pr.created_at DESC,
            pr.id_rule DESC
        ),
        global_rule AS (
          SELECT puntos_para_premio
          FROM rules_by_branch
          WHERE id_sucursal IS NULL
          LIMIT 1
        ),
        latest_cycle AS (
          SELECT DISTINCT ON (pc.id_cliente)
            pc.id_cliente,
            pc.primer_acumulado_at,
            pc.vence_at,
            pc.estado_ciclo_codigo
          FROM public.points_cycles pc
          WHERE pc.id_cliente IN (SELECT id_cliente FROM scoped_clients)
          ORDER BY
            pc.id_cliente,
            CASE WHEN pc.estado_ciclo_codigo = 'activo' AND pc.vence_at > now() THEN 0 ELSE 1 END,
            pc.primer_acumulado_at DESC
        )
        SELECT
          c.id_cliente,
          c.id_persona,
          c.id_sucursal_origen,
          s.nombre_sucursal,
          p.nombres,
          p.apellidos,
          p.telefono_principal,
          cp.email AS correo_principal,
          COALESCE(vpb.balance_puntos, 0)::int AS balance_puntos,
          COALESCE(rbb.puntos_para_premio, (SELECT puntos_para_premio FROM global_rule), 10)::int AS puntos_para_premio,
          ${legacySelectSql}
          lc.primer_acumulado_at,
          lc.vence_at
        FROM scoped_clients c
        JOIN public.personas p
          ON p.id_persona = c.id_persona
        LEFT JOIN public.sucursales s
          ON s.id_sucursal = c.id_sucursal_origen
        LEFT JOIN public.vw_points_balance vpb
          ON vpb.id_cliente = c.id_cliente
        LEFT JOIN rules_by_branch rbb
          ON rbb.id_sucursal = c.id_sucursal_origen
        LEFT JOIN latest_cycle lc
          ON lc.id_cliente = c.id_cliente
        ${legacyJoinSql}
        LEFT JOIN LATERAL (
          SELECT c2.direccion_correo::text AS email
          FROM public.correos c2
          WHERE c2.id_persona = c.id_persona
            AND c2.deleted_at IS NULL
          ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
          LIMIT 1
        ) cp ON TRUE
        ORDER BY p.nombres ASC, p.apellidos ASC, c.id_cliente ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      params
    );

    return {
      clientes: rows.map((row) => {
        const balance = Number(row.balance_puntos || 0);
        const required = Number(row.puntos_para_premio || 10);
        const progress = Math.max(0, Math.min(balance, required));
        const stars = Math.max(0, balance);
        const daysRemaining = row.vence_at
          ? Math.max(0, Math.floor((new Date(row.vence_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
          : null;

        return {
          id_cliente: row.id_cliente,
          id_persona: row.id_persona,
          id_sucursal_origen: row.id_sucursal_origen ?? null,
          nombre_sucursal: row.nombre_sucursal ?? null,
          nombre_completo: `${String(row.nombres || "").trim()} ${String(row.apellidos || "").trim()}`.trim() || "Cliente",
          telefono_principal: row.telefono_principal ?? null,
          correo_principal: row.correo_principal ?? null,
          balance_puntos: balance,
          estrellas: stars,
          primer_acumulado_at: row.primer_acumulado_at ?? null,
          vence_at: row.vence_at ?? null,
          dias_restantes: daysRemaining,
          progreso_actual: progress,
          puntos_para_premio: required,
          premio_disponible: balance >= required,
          legacy_migracion_aplicada: Boolean(row.legacy_migracion_aplicada),
        };
      }),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    app.log.error(err);
    throw new AppError(500, "Error al listar clientes de MasterPuntos", {
      code: "MASTERPUNTOS_LIST_CLIENTS_ERROR",
      details: err.message,
    });
  } finally {
    client.release();
  }
}

export async function getMasterPuntosClienteMovimientos(app, claims, idCliente, query = {}) {
  const { branchIds } = await getScope(app, claims);
  const safeId = assertUuid(idCliente, "id_cliente");
  const client = await app.db.connect();
  try {
    await ensureClientInScope(client, safeId, branchIds);
    await materializeExpiredCycles(client, safeId);

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    const offset = (page - 1) * limit;

    const countResult = await client.query(
      `SELECT COUNT(*) AS total FROM public.points_ledger WHERE id_cliente = $1::uuid`,
      [safeId]
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const { rows } = await client.query(
      `
        SELECT
          l.id_ledger,
          l.tipo_movimiento,
          l.puntos,
          l.motivo,
          l.id_referencia_origen,
          l.created_at,
          u.username AS usuario_registra,
          l.id_sucursal
        FROM public.points_ledger l
        LEFT JOIN public.usuarios u
          ON u.id_usuario = l.created_by_usuario_id
        WHERE l.id_cliente = $1::uuid
        ORDER BY l.created_at DESC, l.id_ledger DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      [safeId]
    );

    return {
      movimientos: rows.map((row) => ({
        id_ledger: row.id_ledger,
        tipo_movimiento: row.tipo_movimiento,
        puntos: Number(row.puntos || 0),
        motivo: row.motivo ?? null,
        id_referencia_origen: row.id_referencia_origen ?? null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
        usuario_registra: row.usuario_registra ?? "Sistema",
        id_sucursal: row.id_sucursal ?? null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      }
    };
  } finally {
    client.release();
  }
}
export async function updateMasterPuntosRegla(app, claims, payload = {}) {
  const scope = await getScope(app, claims);
  const normalized = normalizeRulePayload(payload, scope);
  const client = await app.db.connect();
  try {
    const validatedServices = await ensureServicesEligible(client, normalized.servicios_redimibles, {
      idSucursal: normalized.id_sucursal,
    });

    await client.query("BEGIN");
    const current = await client.query(
      `
        SELECT id_rule
        FROM public.points_rules
        WHERE id_sucursal IS NOT DISTINCT FROM $1::uuid
        ORDER BY updated_at DESC, created_at DESC, id_rule DESC
        LIMIT 1
        FOR UPDATE
      `,
      [normalized.id_sucursal]
    );

    let idRule = current.rows[0]?.id_rule ?? null;
    if (idRule) {
      await client.query(
        `
          UPDATE public.points_rules
          SET
            umbral_monto_hnl = $2::numeric,
            puntos_por_cita = $3::int,
            puntos_para_premio = $4::int,
            expiracion_meses = 12,
            activo = $5::boolean,
            updated_at = now()
          WHERE id_rule = $1::uuid
        `,
        [
          idRule,
          normalized.umbral_monto_hnl,
          normalized.puntos_por_cita,
          normalized.puntos_para_premio,
          normalized.activo,
        ]
      );
    } else {
      const inserted = await client.query(
        `
          INSERT INTO public.points_rules (
            id_sucursal,
            umbral_monto_hnl,
            puntos_por_cita,
            puntos_para_premio,
            expiracion_meses,
            activo
          )
          VALUES ($1::uuid, $2::numeric, $3::int, $4::int, 12, $5::boolean)
          RETURNING id_rule
        `,
        [
          normalized.id_sucursal,
          normalized.umbral_monto_hnl,
          normalized.puntos_por_cita,
          normalized.puntos_para_premio,
          normalized.activo,
        ]
      );
      idRule = inserted.rows[0].id_rule;
    }

    if (normalized.activo) {
      await client.query(
        `
          UPDATE public.points_rules
          SET activo = false,
              updated_at = now()
          WHERE id_sucursal IS NOT DISTINCT FROM $1::uuid
            AND id_rule <> $2::uuid
            AND activo IS TRUE
        `,
        [normalized.id_sucursal, idRule]
      );
    }

    await client.query("DELETE FROM public.points_rule_services WHERE id_rule = $1::uuid", [idRule]);
    for (const service of validatedServices) {
      await client.query(
        `
          INSERT INTO public.points_rule_services (id_rule, id_servicio)
          VALUES ($1::uuid, $2::uuid)
          ON CONFLICT (id_rule, id_servicio) DO NOTHING
        `,
        [idRule, service.id_servicio]
      );
    }

    const rule = await getRuleById(client, idRule);
    await client.query("COMMIT");
    return { regla: rule };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createMasterPuntosCanje(app, claims, payload = {}) {
  const { branchIds } = await getScope(app, claims);
  const idCliente = assertUuid(payload.id_cliente, "id_cliente");
  const idServicio = assertUuid(payload.id_servicio, "id_servicio");
  const idSucursal = payload.id_sucursal ? assertUuid(payload.id_sucursal, "id_sucursal") : null;

  if (idSucursal) {
    assertBranchInScope(branchIds, idSucursal);
  }

  const client = await app.db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [idCliente]);
    const cliente = await ensureClientInScope(client, idCliente, branchIds);
    if (!cliente.id_usuario) {
      throw new AppError(409, "No se puede canjear: el cliente no tiene usuario activo", {
        code: "MASTERPUNTOS_CLIENT_WITHOUT_USER",
      });
    }

    await materializeExpiredCycles(client, idCliente);

    const branchTarget = idSucursal ?? cliente.id_sucursal_origen ?? null;
    const effectiveRuleResult = await client.query(
      `
        SELECT *
        FROM public.fn_points_get_effective_rule($1::uuid)
        LIMIT 1
      `,
      [branchTarget]
    );

    const effectiveRule = effectiveRuleResult.rows[0] ?? null;
    if (!effectiveRule) {
      throw new AppError(409, "No hay una regla activa para ejecutar canjes en el alcance indicado", {
        code: "MASTERPUNTOS_RULE_NOT_FOUND",
      });
    }

    const pointsRequired = Number(effectiveRule.puntos_para_premio ?? 10);
    const serviceResult = await client.query(
      `
        SELECT
          prs.id_servicio,
          s.nombre_servicio
        FROM public.points_rule_services prs
        JOIN public.servicios s
          ON s.id_servicio = prs.id_servicio
        WHERE prs.id_rule = $1::uuid
          AND prs.id_servicio = $2::uuid
          AND s.deleted_at IS NULL
          AND s.activo IS TRUE
        LIMIT 1
      `,
      [effectiveRule.id_rule, idServicio]
    );

    if (!serviceResult.rows[0]) {
      throw new AppError(409, "El servicio no esta habilitado para canje en la regla activa", {
        code: "MASTERPUNTOS_REWARD_SERVICE_FORBIDDEN",
      });
    }

    await ensureServicesEligible(client, [idServicio], { idSucursal: branchTarget });

    const balanceResult = await client.query(
      `
        SELECT COALESCE(balance_puntos, 0)::int AS balance_puntos
        FROM public.vw_points_balance
        WHERE id_cliente = $1::uuid
      `,
      [idCliente]
    );
    const balance = Number(balanceResult.rows[0]?.balance_puntos ?? 0);
    if (balance < pointsRequired) {
      throw new AppError(409, "No hay puntos suficientes para canjear el premio", {
        code: "MASTERPUNTOS_INSUFFICIENT_BALANCE",
        details: { balance_actual: balance, puntos_requeridos: pointsRequired },
      });
    }

    const cycleResult = await client.query(
      `
        SELECT id_cycle
        FROM public.points_cycles
        WHERE id_cliente = $1::uuid
          AND estado_ciclo_codigo = 'activo'
          AND vence_at > now()
        ORDER BY primer_acumulado_at ASC
        LIMIT 1
      `,
      [idCliente]
    );
    const cycleId = cycleResult.rows[0]?.id_cycle ?? null;

    const inserted = await client.query(
      `
        INSERT INTO public.points_transactions (
          id_cliente,
          id_cycle,
          id_sucursal_origen,
          id_servicio_canje,
          tipo_puntos_codigo,
          puntos,
          motivo,
          creado_por_usuario_id
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'canjear', $5::int, $6::text, $7::uuid)
        RETURNING
          id_points_tx,
          id_cliente,
          id_cycle,
          id_sucursal_origen,
          id_servicio_canje,
          tipo_puntos_codigo,
          puntos,
          motivo,
          created_at
      `,
      [
        idCliente,
        cycleId,
        branchTarget,
        idServicio,
        pointsRequired,
        normalizeOptionalText(payload.motivo) || "Canje manual de premio Masterpuntos",
        claims?.user?.id_usuario ?? null,
      ]
    );

    const refreshedCard = await getClientCardById(client, idCliente, branchIds);
    await client.query("COMMIT");

    return {
      canje: {
        ...inserted.rows[0],
        nombre_servicio_canje: serviceResult.rows[0].nombre_servicio,
        puntos_ajustados: -Math.abs(Number(inserted.rows[0].puntos ?? pointsRequired)),
      },
      cliente: refreshedCard,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createMasterPuntosLegacyMigration(app, claims, payload = {}) {
  const { branchIds } = await getScope(app, claims);
  const idCliente = assertUuid(payload.id_cliente, "id_cliente");
  const puntos = normalizePositiveInt(payload.puntos, "puntos");
  const motivo = normalizeOptionalText(payload.motivo) || "Migracion manual de sellos";

  const client = await app.db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [idCliente]);
    const config = await getLegacyMigrationConfig(client);
    const legacySupport = await getLegacyMigrationSchemaSupport(client);
    if (!config.migracion_manual_habilitada) {
      throw new AppError(409, "La migracion manual legacy de puntos esta deshabilitada", {
        code: "MASTERPUNTOS_LEGACY_DISABLED",
      });
    }
    if (!legacySupport.has_points_legacy_migrations) {
      throw new AppError(409, "Falta aplicar la migracion de base de datos para migracion legacy de puntos", {
        code: "MASTERPUNTOS_LEGACY_MIGRATION_REQUIRED",
      });
    }

    const cliente = await ensureClientInScope(client, idCliente, branchIds);
    const existsResult = await client.query(
      `
        SELECT id_migracion
        FROM public.points_legacy_migrations
        WHERE id_cliente = $1::uuid
        LIMIT 1
      `,
      [idCliente]
    );
    if (existsResult.rows[0]) {
      throw new AppError(409, "Este cliente ya tiene migracion legacy aplicada", {
        code: "MASTERPUNTOS_LEGACY_ALREADY_MIGRATED",
        details: { id_cliente: idCliente },
      });
    }

    await materializeExpiredCycles(client, idCliente);
    const branchTarget = cliente.id_sucursal_origen ?? null;
    const effectiveRuleResult = await client.query(
      `
        SELECT *
        FROM public.fn_points_get_effective_rule($1::uuid)
        LIMIT 1
      `,
      [branchTarget]
    );
    const effectiveRule = effectiveRuleResult.rows[0] ?? null;
    const expiracionMeses = Number(effectiveRule?.expiracion_meses ?? 12);
    const cycleResult = await client.query(
      `
        SELECT id_cycle, primer_acumulado_at, vence_at
        FROM public.fn_points_get_or_create_active_cycle($1::uuid, $2::int, now())
        LIMIT 1
      `,
      [idCliente, expiracionMeses]
    );
    const cycle = cycleResult.rows[0] ?? null;
    if (!cycle?.id_cycle) {
      throw new AppError(409, "No se pudo crear/obtener ciclo activo de puntos", {
        code: "MASTERPUNTOS_LEGACY_CYCLE_ERROR",
      });
    }

    const txResult = await client.query(
      `
        INSERT INTO public.points_transactions (
          id_cliente,
          id_cycle,
          id_sucursal_origen,
          tipo_puntos_codigo,
          puntos,
          vence_at,
          motivo,
          creado_por_usuario_id
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, 'acumular', $4::int, $5::timestamptz, $6::text, $7::uuid)
        RETURNING id_points_tx, created_at
      `,
      [
        idCliente,
        cycle.id_cycle,
        branchTarget,
        puntos,
        cycle.vence_at,
        motivo,
        claims?.user?.id_usuario ?? null,
      ]
    );
    const tx = txResult.rows[0];

    await client.query(
      `
        INSERT INTO public.points_legacy_migrations (
          id_cliente,
          id_points_tx,
          puntos_migrados,
          motivo,
          creado_por_usuario_id
        )
        VALUES ($1::uuid, $2::uuid, $3::int, $4::text, $5::uuid)
      `,
      [
        idCliente,
        tx.id_points_tx,
        puntos,
        motivo,
        claims?.user?.id_usuario ?? null,
      ]
    );

    const refreshedCard = await getClientCardById(client, idCliente, branchIds);
    await client.query("COMMIT");
    return {
      migracion: {
        id_cliente: idCliente,
        puntos_migrados: puntos,
        id_points_tx: tx.id_points_tx,
        created_at: tx.created_at,
      },
      cliente: refreshedCard,
      parametros: config,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
