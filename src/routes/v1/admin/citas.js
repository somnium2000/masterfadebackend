import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  assertUuid,
  getSystemParameters,
  mapBlockRow,
  parseDateOnly,
  resolveBranchIdsForClaims,
} from "../../../services/agendaService.js";

const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];

function sendHandled(reply, request, error, message, code) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    details: error instanceof Error ? error.message : "Unknown admin citas error",
    requestId: request.id,
  });
}

function cleanText(value) {
  const raw = String(value ?? "").trim();
  return raw.length ? raw : null;
}

function parseDateTime(value, field) {
  const parsed = new Date(String(value || "").trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, `${field} debe ser una fecha-hora valida`, {
      code: "ADMIN_CITAS_DATETIME_INVALID",
      details: { field, value: value ?? null },
    });
  }
  return parsed;
}

function normalizeTime(value, field) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) {
    throw new AppError(400, `${field} debe tener formato HH:mm o HH:mm:ss`, {
      code: "ADMIN_CITAS_TIME_INVALID",
      details: { field, value: raw || null },
    });
  }
  return `${match[1]}:${match[2]}:${match[3] || "00"}`;
}

function normalizeBoolean(value, field) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  throw new AppError(400, `${field} debe ser booleano`, {
    code: "ADMIN_CITAS_BOOLEAN_INVALID",
    details: { field, value: value ?? null },
  });
}

function mapScheduleRow(row) {
  return {
    id_horario: row.id_horario,
    dia_semana: Number(row.dia_semana),
    hora_inicio: String(row.hora_inicio).slice(0, 8),
    hora_fin: String(row.hora_fin).slice(0, 8),
    almuerzo_inicio: row.almuerzo_inicio ? String(row.almuerzo_inicio).slice(0, 8) : null,
    almuerzo_fin: row.almuerzo_fin ? String(row.almuerzo_fin).slice(0, 8) : null,
    activo: Boolean(row.activo),
  };
}

function mapEmployeeRow(row) {
  return {
    id_empleado: row.id_empleado,
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal ?? null,
    nombre_completo: row.nombre_completo ?? "Sin nombre",
    es_barbero: Boolean(row.es_barbero),
  };
}

function selectParams(values) {
  return {
    hold_duracion_min: Number(values.hold_duracion_min?.valor_numero ?? 5),
    no_show_min: Number(values.no_show_min?.valor_numero ?? 10),
    permitir_acompanantes: Boolean(values.permitir_acompanantes?.valor_booleano ?? false),
    pago_total_obligatorio: Boolean(values.pago_total_obligatorio?.valor_booleano ?? true),
  };
}

async function getScopeBranches(app, claims) {
  const branchIds = await resolveBranchIdsForClaims(app, claims);
  if (!branchIds.length) {
    throw new AppError(403, "No tienes sucursales dentro de tu alcance para admin/citas", {
      code: "ADMIN_CITAS_SCOPE_EMPTY",
    });
  }
  return branchIds;
}

async function getEmployeeInScope(client, idEmpleado, branchIds) {
  const safeId = assertUuid(idEmpleado, "id_empleado");
  const { rows } = await client.query(
    `
      SELECT
        e.id_empleado,
        e.id_sucursal,
        e.es_barbero,
        s.nombre_sucursal,
        COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo
      FROM public.empleados e
      JOIN public.personas p ON p.id_persona = e.id_persona
      JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
      WHERE e.id_empleado = $1::uuid
        AND e.deleted_at IS NULL
        AND e.estado IS TRUE
        AND e.id_sucursal = ANY($2::uuid[])
      LIMIT 1
    `,
    [safeId, branchIds]
  );
  if (!rows[0]) {
    throw new AppError(404, "Empleado no encontrado en tu alcance", {
      code: "ADMIN_CITAS_EMPLOYEE_NOT_FOUND",
      details: { id_empleado: safeId },
    });
  }
  return mapEmployeeRow(rows[0]);
}

async function listBarbersByBranchInScope(client, branchIds, idSucursal) {
  const safeBranch = assertUuid(idSucursal, "id_sucursal");
  if (!branchIds.includes(safeBranch)) {
    throw new AppError(403, "Sucursal fuera de tu alcance", {
      code: "ADMIN_CITAS_BRANCH_FORBIDDEN",
      details: { id_sucursal: safeBranch },
    });
  }

  const { rows } = await client.query(
    `
      SELECT
        e.id_empleado,
        e.id_sucursal,
        e.es_barbero,
        s.nombre_sucursal,
        COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo
      FROM public.empleados e
      JOIN public.personas p ON p.id_persona = e.id_persona
      JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
      WHERE e.deleted_at IS NULL
        AND e.estado IS TRUE
        AND e.es_barbero IS TRUE
        AND e.id_sucursal = $1::uuid
      ORDER BY nombre_completo ASC
    `,
    [safeBranch]
  );

  return rows.map(mapEmployeeRow);
}

function groupBranchDayOffs(items) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = [
      item.id_sucursal,
      item.inicio_at,
      item.fin_at,
      item.tipo_bloqueo_codigo,
      item.motivo || "",
    ].join("|");
    if (!grouped.has(key)) {
      grouped.set(key, {
        ...item,
        id_empleado: null,
        nombre_completo: null,
        total_barberos: 1,
      });
      continue;
    }
    const current = grouped.get(key);
    current.total_barberos += 1;
  }
  return Array.from(grouped.values());
}

async function listBlocks(client, branchIds, { idEmpleado, idSucursal, fechaDesde, fechaHasta } = {}) {
  const params = [branchIds];
  const where = ["b.id_sucursal = ANY($1::uuid[])"];

  if (idEmpleado) {
    params.push(assertUuid(idEmpleado, "id_empleado"));
    where.push(`b.id_empleado = $${params.length}::uuid`);
  }
  if (idSucursal) {
    const safeBranch = assertUuid(idSucursal, "id_sucursal");
    if (!branchIds.includes(safeBranch)) {
      throw new AppError(403, "Sucursal fuera de tu alcance", {
        code: "ADMIN_CITAS_BRANCH_FORBIDDEN",
        details: { id_sucursal: safeBranch },
      });
    }
    params.push(safeBranch);
    where.push(`b.id_sucursal = $${params.length}::uuid`);
  }
  if (fechaDesde || fechaHasta) {
    const desde = parseDateOnly(fechaDesde || fechaHasta, "fecha_desde");
    const hasta = parseDateOnly(fechaHasta || fechaDesde, "fecha_hasta");
    const from = new Date(`${desde}T00:00:00`).toISOString();
    const to = new Date(new Date(`${hasta}T00:00:00`).getTime() + 24 * 60 * 60 * 1000).toISOString();
    params.push(from);
    const fromI = params.length;
    params.push(to);
    const toI = params.length;
    where.push(`b.rango && tstzrange($${fromI}::timestamptz, $${toI}::timestamptz, '[)')`);
  }

  const { rows } = await client.query(
    `
      SELECT
        b.id_bloqueo,
        b.id_empleado,
        b.id_sucursal,
        b.tipo_bloqueo_codigo,
        b.motivo,
        lower(b.rango) AS inicio_at,
        upper(b.rango) AS fin_at,
        COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo,
        s.nombre_sucursal
      FROM public.bloqueos_agenda b
      JOIN public.empleados e ON e.id_empleado = b.id_empleado
      JOIN public.personas p ON p.id_persona = e.id_persona
      JOIN public.sucursales s ON s.id_sucursal = b.id_sucursal
      WHERE ${where.join(" AND ")}
      ORDER BY lower(b.rango) ASC, b.id_bloqueo ASC
    `,
    params
  );

  return rows.map(mapBlockRow);
}

async function ensureBlockType(client, code) {
  const safeCode = cleanText(code);
  if (!safeCode) {
    throw new AppError(400, "tipo_bloqueo_codigo es obligatorio", {
      code: "ADMIN_CITAS_BLOCK_TYPE_REQUIRED",
    });
  }
  const { rows } = await client.query(
    `SELECT tipo_bloqueo_codigo FROM public.tipos_bloqueo_agenda WHERE tipo_bloqueo_codigo = $1 LIMIT 1`,
    [safeCode]
  );
  if (!rows[0]) {
    throw new AppError(404, "tipo_bloqueo_codigo no existe", {
      code: "ADMIN_CITAS_BLOCK_TYPE_NOT_FOUND",
    });
  }
  return safeCode;
}

async function getDayOffType(client) {
  const preferred = ["dia_inhabilitado", "inhabilitado", "bloqueo_dia", "full_day", "vacaciones", "permiso"];
  const found = await client.query(
    `
      SELECT tipo_bloqueo_codigo
      FROM public.tipos_bloqueo_agenda
      WHERE tipo_bloqueo_codigo = ANY($1::text[])
      ORDER BY array_position($1::text[], tipo_bloqueo_codigo)
      LIMIT 1
    `,
    [preferred]
  );
  if (found.rows[0]) return found.rows[0].tipo_bloqueo_codigo;

  const fallback = await client.query(
    `SELECT tipo_bloqueo_codigo FROM public.tipos_bloqueo_agenda ORDER BY tipo_bloqueo_codigo ASC LIMIT 1`
  );
  if (!fallback.rows[0]) {
    throw new AppError(409, "No existe catalogo de tipos de bloqueo", {
      code: "ADMIN_CITAS_BLOCK_TYPE_CATALOG_EMPTY",
    });
  }
  return fallback.rows[0].tipo_bloqueo_codigo;
}

export default async function adminCitasRoutes(app) {
  app.get("/contexto", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const [sucursales, barberos, tiposBloqueo, params] = await Promise.all([
        app.db.query(
          `SELECT id_sucursal, nombre_sucursal FROM public.sucursales WHERE id_sucursal = ANY($1::uuid[]) ORDER BY nombre_sucursal ASC`,
          [branchIds]
        ),
        app.db.query(
          `
            SELECT e.id_empleado, e.id_sucursal,
                   COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo
            FROM public.empleados e
            JOIN public.personas p ON p.id_persona = e.id_persona
            WHERE e.deleted_at IS NULL AND e.estado IS TRUE AND e.es_barbero IS TRUE AND e.id_sucursal = ANY($1::uuid[])
            ORDER BY nombre_completo ASC
          `,
          [branchIds]
        ),
        app.db.query(`SELECT tipo_bloqueo_codigo, descripcion FROM public.tipos_bloqueo_agenda ORDER BY tipo_bloqueo_codigo ASC`),
        getSystemParameters(app.db),
      ]);
      return sendOk(reply, {
        sucursales: sucursales.rows,
        barberos: barberos.rows,
        tipos_bloqueo: tiposBloqueo.rows,
        parametros: selectParams(params),
      });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar el contexto de citas admin", "ADMIN_CITAS_CONTEXT_ERROR");
    }
  });

  app.get("/horarios/:id_empleado", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const empleado = await getEmployeeInScope(app.db, request.params.id_empleado, branchIds);
      const { rows } = await app.db.query(
        `
          SELECT id_horario, dia_semana, hora_inicio, hora_fin, almuerzo_inicio, almuerzo_fin, activo
          FROM public.horarios_semanales_empleados
          WHERE id_empleado = $1::uuid
          ORDER BY dia_semana ASC, hora_inicio ASC, id_horario ASC
        `,
        [empleado.id_empleado]
      );
      return sendOk(reply, { empleado, horarios: rows.map(mapScheduleRow) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar el horario", "ADMIN_CITAS_HORARIOS_GET_ERROR");
    }
  });

  app.put("/horarios/:id_empleado", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const empleado = await getEmployeeInScope(dbClient, request.params.id_empleado, branchIds);
      const horarios = Array.isArray(request.body?.horarios) ? request.body.horarios : [];

      await dbClient.query("BEGIN");
      await dbClient.query(`DELETE FROM public.horarios_semanales_empleados WHERE id_empleado = $1::uuid`, [empleado.id_empleado]);
      for (const item of horarios) {
        const diaSemana = Number(item.dia_semana);
        if (!Number.isInteger(diaSemana) || diaSemana < 0 || diaSemana > 6) {
          throw new AppError(400, "dia_semana debe estar entre 0 y 6", {
            code: "ADMIN_CITAS_HORARIOS_DAY_INVALID",
          });
        }
        const horaInicio = normalizeTime(item.hora_inicio, "hora_inicio");
        const horaFin = normalizeTime(item.hora_fin, "hora_fin");
        if (horaFin <= horaInicio) {
          throw new AppError(400, "hora_fin debe ser mayor que hora_inicio", {
            code: "ADMIN_CITAS_HORARIOS_RANGE_INVALID",
          });
        }
        const almuerzoInicio = item.almuerzo_inicio == null ? null : normalizeTime(item.almuerzo_inicio, "almuerzo_inicio");
        const almuerzoFin = item.almuerzo_fin == null ? null : normalizeTime(item.almuerzo_fin, "almuerzo_fin");
        if ((almuerzoInicio && !almuerzoFin) || (!almuerzoInicio && almuerzoFin)) {
          throw new AppError(400, "almuerzo_inicio y almuerzo_fin deben enviarse juntos", {
            code: "ADMIN_CITAS_HORARIOS_LUNCH_PAIR_INVALID",
          });
        }

        await dbClient.query(
          `
            INSERT INTO public.horarios_semanales_empleados (
              id_empleado, dia_semana, hora_inicio, hora_fin, almuerzo_inicio, almuerzo_fin, activo
            )
            VALUES ($1::uuid, $2::smallint, $3::time, $4::time, $5::time, $6::time, $7::boolean)
          `,
          [empleado.id_empleado, diaSemana, horaInicio, horaFin, almuerzoInicio, almuerzoFin, item.activo !== false]
        );
      }
      await dbClient.query("COMMIT");

      const refreshed = await dbClient.query(
        `
          SELECT id_horario, dia_semana, hora_inicio, hora_fin, almuerzo_inicio, almuerzo_fin, activo
          FROM public.horarios_semanales_empleados
          WHERE id_empleado = $1::uuid
          ORDER BY dia_semana ASC, hora_inicio ASC, id_horario ASC
        `,
        [empleado.id_empleado]
      );
      return sendOk(reply, { empleado, horarios: refreshed.rows.map(mapScheduleRow) });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudo actualizar el horario", "ADMIN_CITAS_HORARIOS_PUT_ERROR");
    } finally {
      dbClient.release();
    }
  });

  app.get("/bloqueos", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const bloqueos = await listBlocks(app.db, branchIds, {
        idEmpleado: request.query?.id_empleado ?? null,
        idSucursal: request.query?.id_sucursal ?? null,
        fechaDesde: request.query?.fecha_desde ?? null,
        fechaHasta: request.query?.fecha_hasta ?? null,
      });
      return sendOk(reply, { bloqueos });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudieron consultar los bloqueos", "ADMIN_CITAS_BLOCKS_GET_ERROR");
    }
  });

  app.post("/bloqueos", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const empleado = await getEmployeeInScope(app.db, request.body?.id_empleado, branchIds);
      if (!empleado.es_barbero) {
        throw new AppError(409, "Solo se pueden crear bloqueos para barberos", {
          code: "ADMIN_CITAS_BLOCK_EMPLOYEE_NOT_BARBER",
        });
      }
      if (request.body?.id_sucursal && assertUuid(request.body.id_sucursal, "id_sucursal") !== empleado.id_sucursal) {
        throw new AppError(409, "id_sucursal no coincide con la sucursal del empleado", {
          code: "ADMIN_CITAS_BLOCK_BRANCH_MISMATCH",
        });
      }
      const tipoBloqueo = await ensureBlockType(app.db, request.body?.tipo_bloqueo_codigo);
      const inicioAt = parseDateTime(request.body?.inicio_at, "inicio_at");
      const finAt = parseDateTime(request.body?.fin_at, "fin_at");
      if (finAt.getTime() <= inicioAt.getTime()) {
        throw new AppError(400, "fin_at debe ser mayor que inicio_at", {
          code: "ADMIN_CITAS_BLOCK_RANGE_INVALID",
        });
      }

      const inserted = await app.db.query(
        `
          INSERT INTO public.bloqueos_agenda (id_empleado, id_sucursal, tipo_bloqueo_codigo, rango, motivo, creado_por)
          VALUES ($1::uuid, $2::uuid, $3::text, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, $7::uuid)
          RETURNING id_bloqueo
        `,
        [
          empleado.id_empleado,
          empleado.id_sucursal,
          tipoBloqueo,
          inicioAt.toISOString(),
          finAt.toISOString(),
          cleanText(request.body?.motivo),
          request.claims?.user?.id_usuario ?? null,
        ]
      );
      const bloqueos = await listBlocks(app.db, branchIds, {});
      const bloqueo = bloqueos.find((item) => item.id_bloqueo === inserted.rows[0]?.id_bloqueo) ?? null;
      return sendOk(reply, { bloqueo }, { statusCode: 201 });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo crear el bloqueo", "ADMIN_CITAS_BLOCKS_POST_ERROR");
    }
  });

  app.delete("/bloqueos", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const idBloqueo = assertUuid(request.query?.id_bloqueo, "id_bloqueo");
      const bloqueos = await listBlocks(app.db, branchIds, {});
      const objetivo = bloqueos.find((item) => item.id_bloqueo === idBloqueo) ?? null;
      if (!objetivo) {
        throw new AppError(404, "Bloqueo no encontrado en tu alcance", {
          code: "ADMIN_CITAS_BLOCK_NOT_FOUND",
        });
      }
      await app.db.query(`DELETE FROM public.bloqueos_agenda WHERE id_bloqueo = $1::uuid`, [idBloqueo]);
      return sendOk(reply, { bloqueo: objetivo });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo eliminar el bloqueo", "ADMIN_CITAS_BLOCKS_DELETE_ERROR");
    }
  });

  app.get("/dias-inhabilitados", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const bloqueos = await listBlocks(app.db, branchIds, {
        idEmpleado: request.query?.id_empleado ?? null,
        idSucursal: request.query?.id_sucursal ?? null,
        fechaDesde: request.query?.fecha_desde ?? null,
        fechaHasta: request.query?.fecha_hasta ?? null,
      });
      const diasInhabilitados = bloqueos.filter((item) => item.es_dia_completo);
      if (String(request.query?.scope || "").toLowerCase() === "sucursal") {
        return sendOk(reply, { dias_inhabilitados: groupBranchDayOffs(diasInhabilitados) });
      }
      return sendOk(reply, { dias_inhabilitados: diasInhabilitados });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudieron consultar los dias inhabilitados", "ADMIN_CITAS_DAYS_OFF_GET_ERROR");
    }
  });

  app.post("/dias-inhabilitados", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const fecha = parseDateOnly(request.body?.fecha, "fecha");
      const start = new Date(`${fecha}T00:00:00`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const motivo = cleanText(request.body?.motivo);
      const createdBy = request.claims?.user?.id_usuario ?? null;
      const typeCode = await getDayOffType(dbClient);

      let insertedIds = [];

      await dbClient.query("BEGIN");
      if (request.body?.id_empleado) {
        const empleado = await getEmployeeInScope(dbClient, request.body?.id_empleado, branchIds);
        if (!empleado.es_barbero) {
          throw new AppError(409, "Solo se pueden inhabilitar dias para barberos", {
            code: "ADMIN_CITAS_DAY_OFF_EMPLOYEE_NOT_BARBER",
          });
        }

        if (request.body?.id_sucursal && assertUuid(request.body.id_sucursal, "id_sucursal") !== empleado.id_sucursal) {
          throw new AppError(409, "id_sucursal no coincide con la sucursal del empleado", {
            code: "ADMIN_CITAS_DAY_OFF_BRANCH_MISMATCH",
          });
        }

        const inserted = await dbClient.query(
          `
            INSERT INTO public.bloqueos_agenda (id_empleado, id_sucursal, tipo_bloqueo_codigo, rango, motivo, creado_por)
            VALUES ($1::uuid, $2::uuid, $3::text, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, $7::uuid)
            RETURNING id_bloqueo
          `,
          [
            empleado.id_empleado,
            empleado.id_sucursal,
            typeCode,
            start.toISOString(),
            end.toISOString(),
            motivo,
            createdBy,
          ]
        );
        insertedIds = inserted.rows.map((row) => row.id_bloqueo);
      } else {
        const barberos = await listBarbersByBranchInScope(dbClient, branchIds, request.body?.id_sucursal);
        if (!barberos.length) {
          throw new AppError(409, "La sucursal no tiene barberos activos para aplicar el cierre", {
            code: "ADMIN_CITAS_BRANCH_DAY_OFF_NO_BARBERS",
          });
        }

        const inserted = await dbClient.query(
          `
            INSERT INTO public.bloqueos_agenda (id_empleado, id_sucursal, tipo_bloqueo_codigo, rango, motivo, creado_por)
            SELECT
              e.id_empleado,
              $1::uuid,
              $2::text,
              tstzrange($3::timestamptz, $4::timestamptz, '[)'),
              $5::text,
              $6::uuid
            FROM public.empleados e
            WHERE e.deleted_at IS NULL
              AND e.estado IS TRUE
              AND e.es_barbero IS TRUE
              AND e.id_sucursal = $1::uuid
              AND NOT EXISTS (
                SELECT 1
                FROM public.bloqueos_agenda b
                WHERE b.id_empleado = e.id_empleado
                  AND b.id_sucursal = $1::uuid
                  AND b.tipo_bloqueo_codigo = $2::text
                  AND b.rango = tstzrange($3::timestamptz, $4::timestamptz, '[)')
                  AND COALESCE(b.motivo, '') = COALESCE($5::text, '')
              )
            RETURNING id_bloqueo
          `,
          [
            barberos[0].id_sucursal,
            typeCode,
            start.toISOString(),
            end.toISOString(),
            motivo,
            createdBy,
          ]
        );
        insertedIds = inserted.rows.map((row) => row.id_bloqueo);
        if (!insertedIds.length) {
          throw new AppError(409, "El cierre por sucursal ya existe para esa fecha", {
            code: "ADMIN_CITAS_BRANCH_DAY_OFF_ALREADY_EXISTS",
          });
        }
      }
      await dbClient.query("COMMIT");

      const blocks = await listBlocks(app.db, branchIds, {
        idSucursal: request.body?.id_sucursal ?? null,
        fechaDesde: fecha,
        fechaHasta: fecha,
      });
      const created = blocks.filter((item) => insertedIds.includes(item.id_bloqueo));
      const grouped = groupBranchDayOffs(created);
      return sendOk(
        reply,
        {
          dia_inhabilitado: created[0] ?? null,
          dias_inhabilitados: grouped,
        },
        { statusCode: 201 }
      );
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudo crear el dia inhabilitado", "ADMIN_CITAS_DAYS_OFF_POST_ERROR");
    } finally {
      dbClient.release();
    }
  });

  app.delete("/dias-inhabilitados", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const idBloqueo = assertUuid(request.query?.id_bloqueo, "id_bloqueo");
      const blocks = await listBlocks(app.db, branchIds, {});
      const dayOff = blocks.find((item) => item.id_bloqueo === idBloqueo) ?? null;
      if (!dayOff) {
        throw new AppError(404, "Dia inhabilitado no encontrado en tu alcance", {
          code: "ADMIN_CITAS_DAY_OFF_NOT_FOUND",
        });
      }
      if (!dayOff.es_dia_completo) {
        throw new AppError(409, "El bloqueo indicado no es de dia completo", {
          code: "ADMIN_CITAS_DAY_OFF_NOT_FULL_DAY",
        });
      }
      const scope = String(request.query?.scope || "").toLowerCase();
      if (scope === "sucursal") {
        const deleted = await app.db.query(
          `
            DELETE FROM public.bloqueos_agenda
            WHERE id_sucursal = $1::uuid
              AND tipo_bloqueo_codigo = $2::text
              AND rango = tstzrange($3::timestamptz, $4::timestamptz, '[)')
              AND COALESCE(motivo, '') = COALESCE($5::text, '')
            RETURNING id_bloqueo
          `,
          [dayOff.id_sucursal, dayOff.tipo_bloqueo_codigo, dayOff.inicio_at, dayOff.fin_at, dayOff.motivo]
        );
        return sendOk(reply, {
          dia_inhabilitado: dayOff,
          bloqueos_eliminados: deleted.rows.length,
        });
      }

      await app.db.query(`DELETE FROM public.bloqueos_agenda WHERE id_bloqueo = $1::uuid`, [idBloqueo]);
      return sendOk(reply, { dia_inhabilitado: dayOff, bloqueos_eliminados: 1 });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo eliminar el dia inhabilitado", "ADMIN_CITAS_DAYS_OFF_DELETE_ERROR");
    }
  });

  app.get("/parametros", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      await getScopeBranches(app, request.claims);
      const values = await getSystemParameters(app.db);
      return sendOk(reply, { parametros: selectParams(values) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudieron consultar los parametros", "ADMIN_CITAS_PARAMS_GET_ERROR");
    }
  });

  app.patch("/parametros", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await getScopeBranches(app, request.claims);
      const numericUpdates = [];
      const booleanUpdates = [];
      if (request.body?.hold_duracion_min !== undefined) {
        numericUpdates.push(["hold_duracion_min", Number(request.body.hold_duracion_min), "Duracion en minutos del hold de citas"]);
      }
      if (request.body?.no_show_min !== undefined) {
        numericUpdates.push(["no_show_min", Number(request.body.no_show_min), "Minutos para marcar no_show"]);
      }
      if (request.body?.permitir_acompanantes !== undefined) {
        booleanUpdates.push([
          "permitir_acompanantes",
          normalizeBoolean(request.body.permitir_acompanantes, "permitir_acompanantes"),
          "Permite registrar acompanantes en la cita",
        ]);
      }
      if (request.body?.pago_total_obligatorio !== undefined) {
        const pagoTotal = normalizeBoolean(request.body.pago_total_obligatorio, "pago_total_obligatorio");
        if (!pagoTotal) {
          throw new AppError(409, "La regla de negocio exige pago total obligatorio para agendar", {
            code: "ADMIN_CITAS_PAYMENT_RULE_ENFORCED",
          });
        }
        booleanUpdates.push([
          "pago_total_obligatorio",
          true,
          "Define si se exige el pago total para confirmar la cita",
        ]);
      }

      if (!numericUpdates.length && !booleanUpdates.length) {
        throw new AppError(400, "Debes enviar al menos un parametro para actualizar", {
          code: "ADMIN_CITAS_PARAMS_EMPTY",
        });
      }

      await dbClient.query("BEGIN");
      for (const [clave, valor, descripcion] of numericUpdates) {
        if (!Number.isFinite(valor) || valor <= 0) {
          throw new AppError(400, `${clave} debe ser un numero positivo`, {
            code: "ADMIN_CITAS_PARAMS_INVALID",
          });
        }

        await dbClient.query(
          `
            INSERT INTO public.parametros_sistema (clave, valor_numero, descripcion, updated_at)
            VALUES ($1::text, $2::numeric, $3::text, now())
            ON CONFLICT (clave)
            DO UPDATE SET valor_numero = EXCLUDED.valor_numero, valor_booleano = NULL, updated_at = now()
          `,
          [clave, valor, descripcion]
        );
      }

      for (const [clave, valor, descripcion] of booleanUpdates) {
        await dbClient.query(
          `
            INSERT INTO public.parametros_sistema (clave, valor_booleano, descripcion, updated_at)
            VALUES ($1::text, $2::boolean, $3::text, now())
            ON CONFLICT (clave)
            DO UPDATE SET valor_booleano = EXCLUDED.valor_booleano, valor_numero = NULL, updated_at = now()
          `,
          [clave, Boolean(valor), descripcion]
        );
      }
      await dbClient.query("COMMIT");

      const values = await getSystemParameters(dbClient);
      return sendOk(reply, { parametros: selectParams(values) });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudieron actualizar los parametros", "ADMIN_CITAS_PARAMS_PATCH_ERROR");
    } finally {
      dbClient.release();
    }
  });
}
