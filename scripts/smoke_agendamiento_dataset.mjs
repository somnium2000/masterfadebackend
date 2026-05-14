import fs from "node:fs";
import { promises as fsAsync } from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const OUTPUT_FILE = "tmp_smoke_dataset_phase17.json";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function pickPgConfig() {
  return {
    connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || undefined,
    host: process.env.DB_HOST || undefined,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    user: process.env.DB_USER || undefined,
    password: process.env.DB_PASSWORD || undefined,
    database: process.env.DB_NAME || undefined,
    ssl: String(process.env.DB_SSL || "").toLowerCase() === "true" ? { rejectUnauthorized: false } : undefined,
    max: 2,
  };
}

async function queryAttempt(client, diagnostics, key, sql, params = []) {
  try {
    const result = await client.query(sql, params);
    diagnostics.query_attempts.push({
      key,
      ok: true,
      row_count: result.rowCount,
      sample: result.rows.slice(0, 3),
    });
    return result.rows;
  } catch (error) {
    diagnostics.query_attempts.push({
      key,
      ok: false,
      error: error?.message || String(error),
    });
    return null;
  }
}

function normalizePromos(rows = []) {
  return rows.map((row) => ({
    id_promocion_regla: row.id_promocion_regla,
    nombre_regla: row.nombre_regla ?? null,
    es_acumulable: row.es_acumulable === true,
    prioridad_aplicacion: Number(row.prioridad_aplicacion ?? 0),
  }));
}

function normalizeServiceName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildSqlProposed() {
  return `
-- SQL PROPUESTO (NO EJECUTADO): dataset minimo smoke reversible
-- 1) Servicio activo smoke (si no existe)
-- INSERT INTO public.servicios (id_servicio, nombre_servicio, descripcion, duracion_min, buffer_min, activo, agendable, visible_publico, orden_visual)
-- VALUES (gen_random_uuid(), 'Smoke Corte QA', 'Servicio smoke test', 30, 5, TRUE, TRUE, TRUE, 999);

-- 2) Tarifa activa por sucursal (fallback general por sucursal)
-- INSERT INTO public.servicios_tarifas (id_servicio_tarifa, id_servicio, id_sucursal, id_empleado_barbero, precio_hnl, vigente_desde, vigente_hasta, activo)
-- VALUES (gen_random_uuid(), :id_servicio, :id_sucursal, NULL, 250, now() - interval '1 day', NULL, TRUE);

-- 3) Paquete activo y relacion a sucursal
-- INSERT INTO public.paquetes (id_paquete, nombre_paquete, descripcion, activo, precio_hnl)
-- VALUES (gen_random_uuid(), 'Smoke Paquete QA', 'Paquete smoke', TRUE, 400);
-- INSERT INTO public.paquetes_sucursal (id_paquete_sucursal, id_paquete, id_sucursal, precio_hnl, activo, visible_publico, orden_visual)
-- VALUES (gen_random_uuid(), :id_paquete, :id_sucursal, 400, TRUE, TRUE, 999);
-- INSERT INTO public.paquetes_detalles (id_paquete_detalle, id_paquete, id_servicio, cantidad)
-- VALUES (gen_random_uuid(), :id_paquete, :id_servicio, 1);

-- 4) Promocion acumulable valida y otra no aplicable
-- INSERT INTO public.promociones (id_promocion, titulo, estado, tipo_promocion, aplica_a, valor_descuento)
-- VALUES (gen_random_uuid(), 'Smoke Promo Acumulable', 'activa', 'descuento', 'servicio', 10);
-- INSERT INTO public.promociones_reglas_agendamiento
-- (id_promocion_regla, id_promocion, tipo_promocion_agendamiento_codigo, tipo_descuento_codigo, aplica_a_codigo, valor_descuento, es_acumulable, prioridad_aplicacion, activo)
-- VALUES (gen_random_uuid(), :id_promocion, 'descuento', 'porcentaje', 'servicio', 10, TRUE, 10, TRUE);
-- INSERT INTO public.promociones_items_agendamiento (id_promocion_item_agendamiento, id_promocion_regla, tipo_item_codigo, id_item)
-- VALUES (gen_random_uuid(), :id_promocion_regla, 'servicio', :id_servicio);

-- INSERT no aplicable: regla sobre otro servicio/paquete distinto al smoke seleccionado.

-- 5) Canje de prueba (sin consumir puntos reales en hold)
-- Preparar tx de contexto/redeem_context solo para validacion de contexto, sin confirmar consumo.
-- INSERT en points_transactions segun contratos internos del servicio de puntos.
`;
}

async function main() {
  const cwd = process.cwd();
  loadEnv(path.join(cwd, ".env"));
  const pool = new Pool(pickPgConfig());
  const client = await pool.connect();

  const diagnostics = {
    output_file: path.join(cwd, OUTPUT_FILE),
    query_attempts: [],
    reasons: {},
    schema_findings: {},
    sql_proposed_if_missing_master_data: buildSqlProposed(),
  };

  try {
    const branchRows = await queryAttempt(
      client,
      diagnostics,
      "branch_base",
      `
        SELECT id_sucursal, nombre_sucursal
        FROM public.sucursales
        ORDER BY created_at ASC
        LIMIT 1
      `
    );
    const branch = branchRows?.[0] || null;

    const barberRows = branch
      ? await queryAttempt(
        client,
        diagnostics,
        "barber_by_branch",
        `
          SELECT e.id_empleado, CONCAT_WS(' ', p.nombres, p.apellidos) AS nombre_barbero
          FROM public.empleados e
          JOIN public.personas p ON p.id_persona = e.id_persona
          WHERE e.id_sucursal = $1::uuid
          ORDER BY e.created_at ASC
          LIMIT 1
        `,
        [branch.id_sucursal]
      )
      : null;
    const barber = barberRows?.[0] || null;

    const servicesByTariffRows = branch
      ? await queryAttempt(
        client,
        diagnostics,
        "services_by_tarifa_sucursal",
        `
          SELECT
            s.id_servicio,
            s.nombre_servicio,
            s.duracion_min,
            st.precio_hnl AS precio_referencia_hnl
          FROM public.servicios_tarifas st
          JOIN public.servicios s
            ON s.id_servicio = st.id_servicio
          WHERE st.id_sucursal = $1::uuid
            AND COALESCE(st.activo, TRUE) = TRUE
            AND COALESCE(s.activo, TRUE) = TRUE
            AND s.deleted_at IS NULL
          ORDER BY st.created_at DESC, s.nombre_servicio ASC
          LIMIT 20
        `,
        [branch.id_sucursal]
      )
      : null;

    const servicesFallbackRows = await queryAttempt(
      client,
      diagnostics,
      "services_fallback_catalog",
      `
        SELECT
          s.id_servicio,
          s.nombre_servicio,
          s.duracion_min,
          NULL::numeric AS precio_referencia_hnl
        FROM public.servicios s
        WHERE COALESCE(s.activo, TRUE) = TRUE
          AND s.deleted_at IS NULL
        ORDER BY s.created_at ASC
        LIMIT 20
      `
    );

    const services = (Array.isArray(servicesByTariffRows) && servicesByTariffRows.length
      ? servicesByTariffRows
      : (servicesFallbackRows || [])
    ).map((row) => ({
      id_servicio: row.id_servicio,
      nombre_servicio: row.nombre_servicio,
      duracion_min: Number(row.duracion_min ?? 0),
      precio_referencia_hnl: row.precio_referencia_hnl == null ? null : Number(row.precio_referencia_hnl),
    }));

    const packageByBranchRows = branch
      ? await queryAttempt(
        client,
        diagnostics,
        "package_by_sucursal",
        `
          SELECT
            ps.id_paquete_sucursal,
            ps.id_paquete,
            p.nombre_paquete,
            ps.precio_hnl,
            NULL::int AS duracion_total_min,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id_servicio', pd.id_servicio,
                'nombre_servicio', s.nombre_servicio
              ) ORDER BY pd.id_paquete_detalle ASC)
              FROM public.paquetes_detalles pd
              JOIN public.servicios s
                ON s.id_servicio = pd.id_servicio
              WHERE pd.id_paquete = ps.id_paquete
            ), '[]'::json) AS servicios_incluidos
          FROM public.paquetes_sucursal ps
          JOIN public.paquetes p
            ON p.id_paquete = ps.id_paquete
          WHERE ps.id_sucursal = $1::uuid
            AND COALESCE(ps.activo, TRUE) = TRUE
            AND COALESCE(p.activo, TRUE) = TRUE
          ORDER BY ps.created_at ASC
          LIMIT 1
        `,
        [branch.id_sucursal]
      )
      : null;

    const packageFallbackRows = await queryAttempt(
      client,
      diagnostics,
      "package_fallback_any",
      `
        SELECT
          ps.id_paquete_sucursal,
          ps.id_paquete,
          p.nombre_paquete,
          ps.precio_hnl,
          NULL::int AS duracion_total_min,
          '[]'::json AS servicios_incluidos
        FROM public.paquetes_sucursal ps
        JOIN public.paquetes p
          ON p.id_paquete = ps.id_paquete
        WHERE COALESCE(ps.activo, TRUE) = TRUE
          AND COALESCE(p.activo, TRUE) = TRUE
        ORDER BY ps.created_at ASC
        LIMIT 1
      `
    );
    const packageRow = (packageByBranchRows?.[0]) || (packageFallbackRows?.[0]) || null;

    const promosRows = await queryAttempt(
      client,
      diagnostics,
      "promociones_reglas_base",
      `
        SELECT
          pra.id_promocion_regla,
          COALESCE(p.titulo, CONCAT('Promocion ', pra.id_promocion_regla::text)) AS nombre_regla,
          COALESCE(pra.es_acumulable, FALSE) AS es_acumulable,
          COALESCE(pra.prioridad_aplicacion, 100) AS prioridad_aplicacion
        FROM public.promociones_reglas_agendamiento pra
        LEFT JOIN public.promociones p
          ON p.id_promocion = pra.id_promocion
        WHERE COALESCE(pra.activo, TRUE) = TRUE
        ORDER BY COALESCE(pra.es_acumulable, FALSE) DESC, COALESCE(pra.prioridad_aplicacion, 100) ASC, pra.created_at ASC
        LIMIT 20
      `
    );
    const promos = normalizePromos(promosRows || []);
    const promosAcumulables = promos.filter((row) => row.es_acumulable).slice(0, 2);
    const promotionNoAplicableProbe = promos.find((row) => !row.es_acumulable) || null;

    const canjeRows = await queryAttempt(
      client,
      diagnostics,
      "points_transactions_redeem_probe",
      `
        SELECT
          tx.id_points_tx,
          tx.tipo_puntos_codigo,
          tx.id_servicio_canje,
          tx.id_cliente,
          tx.created_at
        FROM public.points_transactions tx
        WHERE tx.tipo_puntos_codigo IN ('canjear', 'redeem_context', 'reserva_canje')
        ORDER BY tx.created_at DESC
        LIMIT 10
      `
    );
    const canjeContext = canjeRows?.[0] || null;

    const recentGroupRows = await queryAttempt(
      client,
      diagnostics,
      "recent_group_probe",
      `
        SELECT id_grupo_cita
        FROM public.citas_grupos
        ORDER BY created_at DESC
        LIMIT 1
      `
    );
    const recentGroup = recentGroupRows?.[0] || null;

    const includedServices = Array.isArray(packageRow?.servicios_incluidos)
      ? packageRow.servicios_incluidos
      : [];
    const includedIds = new Set(includedServices.map((item) => String(item?.id_servicio || "").trim()).filter(Boolean));
    const includedNames = new Set(includedServices.map((item) => normalizeServiceName(item?.nombre_servicio)).filter(Boolean));
    const mixedExtraCandidate = services.find((service) => {
      const id = String(service?.id_servicio || "").trim();
      const name = normalizeServiceName(service?.nombre_servicio);
      return Boolean(id) && !includedIds.has(id) && Boolean(name) && !includedNames.has(name);
    }) || null;
    const mixedReady = Boolean(packageRow?.id_paquete) && Boolean(mixedExtraCandidate?.id_servicio);

    const promocionesAcumulablesFoundCount = promosAcumulables.length;
    const promocionesAcumulablesReady = promocionesAcumulablesFoundCount >= 2;
    const canjeContextTokenProbe = null;
    const canjeReady = Boolean(canjeContext?.id_points_tx) && Boolean(canjeContextTokenProbe);

    const partialSmokeReady = Boolean(services.length)
      && Boolean(packageRow?.id_paquete)
      && Boolean(includedServices[0]?.id_servicio)
      && Boolean(promotionNoAplicableProbe?.id_promocion_regla)
      && Boolean(recentGroup?.id_grupo_cita);
    const fullSmokeReady = partialSmokeReady && promocionesAcumulablesReady && canjeReady;
    const blockers = [];
    if (!services.length) blockers.push("SIN_SERVICIOS_DATASET");
    if (!packageRow?.id_paquete) blockers.push("SIN_PAQUETE_DATASET");
    if (!includedServices[0]?.id_servicio) blockers.push("SIN_SERVICIO_INCLUIDO_PROBE");
    if (!promotionNoAplicableProbe?.id_promocion_regla) blockers.push("SIN_PROMOCION_NO_APLICABLE_PROBE");
    if (!recentGroup?.id_grupo_cita) blockers.push("SIN_GRUPO_PROBE_COMPROBANTE");
    if (!promocionesAcumulablesReady) blockers.push("SIN_PROMOCIONES_ACUMULABLES_MIN_2");
    if (!canjeReady) blockers.push("SIN_CANJE_CONTEXT_TOKEN_PROBE");

    diagnostics.schema_findings = {
      servicios_dependen_de_tarifas_por_sucursal: true,
      tabla_paquetes_sucursal_detectada: true,
      tabla_paquetes_sucursales_no_detectada: true,
      promociones_id_columna_real: "id_promocion_regla",
      points_tipo_columna_real: "tipo_puntos_codigo",
    };
    diagnostics.reasons.services = services.length
      ? "Se encontraron servicios para dataset."
      : "Sin filas en servicios_tarifas para la sucursal y/o sin servicios activos para fallback.";
    diagnostics.reasons.package = packageRow
      ? "Se encontro paquete para dataset."
      : "Sin filas activas en paquetes_sucursal (ni fallback global activo).";
    diagnostics.reasons.mixed = mixedReady
      ? "Se encontro servicio extra fuera del paquete por id y nombre normalizado."
      : "No existe servicio extra inequívoco fuera del paquete por id y nombre normalizado.";
    diagnostics.reasons.promociones_acumulables = promocionesAcumulablesReady
      ? "Se encontraron al menos 2 promociones acumulables."
      : "No hay reglas activas con es_acumulable=true suficientes (minimo 2).";
    diagnostics.reasons.promocion_no_aplicable = promotionNoAplicableProbe
      ? "Se encontro regla no acumulable como probe de no aplicable."
      : "No hay regla candidata no acumulable en promociones_reglas_agendamiento.";
    diagnostics.reasons.canje_valido = canjeContext
      ? "Existe transaccion candidata de puntos."
      : "No existen transacciones candidatas de canje.";
    diagnostics.reasons.canje_context_token = canjeReady
      ? "Existe contexto reproducible de canje."
      : "No hay canje_context_token_probe valido para reproducir flujo de canje.";

    const output = {
      generated_at: new Date().toISOString(),
      branch,
      barber,
      services,
      package: packageRow,
      smoke_cases: {
        package_puro: {
          id_paquete: packageRow?.id_paquete || null,
          expected_selection_type: "package",
        },
        mixed: {
          id_paquete: packageRow?.id_paquete || null,
          suggested_servicio_extra: mixedExtraCandidate?.id_servicio || null,
          expected_selection_type: "mixed",
          ready: mixedReady,
        },
        servicio_incluido_como_extra: {
          id_paquete: packageRow?.id_paquete || null,
          servicio_incluido_probe: includedServices[0]?.id_servicio || null,
          expected_error_code: "SERVICE_ALREADY_INCLUDED_IN_PACKAGE",
        },
        acompanantes: {
          max_default: 4,
          expected_error_on_exceed: "MAX_COMPANIONS_EXCEEDED",
        },
        promociones_acumulables: {
          promotion_ids: promosAcumulables.map((row) => row.id_promocion_regla),
          found: promocionesAcumulablesReady,
          ready: promocionesAcumulablesReady,
          required_min: 2,
          found_count: promocionesAcumulablesFoundCount,
        },
        promocion_no_aplicable: {
          promotion_id_probe: promotionNoAplicableProbe?.id_promocion_regla || null,
          expected_error_codes: ["PROMOTION_NOT_APPLICABLE", "PROMOTION_NOT_STACKABLE"],
        },
        canje_valido: {
          id_points_tx_probe: canjeContext?.id_points_tx || null,
          canje_context_token_probe: canjeContextTokenProbe,
          ready: canjeReady,
          note: "El hold no consume puntos; validar consumo en confirmacion.",
        },
        confirmacion_pago_comprobante: {
          id_grupo_cita_probe: recentGroup?.id_grupo_cita || null,
          expected_comprobante_flow: ["confirmarComprobanteAgendamientoParaEnvio", "enviarComprobanteAgendamientoNoFiscal"],
        },
      },
      readiness: {
        partial_smoke_ready: partialSmokeReady,
        full_smoke_ready: fullSmokeReady,
        blockers,
      },
      diagnostics,
    };

    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    const outputPath = path.join(cwd, OUTPUT_FILE);
    await fsAsync.writeFile(outputPath, serialized, "utf8");
    process.stdout.write(serialized);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`[smoke_agendamiento_dataset] error: ${error?.message || error}\n`);
  process.exit(1);
});
