import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { startPostgres17 } from "./helpers/postgres17.mjs";
import {
  consumeMembershipForCompletedAppointment,
  ensureSubscriptionLifecycle,
  getClienteMembershipState,
} from "../src/services/membershipService.js";

const RUN = Boolean(process.env.MASTERFADE_TEST_PG_BIN);

// AM: Solo clúster efímero propio; nunca admite una URL de QA ni una base compartida.
test("QA-MEMBRESIAS-CONSUMO-01: cuotas, idempotencia y bloqueos en PostgreSQL 17", {
  skip: !RUN,
  timeout: 120000,
}, async (t) => {
  const isolated = await startPostgres17();
  const pool = new pg.Pool({ ...isolated.connectionOptions, max: 6 });
  t.after(async () => { await pool.end(); await isolated.stop(); });
  t.diagnostic(`PostgreSQL ${String((await pool.query("SHOW server_version")).rows[0].server_version).split(" ")[0]}; localhost:${isolated.connectionOptions.port}; base postgres efímera`);

  await pool.query(`
    CREATE TABLE personas(id_persona uuid PRIMARY KEY, nombres text, apellidos text);
    CREATE TABLE usuarios(id_usuario uuid PRIMARY KEY, id_persona uuid REFERENCES personas);
    CREATE TABLE clientes(id_cliente uuid PRIMARY KEY, id_persona uuid REFERENCES personas);
    CREATE TABLE sucursales(id_sucursal uuid PRIMARY KEY, nombre_sucursal text NOT NULL);
    CREATE TABLE servicios(id_servicio uuid PRIMARY KEY, nombre_servicio text NOT NULL);
    CREATE TABLE cortesias(id_cortesia uuid PRIMARY KEY, nombre_cortesia text NOT NULL);
    CREATE TABLE membership_plans(
      id_plan uuid PRIMARY KEY, nombre_plan text NOT NULL, descripcion text,
      periodo_membresia_codigo text NOT NULL, categoria_nivel integer NOT NULL
    );
    CREATE TABLE subscriptions(
      id_suscripcion uuid PRIMARY KEY, id_cliente uuid NOT NULL REFERENCES clientes,
      id_plan uuid NOT NULL REFERENCES membership_plans,
      estado_suscripcion_codigo text NOT NULL, inicio_at timestamptz NOT NULL,
      fin_at timestamptz NOT NULL, renovacion_auto boolean NOT NULL DEFAULT false,
      cancelada_al_fin boolean NOT NULL DEFAULT false,
      id_sucursal_contratada uuid NOT NULL REFERENCES sucursales,
      beneficios_snapshot jsonb NOT NULL, motivo_fin_codigo text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX ON subscriptions(id_cliente) WHERE estado_suscripcion_codigo='activa';
    CREATE TABLE membership_plans_sucursal(
      id_plan_sucursal uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_plan uuid REFERENCES membership_plans,
      id_sucursal uuid REFERENCES sucursales, precio_hnl numeric NOT NULL DEFAULT 100,
      activo boolean NOT NULL DEFAULT true, visible_publico boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE citas(
      id_cita uuid PRIMARY KEY, id_cliente uuid NOT NULL REFERENCES clientes,
      id_sucursal uuid NOT NULL REFERENCES sucursales, estado_cita_codigo text NOT NULL,
      id_grupo_cita uuid NOT NULL, orden_integrante integer NOT NULL DEFAULT 1, inicio_at timestamptz NOT NULL DEFAULT now(),
      llegada_real_at timestamptz, atencion_iniciada_at timestamptz, atencion_finalizada_at timestamptz,
      deleted_at timestamptz
    );
    CREATE TABLE citas_detalles(
      id_cita_detalle uuid PRIMARY KEY, id_cita uuid NOT NULL REFERENCES citas,
      id_servicio uuid NOT NULL REFERENCES servicios, cantidad integer NOT NULL CHECK(cantidad>0),
      origen_item_codigo text NOT NULL, nombre_servicio_snapshot text,
      precio_unitario_hnl numeric NOT NULL DEFAULT 100, subtotal_hnl numeric NOT NULL DEFAULT 100,
      descuento_hnl numeric NOT NULL DEFAULT 0, total_linea_hnl numeric NOT NULL DEFAULT 100,
      line_key text, descuento_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE subscription_consumptions(
      id_consumo uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_suscripcion uuid NOT NULL REFERENCES subscriptions,
      id_cliente uuid NOT NULL REFERENCES clientes, id_cita uuid NOT NULL REFERENCES citas,
      orden_integrante integer, item_tipo text NOT NULL CHECK(item_tipo IN ('servicio','cortesia')),
      id_servicio uuid REFERENCES servicios, id_cortesia uuid REFERENCES cortesias,
      item_codigo text, item_nombre text NOT NULL, cantidad integer NOT NULL CHECK(cantidad>0),
      precio_unitario_hnl numeric NOT NULL CHECK(precio_unitario_hnl>=0),
      total_hnl numeric NOT NULL CHECK(total_hnl>=0),
      coverage_status text NOT NULL CHECK(coverage_status IN ('cubierto_plan','extra_pendiente','extra_pagado')),
      source_key text NOT NULL UNIQUE, source_kind text NOT NULL,
      invalidado boolean NOT NULL DEFAULT false, invalidado_motivo text,
      id_usuario_ejecutor uuid REFERENCES usuarios,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE SCHEMA app_private;
    CREATE TABLE app_private.reserva_idempotencia(
      id_grupo_cita uuid PRIMARY KEY, id_cliente uuid NOT NULL REFERENCES clientes,
      response_payload jsonb NOT NULL, scope text NOT NULL DEFAULT 'auth:citas:hold'
    );
    CREATE TABLE citas_admin_beneficios_resumen(
      id_grupo_cita uuid PRIMARY KEY, resumen_beneficios jsonb NOT NULL
    );
  `);

  async function fixture({ quotas = [8, 8, 8], courtesyQuota = 8, legacyCourtesy = false } = {}) {
    await pool.query("TRUNCATE app_private.reserva_idempotencia,citas_admin_beneficios_resumen,subscription_consumptions,citas_detalles,citas,membership_plans_sucursal,subscriptions,membership_plans,cortesias,servicios,clientes,usuarios,personas,sucursales CASCADE");
    const f = { client: randomUUID(), otherClient: randomUUID(), branch: randomUUID(), otherBranch: randomUUID(),
      plan: randomUUID(), subscription: randomUUID(), actor: randomUUID(), courtesy: randomUUID(),
      services: [randomUUID(), randomUUID(), randomUUID()], extra: randomUUID() };
    const person = randomUUID();
    await pool.query("INSERT INTO personas VALUES($1,'Operador','Sintético')", [person]);
    await pool.query("INSERT INTO usuarios VALUES($1,$2)", [f.actor, person]);
    await pool.query("INSERT INTO clientes VALUES($1,$3),($2,$3)", [f.client, f.otherClient, person]);
    await pool.query("INSERT INTO sucursales VALUES($1,'Sucursal sintética A'),($2,'Sucursal sintética B')", [f.branch, f.otherBranch]);
    await pool.query("INSERT INTO membership_plans VALUES($1,'Plan sintético','Fixture aislado','mensual',1)", [f.plan]);
    for (const [i, service] of [...f.services, f.extra].entries()) {
      await pool.query("INSERT INTO servicios VALUES($1,$2)", [service, `Servicio ${i + 1}`]);
    }
    await pool.query("INSERT INTO cortesias VALUES($1,'Cortesía sintética')", [f.courtesy]);
    const items = f.services.map((id_servicio, i) => ({ tipo: "servicio", id_servicio, nombre: `Servicio ${i + 1}`, cantidad: quotas[i] }));
    if (courtesyQuota) items.push({ tipo: "cortesia", ...(legacyCourtesy ? { codigo: "legacy" } : { id_cortesia: f.courtesy }), nombre: "Cortesía sintética", cantidad: courtesyQuota });
    await pool.query(`INSERT INTO subscriptions(id_suscripcion,id_cliente,id_plan,estado_suscripcion_codigo,inicio_at,fin_at,id_sucursal_contratada,beneficios_snapshot)
      VALUES($1,$2,$3,'activa',now()-interval '1 day',now()+interval '30 days',$4,$5::jsonb)`, [f.subscription, f.client, f.plan, f.branch, JSON.stringify({ version: 1, items })]);
    await pool.query("INSERT INTO membership_plans_sucursal(id_plan,id_sucursal) VALUES($1,$2)", [f.plan, f.branch]);
    return f;
  }

  async function appointment(f, lines, { state = "confirmada", client = f.client, branch = f.branch, order = 1, future = false, evidence = true, admin = false } = {}) {
    const id = randomUUID();
    const group = randomUUID();
    await pool.query(`INSERT INTO citas(id_cita,id_cliente,id_sucursal,estado_cita_codigo,orden_integrante,inicio_at,id_grupo_cita)
      VALUES($1,$2,$3,$4,$5,now()+$6::interval,$7)`, [id, client, branch, state, order, future ? "13 days" : "-1 hour", group]);
    const details = [];
    const coveredServices = [];
    for (const line of lines) {
      const detail = randomUUID();
      const qty = line.quantity || 1;
      const covered = line.covered !== false;
      await pool.query(`INSERT INTO citas_detalles(id_cita_detalle,id_cita,id_servicio,cantidad,origen_item_codigo,
        nombre_servicio_snapshot,precio_unitario_hnl,subtotal_hnl,descuento_hnl,total_linea_hnl,line_key)
        VALUES($1,$2,$3,$4,$5,'Servicio fixture',100,$6,$7,$8,$9)`, [detail, id, line.service, qty,
        covered ? "plan_incluido" : "servicio_extra", 100 * qty, covered ? 100 * qty : 0, covered ? 0 : 100 * qty, `fixture:${detail}`]);
      details.push(detail);
      if (covered) coveredServices.push({ id_servicio: line.service, line_key: `fixture:${detail}`, cantidad: qty });
    }
    if (evidence) {
      const payload = { membership_consumption: { version: 1, id_suscripcion: f.subscription,
        citas: [{ id_cita: id, servicios: coveredServices }] } };
      if (admin) await pool.query("INSERT INTO citas_admin_beneficios_resumen VALUES($1,$2::jsonb)", [group, JSON.stringify(payload)]);
      else await pool.query("INSERT INTO app_private.reserva_idempotencia(id_grupo_cita,id_cliente,response_payload) VALUES($1,$2,$3::jsonb)", [group, client, JSON.stringify(payload)]);
    }
    return { id, details, group };
  }

  async function consume(f, cita, { rollback = false, actor = f.actor, client = f.client, branch = f.branch, order = 1 } = {}) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await consumeMembershipForCompletedAppointment(db, {
        idCita: cita.id, idCliente: client, idSucursal: branch, ordenIntegrante: order, usuarioEjecutorId: actor,
      });
      await db.query(rollback ? "ROLLBACK" : "COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally { db.release(); }
  }

  const rows = async (cita) => (await pool.query("SELECT * FROM subscription_consumptions WHERE id_cita=$1 ORDER BY source_key", [cita.id])).rows;
  const totals = async (cita) => new Map((await pool.query(`SELECT id_servicio,SUM(cantidad)::int cantidad FROM subscription_consumptions
    WHERE id_cita=$1 AND item_tipo='servicio' GROUP BY id_servicio`, [cita.id])).rows.map(row => [row.id_servicio, row.cantidad]));
  const summary = async (f) => (await getClienteMembershipState(pool, f.client));

  await t.test("un servicio incluido: cuota, cortesía, autor e historial", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.services[0] }]);
    assert.equal((await consume(f, cita)).aplicado, true);
    assert.deepEqual(await totals(cita), new Map([[f.services[0], 1]]));
    const ledger = await rows(cita);
    assert.equal(ledger.length, 2);
    assert.equal(ledger.filter(row => row.item_tipo === "cortesia")[0].cantidad, 1);
    for (const row of ledger) {
      assert.equal(row.id_suscripcion, f.subscription);
      assert.equal(row.id_cliente, f.client);
      assert.equal(row.id_usuario_ejecutor, f.actor);
      assert.equal(row.source_kind, "appointment_completed");
      assert.equal(row.coverage_status, "cubierto_plan");
    }
    const state = await summary(f);
    assert.equal(state.plan_activo.remanentes.totales.servicios_restantes, 23);
    assert.equal(state.plan_activo.remanentes.totales.cortesias_restantes, 7);
    assert.equal(state.historial_consumos.length, 2);
    assert.ok(state.historial_consumos.every(row => row.nombre_usuario_ejecutor === "Operador Sintético"));
  });

  await t.test("tres servicios distintos descuentan sus tres cuotas y una sola cortesía", async () => {
    const f = await fixture();
    const cita = await appointment(f, f.services.map(service => ({ service })));
    await consume(f, cita);
    assert.deepEqual(await totals(cita), new Map(f.services.map(service => [service, 1])));
    assert.equal((await rows(cita)).filter(row => row.item_tipo === "cortesia").length, 1);
    const state = await summary(f);
    assert.equal(state.plan_activo.remanentes.totales.servicios_restantes, 21);
    assert.ok(state.plan_activo.remanentes.servicios.every(row => row.restante === 7));
  });

  await t.test("servicios adicionales conservan importes y no descuentan cuotas ajenas", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.services[0] }, { service: f.extra, covered: false }]);
    const before = (await pool.query("SELECT * FROM citas_detalles WHERE id_cita=$1 ORDER BY id_cita_detalle", [cita.id])).rows;
    await consume(f, cita);
    assert.deepEqual(await totals(cita), new Map([[f.services[0], 1]]));
    assert.deepEqual((await pool.query("SELECT * FROM citas_detalles WHERE id_cita=$1 ORDER BY id_cita_detalle", [cita.id])).rows, before);
    assert.equal((await summary(f)).plan_activo.remanentes.servicios.filter(row => row.consumido > 0).length, 1);
  });

  await t.test("repeticiones y cantidad agrupada descuentan cada unidad sin duplicarse", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.services[0], quantity: 2 }, { service: f.services[0] }, { service: f.services[1] }]);
    await consume(f, cita);
    assert.deepEqual(await totals(cita), new Map([[f.services[0], 3], [f.services[1], 1]]));
    const before = await rows(cita);
    await consume(f, cita);
    assert.deepEqual(await rows(cita), before);
    assert.equal(new Set(before.map(row => row.source_key)).size, before.length);
  });

  await t.test("una línea agrupada conserva la cantidad cubierta y la unidad adicional del mismo servicio", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.services[0], quantity: 2 }]);
    await pool.query(`UPDATE app_private.reserva_idempotencia
      SET response_payload=jsonb_set(response_payload,'{membership_consumption,citas,0,servicios,0,cantidad}','1'::jsonb)
      WHERE id_grupo_cita=$1`, [cita.group]);
    await pool.query("UPDATE citas_detalles SET descuento_hnl=100,total_linea_hnl=100 WHERE id_cita=$1", [cita.id]);
    const before = (await pool.query("SELECT * FROM citas_detalles WHERE id_cita=$1", [cita.id])).rows;
    await consume(f, cita);
    assert.deepEqual(await totals(cita), new Map([[f.services[0], 1]]));
    assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_restantes, 23);
    assert.deepEqual((await pool.query("SELECT * FROM citas_detalles WHERE id_cita=$1", [cita.id])).rows, before);
  });

  await t.test("confirmación administrativa utiliza la evidencia persistida del mismo grupo", async () => {
    const f = await fixture();
    const cita = await appointment(f, f.services.map(service => ({ service })), { admin: true });
    await consume(f, cita);
    assert.deepEqual(await totals(cita), new Map(f.services.map(service => [service, 1])));
  });

  await t.test("cita histórica sin evidencia no se rellena ni modifica automáticamente", async () => {
    const f = await fixture();
    const cita = await appointment(f, f.services.map(service => ({ service })), { evidence: false });
    await assert.rejects(consume(f, cita), error => error.code === "MEMBERSHIP_CONSUMPTION_EVIDENCE_REQUIRED");
    assert.deepEqual(await rows(cita), []);
  });

  await t.test("ledger histórico por cita no se completa automáticamente durante un reintento", async () => {
    const f = await fixture();
    const cita = await appointment(f, f.services.map(service => ({ service })), { evidence: false });
    await pool.query(`INSERT INTO subscription_consumptions(id_suscripcion,id_cliente,id_cita,item_tipo,
      id_servicio,item_nombre,cantidad,precio_unitario_hnl,total_hnl,coverage_status,source_key,source_kind,id_usuario_ejecutor)
      VALUES($1,$2,$3,'servicio',$4,'Servicio histórico',1,0,0,'cubierto_plan',$5,'appointment_completed',$6)`,
    [f.subscription, f.client, cita.id, f.services[0], `appointment:${cita.id}:servicio`, f.actor]);
    const before = await rows(cita);
    assert.equal((await consume(f, cita)).aplicado, false);
    assert.deepEqual(await rows(cita), before);
  });

  await t.test("pendiente, cancelada, expirada y no_show no generan nuevos consumos", async () => {
    for (const state of ["pendiente_pago", "cancelada", "expirada", "no_show"]) {
      const f = await fixture();
      const cita = await appointment(f, [{ service: f.services[0] }], { state });
      assert.equal((await consume(f, cita)).aplicado, false, state);
      assert.deepEqual(await rows(cita), [], state);
    }
  });

  await t.test("cuota de un servicio agotada no usa otro beneficio ni deja consumo parcial", async () => {
    const f = await fixture({ quotas: [1, 8, 8] });
    const first = await appointment(f, [{ service: f.services[0] }]);
    await consume(f, first);
    const second = await appointment(f, [{ service: f.services[1] }, { service: f.services[0] }]);
    await assert.rejects(consume(f, second), error => error.code === "MEMBERSHIP_CONSUMPTION_SERVICE_BALANCE_INSUFFICIENT");
    assert.deepEqual(await rows(second), []);
    assert.equal((await summary(f)).plan_activo.remanentes.servicios.find(row => row.id_servicio === f.services[1]).consumido, 0);
  });

  await t.test("dos citas concurrentes disputan una cuota y solo una confirma el descuento", async () => {
    const f = await fixture({ quotas: [1, 8, 8] });
    const a = await appointment(f, [{ service: f.services[0] }]);
    const b = await appointment(f, [{ service: f.services[0] }]);
    const results = await Promise.allSettled([consume(f, a), consume(f, b)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected");
    assert.equal(rejected.reason.code, "MEMBERSHIP_CONSUMPTION_SERVICE_BALANCE_INSUFFICIENT");
    assert.equal((await pool.query("SELECT SUM(cantidad)::int cantidad FROM subscription_consumptions WHERE item_tipo='servicio' AND id_servicio=$1", [f.services[0]])).rows[0].cantidad, 1);
    assert.equal((await pool.query("SELECT COUNT(*)::int cantidad FROM subscription_consumptions WHERE item_tipo='cortesia'")).rows[0].cantidad, 1);
  });

  await t.test("reintentos concurrentes de la misma cita conservan claves y cantidades", async () => {
    const f = await fixture();
    const cita = await appointment(f, f.services.map(service => ({ service })));
    const results = await Promise.all([consume(f, cita), consume(f, cita), consume(f, cita)]);
    assert.equal(results.filter(result => result.aplicado).length, 1);
    assert.deepEqual(await totals(cita), new Map(f.services.map(service => [service, 1])));
    assert.equal((await rows(cita)).length, 4);
    await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1", [cita.id]);
    assert.equal((await consume(f, cita)).aplicado, false);
    assert.equal((await rows(cita)).length, 4);
  });

  await t.test("reintento tras agotamiento y renovación no debita la nueva suscripción", async () => {
    const f = await fixture({ quotas: [1, 0, 0], courtesyQuota: 1 });
    const cita = await appointment(f, [{ service: f.services[0] }]);
    await consume(f, cita);
    const before = await rows(cita);
    assert.equal(before.length, 2);
    assert.equal((await consume(f, cita)).aplicado, false);
    assert.deepEqual(await rows(cita), before);
    const lifecycle = await ensureSubscriptionLifecycle(pool, f.client);
    assert.equal(lifecycle.active, null);
    assert.equal(lifecycle.finalizado_por, "agotamiento");
    const renewed = randomUUID();
    const snapshot = { version: 1, items: [
      ...f.services.map((id_servicio, i) => ({ tipo: "servicio", id_servicio, nombre: `Servicio ${i + 1}`, cantidad: 8 })),
      { tipo: "cortesia", id_cortesia: f.courtesy, nombre: "Cortesía renovada", cantidad: 8 },
    ] };
    await pool.query(`INSERT INTO subscriptions(id_suscripcion,id_cliente,id_plan,estado_suscripcion_codigo,inicio_at,fin_at,id_sucursal_contratada,beneficios_snapshot)
      VALUES($1,$2,$3,'activa',now()-interval '1 minute',now()+interval '30 days',$4,$5::jsonb)`,
    [renewed, f.client, f.plan, f.branch, JSON.stringify(snapshot)]);
    assert.equal((await consume(f, cita)).aplicado, false);
    assert.deepEqual(await rows(cita), before);
    assert.equal((await pool.query("SELECT COUNT(*)::int cantidad FROM subscription_consumptions WHERE id_suscripcion=$1", [renewed])).rows[0].cantidad, 0);
    const state = await summary(f);
    assert.equal(state.plan_activo.id_suscripcion, renewed);
    assert.equal(state.plan_activo.remanentes.totales.servicios_restantes, 24);
    assert.equal(state.plan_activo.remanentes.totales.cortesias_restantes, 8);
  });

  await t.test("ROLLBACK del llamador revierte todos los servicios, cortesía y auditoría del consumo", async () => {
    const f = await fixture();
    const cita = await appointment(f, f.services.map(service => ({ service })));
    await consume(f, cita, { rollback: true });
    assert.deepEqual(await rows(cita), []);
    assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_restantes, 24);
    await consume(f, cita);
    assert.equal((await rows(cita)).length, 4);
  });

  await t.test("error PostgreSQL en el segundo INSERT revierte el primero y permite reintentar el conjunto", async () => {
    const f = await fixture();
    const cita = await appointment(f, f.services.map(service => ({ service })));
    await pool.query(`CREATE FUNCTION reject_second_consumption_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT COUNT(*) FROM subscription_consumptions WHERE id_cita=NEW.id_cita)>1 THEN
          RAISE EXCEPTION 'SYNTHETIC_SECOND_CONSUMPTION_INSERT_REJECTED';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_second_consumption_fixture AFTER INSERT ON subscription_consumptions
        FOR EACH ROW EXECUTE FUNCTION reject_second_consumption_fixture()`);
    try {
      await assert.rejects(consume(f, cita), error => error.code === "P0001"
        && error.message === "SYNTHETIC_SECOND_CONSUMPTION_INSERT_REJECTED");
      assert.deepEqual(await rows(cita), []);
      assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_restantes, 24);
      assert.equal((await summary(f)).plan_activo.remanentes.totales.cortesias_restantes, 8);
    } finally {
      await pool.query("DROP TRIGGER reject_second_consumption_fixture ON subscription_consumptions; DROP FUNCTION reject_second_consumption_fixture()");
    }
    await consume(f, cita);
    assert.deepEqual(await totals(cita), new Map(f.services.map(service => [service, 1])));
    assert.equal((await rows(cita)).length, 4);
    assert.equal((await consume(f, cita)).aplicado, false);
    assert.equal((await rows(cita)).length, 4);
  });

  await t.test("confirmada futura conserva el momento de consumo vigente, sin exigir llegada o finalización", async () => {
    const f = await fixture();
    const cita = await appointment(f, f.services.map(service => ({ service })), { future: true });
    await consume(f, cita);
    assert.deepEqual(await totals(cita), new Map(f.services.map(service => [service, 1])));
    const row = (await pool.query("SELECT * FROM citas WHERE id_cita=$1", [cita.id])).rows[0];
    assert.equal(row.estado_cita_codigo, "confirmada");
    assert.equal(row.llegada_real_at, null);
    assert.equal(row.atencion_iniciada_at, null);
    assert.equal(row.atencion_finalizada_at, null);
  });

  await t.test("sin coincidencia no descuenta otro servicio ni una cortesía", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.extra, covered: false }]);
    const result = await consume(f, cita);
    assert.equal(result.aplicado, false);
    assert.deepEqual(await rows(cita), []);
    assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_restantes, 24);
  });

  await t.test("evidencia explícita sin cobertura conserva un servicio del catálogo cobrado como extra", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.services[0], covered: false }]);
    const before = (await pool.query("SELECT * FROM citas_detalles WHERE id_cita=$1", [cita.id])).rows;
    assert.equal((await consume(f, cita)).aplicado, false);
    assert.deepEqual(await rows(cita), []);
    assert.deepEqual((await pool.query("SELECT * FROM citas_detalles WHERE id_cita=$1", [cita.id])).rows, before);
    assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_restantes, 24);
    assert.equal((await summary(f)).plan_activo.remanentes.totales.cortesias_restantes, 8);
  });

  await t.test("cortesía sin cupo revierte el conjunto y legado sin identificador no se descuenta", async () => {
    const f = await fixture({ courtesyQuota: 1 });
    await consume(f, await appointment(f, [{ service: f.services[0] }]));
    const second = await appointment(f, [{ service: f.services[1] }]);
    await assert.rejects(consume(f, second), error => error.code === "MEMBERSHIP_CONSUMPTION_COURTESY_BALANCE_INSUFFICIENT");
    assert.deepEqual(await rows(second), []);
    const legacy = await fixture({ legacyCourtesy: true });
    const cita = await appointment(legacy, [{ service: legacy.services[0] }]);
    await consume(legacy, cita);
    assert.equal((await rows(cita)).length, 1);
    assert.equal((await rows(cita))[0].item_tipo, "servicio");
  });

  await t.test("titularidad y sucursal no permiten consumir la suscripción de otro contexto", async () => {
    const f = await fixture();
    const foreign = await appointment(f, [{ service: f.services[0] }], { client: f.otherClient });
    try { await consume(f, foreign); } catch (error) { assert.ok(String(error.code).startsWith("MEMBERSHIP_")); }
    assert.deepEqual(await rows(foreign), []);
    const branch = await appointment(f, [{ service: f.services[0] }], { branch: f.otherBranch });
    await assert.rejects(consume(f, branch, { branch: f.otherBranch }), error => error.code === "MEMBERSHIP_CONSUMPTION_BRANCH_MISMATCH");
    assert.deepEqual(await rows(branch), []);
  });

  await t.test("suscripción vencida no descuenta y conserva el cierre por tiempo", async () => {
    const f = await fixture();
    await pool.query("UPDATE subscriptions SET fin_at=now()-interval '1 minute' WHERE id_suscripcion=$1", [f.subscription]);
    const cita = await appointment(f, [{ service: f.services[0] }]);
    assert.equal((await consume(f, cita)).aplicado, false);
    assert.deepEqual(await rows(cita), []);
    const subscription = (await pool.query("SELECT estado_suscripcion_codigo,motivo_fin_codigo FROM subscriptions WHERE id_suscripcion=$1", [f.subscription])).rows[0];
    assert.deepEqual(subscription, { estado_suscripcion_codigo: "vencida", motivo_fin_codigo: "tiempo" });
  });

  await t.test("suscripción aún no iniciada no permite consumos adelantados", async () => {
    const f = await fixture();
    await pool.query("UPDATE subscriptions SET inicio_at=now()+interval '2 days' WHERE id_suscripcion=$1", [f.subscription]);
    const cita = await appointment(f, [{ service: f.services[0] }]);
    assert.equal((await consume(f, cita)).aplicado, false);
    assert.deepEqual(await rows(cita), []);
    assert.equal((await pool.query("SELECT estado_suscripcion_codigo FROM subscriptions WHERE id_suscripcion=$1", [f.subscription])).rows[0].estado_suscripcion_codigo, "activa");
  });

  await t.test("evidencia con cantidad mayor que la línea se rechaza sin descontar", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.services[0] }]);
    await pool.query(`UPDATE app_private.reserva_idempotencia
      SET response_payload=jsonb_set(response_payload,'{membership_consumption,citas,0,servicios,0,cantidad}','2'::jsonb)
      WHERE id_grupo_cita=$1`, [cita.group]);
    await assert.rejects(consume(f, cita), error => error.code === "MEMBERSHIP_CONSUMPTION_SERVICE_NOT_MATCHED");
    assert.deepEqual(await rows(cita), []);
  });

  await t.test("cancelación y no_show conservan el tratamiento operativo vigente sin borrar historial", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.services[0] }]);
    await consume(f, cita);
    const before = await rows(cita);
    await pool.query("UPDATE citas SET estado_cita_codigo='no_show' WHERE id_cita=$1", [cita.id]);
    assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_consumidos, 1);
    assert.deepEqual(await rows(cita), before);
    await pool.query("UPDATE citas SET estado_cita_codigo='cancelada' WHERE id_cita=$1", [cita.id]);
    assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_consumidos, 0);
    assert.deepEqual(await rows(cita), before);
  });

  await t.test("resumen ignora invalidaciones y fuentes legacy sin cambiar los movimientos", async () => {
    const f = await fixture();
    const cita = await appointment(f, [{ service: f.services[0] }]);
    await consume(f, cita);
    await pool.query("UPDATE subscription_consumptions SET invalidado=true,invalidado_motivo='Fixture invalidado' WHERE item_tipo='servicio'");
    const before = await rows(cita);
    assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_consumidos, 0);
    assert.deepEqual(await rows(cita), before);
    await pool.query("UPDATE subscription_consumptions SET invalidado=false,source_kind='legacy' WHERE item_tipo='servicio'");
    assert.equal((await summary(f)).plan_activo.remanentes.totales.servicios_consumidos, 0);
    const state = await ensureSubscriptionLifecycle(pool, f.client);
    assert.equal(state.summary.totales.servicios_restantes, 24);
  });
});
