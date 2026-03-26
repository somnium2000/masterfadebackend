/* eslint-disable no-console */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import jwt from "jsonwebtoken";
import { buildApp } from "../src/app.js";

const TEST_TAG = `MP_CHECK_${Date.now()}`;
const results = [];
const created = {
  personas: [],
  clientes: [],
  citas: [],
  ruleId: null,
};

function recordCase(name, passed, details) {
  results.push({ caso: name, passed, details });
}

function addDays(baseDate, days, hour = 8) {
  const date = new Date(baseDate);
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

function addMinutes(baseDate, minutes) {
  return new Date(baseDate.getTime() + minutes * 60 * 1000);
}

async function createTestPersona(client, suffix) {
  const { rows } = await client.query(
    `
      INSERT INTO public.personas (nombres, apellidos, observaciones)
      VALUES ($1::text, $2::text, $3::text)
      RETURNING id_persona
    `,
    [`TEST_${suffix}`, `MASTERPUNTOS_${suffix}`, TEST_TAG]
  );
  const idPersona = rows[0].id_persona;
  created.personas.push(idPersona);
  return idPersona;
}

async function createTestCliente(client, { idPersona, idUsuario = null, idSucursal }) {
  const { rows } = await client.query(
    `
      INSERT INTO public.clientes (
        id_persona,
        id_usuario,
        id_sucursal_origen,
        estado,
        consentimiento_marketing,
        acepta_terminos
      )
      VALUES ($1::uuid, $2::uuid, $3::uuid, TRUE, FALSE, TRUE)
      RETURNING id_cliente
    `,
    [idPersona, idUsuario, idSucursal]
  );
  const idCliente = rows[0].id_cliente;
  created.clientes.push(idCliente);
  return idCliente;
}

async function createCita(client, payload) {
  const { rows } = await client.query(
    `
      INSERT INTO public.citas (
        id_sucursal,
        id_empleado_barbero,
        id_persona_cliente,
        id_cliente,
        creada_por_usuario_id,
        estado_cita_codigo,
        inicio_at,
        fin_at,
        duracion_total_min,
        buffer_total_min,
        subtotal_servicios_hnl,
        descuento_hnl,
        total_pagar_hnl,
        moneda_codigo,
        notas
      )
      VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::timestamptz, $8::timestamptz,
        30, 0, $9::numeric, 0, $9::numeric, 'HNL', $10::text
      )
      RETURNING id_cita
    `,
    [
      payload.idSucursal,
      payload.idBarbero,
      payload.idPersonaCliente,
      payload.idCliente,
      payload.idUsuarioCreador,
      payload.estado,
      payload.inicioAt,
      payload.finAt,
      payload.total,
      `${TEST_TAG}_${payload.note}`,
    ]
  );
  const idCita = rows[0].id_cita;
  created.citas.push(idCita);
  return idCita;
}

async function cleanup(client) {
  if (created.citas.length) {
    await client.query("DELETE FROM public.points_transactions WHERE id_cita = ANY($1::uuid[])", [created.citas]);
    await client.query("DELETE FROM public.citas WHERE id_cita = ANY($1::uuid[])", [created.citas]);
  }
  if (created.clientes.length) {
    await client.query("DELETE FROM public.points_transactions WHERE id_cliente = ANY($1::uuid[])", [created.clientes]);
    await client.query("DELETE FROM public.points_cycles WHERE id_cliente = ANY($1::uuid[])", [created.clientes]);
  }
  await client.query("DELETE FROM public.points_transactions WHERE motivo ILIKE $1::text", [`%${TEST_TAG}%`]);
  if (created.ruleId) {
    await client.query("DELETE FROM public.points_rule_services WHERE id_rule = $1::uuid", [created.ruleId]);
    await client.query("DELETE FROM public.points_rules WHERE id_rule = $1::uuid", [created.ruleId]);
  }
  if (created.clientes.length) {
    await client.query("DELETE FROM public.clientes WHERE id_cliente = ANY($1::uuid[])", [created.clientes]);
  }
  if (created.personas.length) {
    await client.query("DELETE FROM public.personas WHERE id_persona = ANY($1::uuid[])", [created.personas]);
  }
}

const app = await buildApp();
const dbClient = await app.db.connect();

try {
  const setupResult = await dbClient.query(
    `
      WITH admin_user AS (
        SELECT u.id_usuario
        FROM public.usuarios u
        JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario AND ru.activo IS TRUE
        JOIN public.roles r ON r.id_rol = ru.id_rol
        WHERE u.deleted_at IS NULL
          AND r.nombre IN ('super_admin', 'admin')
        ORDER BY u.id_usuario
        LIMIT 1
      ),
      branch_barber AS (
        SELECT e.id_sucursal, e.id_empleado AS id_barbero
        FROM public.empleados e
        JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
        WHERE e.deleted_at IS NULL
          AND e.estado IS TRUE
          AND e.es_barbero IS TRUE
          AND s.deleted_at IS NULL
          AND s.estado IS TRUE
        ORDER BY e.created_at ASC
        LIMIT 1
      ),
      branch_service AS (
        SELECT st.id_servicio
        FROM public.servicios_tarifas st
        JOIN public.servicios s ON s.id_servicio = st.id_servicio
        WHERE st.id_sucursal = (SELECT id_sucursal FROM branch_barber)
          AND st.id_empleado IS NULL
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND st.vigente_desde <= CURRENT_DATE
          AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
          AND s.deleted_at IS NULL
          AND s.activo IS TRUE
        ORDER BY st.updated_at DESC
        LIMIT 1
      ),
      companion AS (
        SELECT c.id_persona
        FROM public.clientes c
        WHERE c.id_sucursal_origen = (SELECT id_sucursal FROM branch_barber)
          AND c.deleted_at IS NULL
          AND c.estado IS TRUE
        ORDER BY c.created_at ASC
        LIMIT 1
      )
      SELECT
        (SELECT id_usuario FROM admin_user) AS id_usuario_admin,
        (SELECT id_sucursal FROM branch_barber) AS id_sucursal,
        (SELECT id_barbero FROM branch_barber) AS id_barbero,
        (SELECT id_servicio FROM branch_service) AS id_servicio_canje,
        (SELECT id_persona FROM companion) AS id_persona_companion
    `
  );

  const setup = setupResult.rows[0];
  if (!setup?.id_usuario_admin || !setup?.id_sucursal || !setup?.id_barbero || !setup?.id_servicio_canje) {
    throw new Error("No fue posible preparar escenario minimo (admin, sucursal, barbero, servicio).");
  }

  const idPersonaPayer = await createTestPersona(dbClient, "PAYER");
  const idPersonaNoUser = await createTestPersona(dbClient, "NOUSER");
  const idClientePayer = await createTestCliente(dbClient, {
    idPersona: idPersonaPayer,
    idUsuario: setup.id_usuario_admin,
    idSucursal: setup.id_sucursal,
  });
  const idClienteNoUser = await createTestCliente(dbClient, {
    idPersona: idPersonaNoUser,
    idUsuario: null,
    idSucursal: setup.id_sucursal,
  });

  const ruleInsert = await dbClient.query(
    `
      INSERT INTO public.points_rules (
        id_sucursal, umbral_monto_hnl, puntos_por_cita, puntos_para_premio, expiracion_meses, activo
      )
      VALUES ($1::uuid, 250, 1, 3, 12, TRUE)
      RETURNING id_rule
    `,
    [setup.id_sucursal]
  );
  created.ruleId = ruleInsert.rows[0].id_rule;
  await dbClient.query(
    `INSERT INTO public.points_rule_services (id_rule, id_servicio) VALUES ($1::uuid, $2::uuid)`,
    [created.ruleId, setup.id_servicio_canje]
  );

  const base = new Date();
  const t1 = addDays(base, 90, 8);
  const t2 = addDays(base, 90, 9);
  const t3 = addDays(base, 90, 10);
  const t4 = addDays(base, 90, 11);
  const t5 = addDays(base, 90, 12);

  const c1 = await createCita(dbClient, { idSucursal: setup.id_sucursal, idBarbero: setup.id_barbero, idPersonaCliente: idPersonaPayer, idCliente: idClientePayer, idUsuarioCreador: setup.id_usuario_admin, estado: "pendiente_pago", inicioAt: t1, finAt: addMinutes(t1, 30), total: 249, note: "CASE1" });
  await dbClient.query(`UPDATE public.citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1::uuid`, [c1]);
  const case1 = await dbClient.query(`SELECT COUNT(*)::int AS total FROM public.points_transactions WHERE id_cita=$1::uuid AND tipo_puntos_codigo='acumular'`, [c1]);
  recordCase("Caso 1: monto menor al umbral no acumula", case1.rows[0].total === 0, { acumulaciones: case1.rows[0].total });

  const c2 = await createCita(dbClient, { idSucursal: setup.id_sucursal, idBarbero: setup.id_barbero, idPersonaCliente: idPersonaPayer, idCliente: idClientePayer, idUsuarioCreador: setup.id_usuario_admin, estado: "pendiente_pago", inicioAt: t2, finAt: addMinutes(t2, 30), total: 250, note: "CASE2" });
  await dbClient.query(`UPDATE public.citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1::uuid`, [c2]);
  const case2 = await dbClient.query(`SELECT COUNT(*)::int AS total FROM public.points_transactions WHERE id_cita=$1::uuid AND tipo_puntos_codigo='acumular'`, [c2]);
  recordCase("Caso 2: monto >= umbral acumula 1 punto", case2.rows[0].total === 1, { acumulaciones: case2.rows[0].total });

  await dbClient.query(`UPDATE public.citas SET estado_cita_codigo='no_show', no_show_at=now() WHERE id_cita=$1::uuid`, [c2]);
  const case3 = await dbClient.query(`SELECT COUNT(*)::int AS total FROM public.points_transactions WHERE id_cita=$1::uuid AND tipo_puntos_codigo='acumular'`, [c2]);
  recordCase("Caso 3: no_show posterior conserva puntos", case3.rows[0].total === 1, { acumulaciones: case3.rows[0].total });

  const c3 = await createCita(dbClient, { idSucursal: setup.id_sucursal, idBarbero: setup.id_barbero, idPersonaCliente: idPersonaPayer, idCliente: idClientePayer, idUsuarioCreador: setup.id_usuario_admin, estado: "pendiente_pago", inicioAt: t3, finAt: addMinutes(t3, 30), total: 320, note: "CASE4_A" });
  const c4 = await createCita(dbClient, { idSucursal: setup.id_sucursal, idBarbero: setup.id_barbero, idPersonaCliente: idPersonaPayer, idCliente: idClientePayer, idUsuarioCreador: setup.id_usuario_admin, estado: "pendiente_pago", inicioAt: t4, finAt: addMinutes(t4, 30), total: 280, note: "CASE4_B" });
  await dbClient.query(`UPDATE public.citas SET estado_cita_codigo='confirmada' WHERE id_cita = ANY($1::uuid[])`, [[c3, c4]]);
  const case4 = await dbClient.query(`SELECT COUNT(*)::int AS total FROM public.points_transactions WHERE id_cita = ANY($1::uuid[]) AND tipo_puntos_codigo='acumular'`, [[c3, c4]]);
  recordCase("Caso 4: acompañantes suman al pagador por bloque", case4.rows[0].total === 2, { acumulaciones: case4.rows[0].total });

  const c5 = await createCita(dbClient, { idSucursal: setup.id_sucursal, idBarbero: setup.id_barbero, idPersonaCliente: idPersonaNoUser, idCliente: idClienteNoUser, idUsuarioCreador: setup.id_usuario_admin, estado: "pendiente_pago", inicioAt: t5, finAt: addMinutes(t5, 30), total: 300, note: "CASE5" });
  await dbClient.query(`UPDATE public.citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1::uuid`, [c5]);
  const case5 = await dbClient.query(`SELECT COUNT(*)::int AS total FROM public.points_transactions WHERE id_cita=$1::uuid AND tipo_puntos_codigo='acumular'`, [c5]);
  recordCase("Caso 5: cliente sin usuario no acumula", case5.rows[0].total === 0, { acumulaciones: case5.rows[0].total });

  const token = jwt.sign({ sub: setup.id_usuario_admin, token_type: "app" }, process.env.JWT_SECRET, {
    issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
    audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
    expiresIn: "15m",
  });
  const headers = { authorization: `Bearer ${token}` };

  const canjePayload = {
    id_cliente: idClientePayer,
    id_servicio: setup.id_servicio_canje,
    id_sucursal: setup.id_sucursal,
    motivo: `${TEST_TAG}_CASE6`,
  };
  const case6Resp = await app.inject({ method: "POST", url: "/v1/admin/masterpuntos/canjes", headers, payload: canjePayload });
  recordCase("Caso 6: canje con premio disponible descuenta puntos", case6Resp.statusCode === 201, { status: case6Resp.statusCode });

  const case7Resp = await app.inject({ method: "POST", url: "/v1/admin/masterpuntos/canjes", headers, payload: canjePayload });
  recordCase("Caso 7: canje sin saldo suficiente falla", case7Resp.statusCode === 409, { status: case7Resp.statusCode });

  const expiryRows = await dbClient.query(
    `
      SELECT id_cycle, COUNT(DISTINCT vence_at)::int AS fechas_vencimiento
      FROM public.points_transactions
      WHERE id_cliente = $1::uuid
        AND tipo_puntos_codigo = 'acumular'
        AND id_cita = ANY($2::uuid[])
      GROUP BY id_cycle
      LIMIT 1
    `,
    [idClientePayer, [c2, c3, c4]]
  );
  const cycleId = expiryRows.rows[0]?.id_cycle || null;
  if (cycleId) {
    await dbClient.query(
      `
        UPDATE public.points_cycles
        SET primer_acumulado_at = now() - interval '2 years',
            vence_at = now() - interval '1 day'
        WHERE id_cycle = $1::uuid
      `,
      [cycleId]
    );
    await dbClient.query(`SELECT public.fn_points_materialize_expired_cycles($1::uuid)`, [idClientePayer]);
    const cycleState = await dbClient.query(`SELECT estado_ciclo_codigo FROM public.points_cycles WHERE id_cycle = $1::uuid`, [cycleId]);
    const case8Pass = expiryRows.rows[0].fechas_vencimiento === 1 && cycleState.rows[0]?.estado_ciclo_codigo === "expirado";
    recordCase("Caso 8: vencimiento por ciclo con misma fecha", case8Pass, {
      fechas_vencimiento: expiryRows.rows[0].fechas_vencimiento,
      estado_ciclo: cycleState.rows[0]?.estado_ciclo_codigo || null,
    });
  } else {
    recordCase("Caso 8: vencimiento por ciclo con misma fecha", false, { error: "No se encontro ciclo para validar" });
  }

  const case9Resp = await app.inject({
    method: "GET",
    url: "/v1/admin/masterpuntos/clientes?id_sucursal=' OR 1=1 --",
    headers,
  });
  recordCase("Caso 9: inyección SQL en filtros no rompe consulta", case9Resp.statusCode === 400, { status: case9Resp.statusCode });

  const pagePath = path.resolve("..", "front-end", "masterFade", "src", "features", "admin", "pages", "AdminMasterPuntosPage.jsx");
  const appPath = path.resolve("..", "front-end", "masterFade", "src", "App.jsx");
  const [pageSrc, appSrc] = await Promise.all([fs.readFile(pagePath, "utf8"), fs.readFile(appPath, "utf8")]);
  const case10Pass = pageSrc.includes("LoadingSpinner") && pageSrc.includes("EmptyState") && pageSrc.includes("ErrorBanner") && appSrc.includes("superpuntos");
  recordCase("Caso 10: estados UX y wiring visual consistentes", case10Pass, {
    loading: pageSrc.includes("LoadingSpinner"),
    empty: pageSrc.includes("EmptyState"),
    error: pageSrc.includes("ErrorBanner"),
    route: appSrc.includes("superpuntos"),
  });
} catch (error) {
  recordCase("Ejecucion global", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  try {
    await cleanup(dbClient);
  } catch (cleanupError) {
    recordCase("Cleanup", false, { error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
  }
  dbClient.release();
  await app.close();
}

const summary = {
  tag: TEST_TAG,
  total: results.length,
  passed: results.filter((item) => item.passed).length,
  failed: results.filter((item) => !item.passed).length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
