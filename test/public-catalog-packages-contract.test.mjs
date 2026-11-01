import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/public/catalog.js";

// AM: Dobles de filas y comprobaciones SQL; no ejecutan PostgreSQL ni conectan una BD.
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const P = "11111111-1111-4111-8111-111111111111";
const S1 = "21111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const BARBER = "31111111-1111-4111-8111-111111111111";
const OTHER_BARBER = "32222222-2222-4222-8222-222222222222";
const TODAY = "2026-01-15";
const clean = (sql) => String(sql).replace(/--[^\r\n]*/g, "").replace(/\s+/g, " ").trim();

function tariff(serviceId, branchId = A, overrides = {}) {
  return {
    id_servicio: serviceId, id_sucursal: branchId, id_empleado: null,
    id_tarifa: "41111111-1111-4111-8111-111111111111", precio_hnl: 100,
    activo: true, deleted_at: null, vigente_desde: "2026-01-01", vigente_hasta: null,
    updated_at: "2026-01-01T12:00:00Z", servicio_informativo: false, ...overrides,
  };
}

function offer(branchId = A, overrides = {}) {
  return {
    id_sucursal: branchId, precio_hnl: 1200, orden_visual: 10,
    activo: true, visible_publico: true, branchActive: true, branchDeleted: false,
    updated_at: "2026-01-01T12:00:00Z", id_paquete_sucursal: branchId, ...overrides,
  };
}

function fixture() {
  return {
    pkg: { id_paquete: P, nombre_paquete: "Paquete Corte", descripcion: "Dos servicios", activo: true, deleted_at: null },
    offers: [offer()],
    services: [S1, S2].map((id, index) => ({
      id_servicio: id, nombre_servicio: `Servicio ${index + 1}`,
      activo: true, agendable: true, visible_publico: true, deleted_at: null,
    })),
    items: [{ id_servicio: S1, cantidad: 2 }, { id_servicio: S2, cantidad: 3 }],
    tariffs: [tariff(S1), tariff(S2)],
  };
}

function compareTariffs(left, right) {
  return right.vigente_desde.localeCompare(left.vigente_desde)
    || right.updated_at.localeCompare(left.updated_at)
    || right.id_tarifa.localeCompare(left.id_tarifa);
}

// AM: Modelo limitado de las clausulas relevantes, incluyendo la forma defectuosa anterior.
// Las aserciones independientes de estructura impiden confundir este modelo con un motor SQL.
function simulatePackageRows(sql, params, data, selectedOffers) {
  const search = sql.includes("LIMIT 50");
  const [branchId] = params;
  const barberId = search ? params[2] : params[1];
  const candidates = data.offers.filter((row) => row.activo && row.visible_publico
    && row.precio_hnl > 0 && row.branchActive && !row.branchDeleted
    && (!branchId || row.id_sucursal === branchId));
  const latestByBranch = new Map();
  candidates.sort((left, right) => right.updated_at.localeCompare(left.updated_at)
    || right.id_paquete_sucursal.localeCompare(left.id_paquete_sucursal));
  for (const candidate of candidates) {
    if (!latestByBranch.has(candidate.id_sucursal)) latestByBranch.set(candidate.id_sucursal, candidate);
  }
  const picked = [...latestByBranch.values()];
  if (!picked.length) return [];

  let selected;
  if (sql.includes("MIN(po.precio_hnl)")) {
    selected = {
      id_sucursal: picked.map((row) => row.id_sucursal).sort()[0],
      precio_hnl: Math.min(...picked.map((row) => row.precio_hnl)),
      orden_visual: Math.min(...picked.map((row) => row.orden_visual)),
    };
  } else {
    selected = picked.sort((left, right) => left.precio_hnl - right.precio_hnl
      || left.orden_visual - right.orden_visual || left.id_sucursal.localeCompare(right.id_sucursal))[0];
  }
  selectedOffers.push({ ...selected });
  if (!data.pkg.activo || data.pkg.deleted_at || data.items.length < 2) return [];
  if (search) {
    const term = params[1].slice(1, -1);
    if (![data.pkg.nombre_paquete, data.pkg.descripcion || ""].some((value) => value.toLowerCase().includes(term))) return [];
  }
  const items = [];
  for (const item of data.items) {
    const service = data.services.find((row) => row.id_servicio === item.id_servicio);
    if (!service || service.deleted_at || !service.activo || !service.agendable || !service.visible_publico) return [];
    const eligible = data.tariffs.filter((row) => row.id_servicio === item.id_servicio
      && row.id_sucursal === selected.id_sucursal && !row.deleted_at && row.activo
      && row.vigente_desde <= TODAY && (!row.vigente_hasta || row.vigente_hasta >= TODAY)
      && row.precio_hnl > 0 && (barberId ? !row.id_empleado || row.id_empleado === barberId : !row.id_empleado));
    const effective = eligible.sort(compareTariffs)[0];
    if (!effective) return [];
    if (sql.includes("effective_tariff") && effective.servicio_informativo === true) return [];
    items.push({ id_servicio: item.id_servicio, nombre_servicio: service.nombre_servicio, cantidad: item.cantidad });
  }
  return [{ ...data.pkg, precio_hnl: selected.precio_hnl, orden_visual: selected.orden_visual, items }];
}

async function buildApp(t, data = fixture()) {
  const state = { calls: [], selectedOffers: [] };
  const app = Fastify();
  app.decorate("db", {
    query: async (sql, params = []) => {
      const text = clean(sql);
      assert.match(text, /^WITH /);
      assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|COMMIT|ROLLBACK)\b/i);
      state.calls.push({ sql: text, params });
      const rows = text.includes("FROM public.paquetes p")
        ? simulatePackageRows(text, params, data, state.selectedOffers) : [];
      return { rows, rowCount: rows.length };
    },
  });
  await app.register(routes, { prefix: "/v1/public/catalog" });
  await app.ready();
  t.after(() => app.close());
  return { app, state };
}

const endpoints = [
  { name: "paquetes", path: "/v1/public/catalog/paquetes", search: false },
  { name: "busqueda", path: "/v1/public/catalog/busqueda", search: true },
];
function requestUrl(endpoint, branchId = A, barberId = null, query = "corte") {
  const params = new URLSearchParams();
  if (endpoint.search) params.set("q", query);
  if (branchId) params.set("id_sucursal", branchId);
  if (barberId) params.set("id_barbero", barberId);
  return `${endpoint.path}?${params}`;
}
async function packages(app, endpoint, branchId = A, barberId = null) {
  const response = await app.inject(requestUrl(endpoint, branchId, barberId));
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  return response.json().data.paquetes;
}

for (const endpoint of endpoints) {
  test(`${endpoint.name}: tarifa informativa efectiva excluye paquete (reproduccion A)`, async (t) => {
    const data = fixture();
    data.tariffs[1].servicio_informativo = true;
    const { app } = await buildApp(t, data);
    assert.deepEqual(await packages(app, endpoint), []);
  });

  test(`${endpoint.name}: precio, sucursal y orden proceden de la oferta B (reproduccion B)`, async (t) => {
    const data = fixture();
    data.offers.push(offer(B, { precio_hnl: 900, orden_visual: 20 }));
    data.tariffs.push(tariff(S1, B), tariff(S2, B));
    const { app, state } = await buildApp(t, data);
    const result = await packages(app, endpoint, null);
    assert.equal(result[0].precio_hnl, 900);
    assert.equal(result[0].orden_visual, 20);
    assert.equal(state.selectedOffers[0].id_sucursal, B);
  });

  test(`${endpoint.name}: SQL conserva ranking completo, parametros y tarifa efectiva`, async (t) => {
    const { app, state } = await buildApp(t);
    await packages(app, endpoint);
    const call = state.calls.find(({ sql }) => sql.includes("FROM public.paquetes p"));
    assert.match(call.sql, /PARTITION BY po.id_paquete ORDER BY po.precio_hnl ASC, po.orden_visual ASC, po.id_sucursal::text ASC/);
    assert.doesNotMatch(call.sql, /(?:MIN|MAX)\(po\./);
    assert.match(call.sql, /ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC LIMIT 1 \) effective_tariff WHERE COALESCE\(effective_tariff.servicio_informativo, FALSE\) IS FALSE/);
    for (const clause of [
      "ps.activo IS TRUE", "ps.visible_publico IS TRUE", "ps.precio_hnl > 0",
      "su.deleted_at IS NULL", "su.estado IS TRUE", "($1::uuid IS NULL OR ps.id_sucursal = $1::uuid)",
      "p.deleted_at IS NULL", "p.activo IS TRUE", "COUNT(pd.id_servicio) >= 2",
      "COUNT(s.id_servicio) = COUNT(pd.id_servicio)", "s.deleted_at IS NULL",
      "s.activo IS TRUE", "s.agendable IS TRUE", "s.visible_publico IS TRUE",
      "st.id_servicio = pd.id_servicio", "st.id_sucursal = eo.id_sucursal",
      "st.deleted_at IS NULL", "st.activo IS TRUE", "st.precio_hnl > 0",
      "st.vigente_desde <= (NOW() AT TIME ZONE 'America/Tegucigalpa')::date",
      "st.vigente_hasta >= (NOW() AT TIME ZONE 'America/Tegucigalpa')::date",
      "'cantidad', pd.cantidad",
    ]) assert.ok(call.sql.includes(clause), `Clausula conservada: ${clause}`);
    assert.deepEqual(call.params, endpoint.search ? [A, "%corte%", null] : [A, null]);
    if (endpoint.search) assert.match(call.sql, /LOWER\(p.nombre_paquete\) LIKE \$2::text/);
  });

  const invalidCases = [
    ["servicio no agendable", (data) => { data.services[1].agendable = false; }],
    ["servicio inactivo", (data) => { data.services[1].activo = false; }],
    ["servicio oculto", (data) => { data.services[1].visible_publico = false; }],
    ["servicio eliminado", (data) => { data.services[1].deleted_at = TODAY; }],
    ["servicio inexistente", (data) => { data.services.pop(); }],
    ["tarifa vencida", (data) => { data.tariffs[1].vigente_hasta = "2026-01-14"; }],
    ["tarifa futura", (data) => { data.tariffs[1].vigente_desde = "2026-01-16"; }],
    ["tarifa inactiva", (data) => { data.tariffs[1].activo = false; }],
    ["tarifa eliminada", (data) => { data.tariffs[1].deleted_at = TODAY; }],
    ["tarifa sin precio positivo", (data) => { data.tariffs[1].precio_hnl = 0; }],
    ["tarifa de otra sucursal", (data) => { data.tariffs[1].id_sucursal = B; }],
    ["oferta inactiva", (data) => { data.offers[0].activo = false; }],
    ["oferta oculta", (data) => { data.offers[0].visible_publico = false; }],
    ["sucursal inactiva", (data) => { data.offers[0].branchActive = false; }],
    ["sucursal eliminada", (data) => { data.offers[0].branchDeleted = true; }],
    ["paquete inactivo", (data) => { data.pkg.activo = false; }],
    ["composicion de un servicio", (data) => { data.items.pop(); }],
  ];
  for (const [name, change] of invalidCases) {
    test(`${endpoint.name}: excluye ${name}`, async (t) => {
      const data = fixture();
      change(data);
      const { app } = await buildApp(t, data);
      assert.deepEqual(await packages(app, endpoint), []);
    });
  }

  test(`${endpoint.name}: conserva JSON, cantidades y precio local sin escrituras`, async (t) => {
    const data = fixture();
    const before = JSON.stringify(data);
    const { app, state } = await buildApp(t, data);
    assert.deepEqual(await packages(app, endpoint), [{
      id_paquete: P, nombre_paquete: "Paquete Corte", descripcion: "Dos servicios",
      precio_hnl: 1200, orden_visual: 10,
      items: [
        { id_servicio: S1, nombre_servicio: "Servicio 1", cantidad: 2 },
        { id_servicio: S2, nombre_servicio: "Servicio 2", cantidad: 3 },
      ],
    }]);
    assert.equal(JSON.stringify(data), before);
    assert.equal(state.calls.length, endpoint.search ? 3 : 1);
  });

  test(`${endpoint.name}: tres ofertas seleccionan la de menor precio completo`, async (t) => {
    const data = fixture();
    data.offers.push(offer(B, { precio_hnl: 900, orden_visual: 20 }), offer(C, { precio_hnl: 800, orden_visual: 30 }));
    data.tariffs.push(tariff(S1, C), tariff(S2, C));
    const { app, state } = await buildApp(t, data);
    assert.equal((await packages(app, endpoint, null))[0].precio_hnl, 800);
    assert.equal(state.selectedOffers[0].id_sucursal, C);
    assert.equal(state.selectedOffers[0].orden_visual, 30);
  });

  test(`${endpoint.name}: empate de precios usa orden y despues UUID`, async (t) => {
    const data = fixture();
    data.offers = [offer(C, { precio_hnl: 900, orden_visual: 5 }), offer(A, { precio_hnl: 900, orden_visual: 10 }), offer(B, { precio_hnl: 900, orden_visual: 5 })];
    data.tariffs.push(tariff(S1, B), tariff(S2, B));
    const { app, state } = await buildApp(t, data);
    assert.equal((await packages(app, endpoint, null))[0].orden_visual, 5);
    assert.equal(state.selectedOffers[0].id_sucursal, B);
  });

  test(`${endpoint.name}: consulta local A no utiliza el menor precio de B`, async (t) => {
    const data = fixture();
    data.offers.push(offer(B, { precio_hnl: 900, orden_visual: 20 }));
    const { app, state } = await buildApp(t, data);
    const result = await packages(app, endpoint, A);
    assert.equal(result[0].precio_hnl, 1200);
    assert.equal(result[0].orden_visual, 10);
    assert.equal(state.selectedOffers[0].id_sucursal, A);
  });

  for (const unavailable of ["activo", "visible_publico", "branchActive"]) {
    test(`${endpoint.name}: ignora oferta barata con ${unavailable}=false`, async (t) => {
      const data = fixture();
      data.offers.push(offer(B, { precio_hnl: 900, [unavailable]: false }));
      const { app, state } = await buildApp(t, data);
      assert.equal((await packages(app, endpoint, null))[0].precio_hnl, 1200);
      assert.equal(state.selectedOffers[0].id_sucursal, A);
    });
  }

  test(`${endpoint.name}: oferta barata B incompatible no se valida con tarifas de A`, async (t) => {
    const data = fixture();
    data.offers.push(offer(B, { precio_hnl: 900, orden_visual: 20 }));
    const { app } = await buildApp(t, data);
    assert.deepEqual(await packages(app, endpoint, null), []);
    assert.equal((await packages(app, endpoint, A)).length, 1);
  });

  test(`${endpoint.name}: tarifa posterior informativa prevalece sobre historica operativa`, async (t) => {
    const data = fixture();
    data.tariffs.push(tariff(S2, A, { vigente_desde: TODAY, servicio_informativo: true }));
    const { app } = await buildApp(t, data);
    assert.deepEqual(await packages(app, endpoint), []);
  });

  test(`${endpoint.name}: tarifa posterior operativa prevalece sobre historica informativa`, async (t) => {
    const data = fixture();
    data.tariffs[1].servicio_informativo = true;
    data.tariffs.push(tariff(S2, A, { vigente_desde: TODAY, servicio_informativo: false }));
    const { app } = await buildApp(t, data);
    assert.equal((await packages(app, endpoint)).length, 1);
  });

  test(`${endpoint.name}: tarifa futura informativa no desplaza la tarifa vigente`, async (t) => {
    const data = fixture();
    data.tariffs.push(tariff(S2, A, { vigente_desde: "2026-01-16", servicio_informativo: true }));
    const { app } = await buildApp(t, data);
    assert.equal((await packages(app, endpoint)).length, 1);
  });

  test(`${endpoint.name}: servicio_informativo null conserva compatibilidad`, async (t) => {
    const data = fixture();
    data.tariffs[1].servicio_informativo = null;
    const { app } = await buildApp(t, data);
    assert.equal((await packages(app, endpoint)).length, 1);
  });

  test(`${endpoint.name}: tres servicios validos conservan sus cantidades`, async (t) => {
    const data = fixture();
    data.services.push({ ...data.services[0], id_servicio: C, nombre_servicio: "Servicio 3" });
    data.items.push({ id_servicio: C, cantidad: 4 });
    data.tariffs.push(tariff(C));
    const { app } = await buildApp(t, data);
    assert.deepEqual((await packages(app, endpoint))[0].items.map((item) => item.cantidad), [2, 3, 4]);
  });
}

test("paquetes: id_barbero selecciona tarifa efectiva del contexto sin afectar otros barberos", async (t) => {
  const data = fixture();
  data.tariffs.push(tariff(S2, A, { id_empleado: BARBER, vigente_desde: TODAY, servicio_informativo: true }));
  const { app, state } = await buildApp(t, data);
  assert.deepEqual(await packages(app, endpoints[0], A, BARBER), []);
  assert.equal((await packages(app, endpoints[0], A, OTHER_BARBER)).length, 1);
  assert.equal((await packages(app, endpoints[0], A)).length, 1);
  const sql = state.calls[0].sql;
  assert.match(sql, /\$2::uuid IS NULL AND st.id_empleado IS NULL/);
  assert.match(sql, /st.id_empleado IS NULL OR st.id_empleado = \$2::uuid/);
  assert.deepEqual(state.calls[0].params, [A, BARBER]);
});

test("paquetes: desempate de tarifas usa updated_at e id_tarifa como Servicios", async (t) => {
  const data = fixture();
  data.tariffs.push(tariff(S2, A, {
    id_tarifa: "42222222-2222-4222-8222-222222222222", servicio_informativo: true,
  }));
  const { app } = await buildApp(t, data);
  assert.deepEqual(await packages(app, endpoints[0]), []);
});

test("paquetes: fecha de actualizacion posterior prevalece con igual vigente_desde", async (t) => {
  const data = fixture();
  data.tariffs.push(tariff(S2, A, { updated_at: "2026-01-02T12:00:00Z", servicio_informativo: true }));
  const { app } = await buildApp(t, data);
  assert.deepEqual(await packages(app, endpoints[0]), []);
});

test("paquetes: contexto barbero conserva el orden efectivo de Servicios, sin prioridad artificial", async (t) => {
  const data = fixture();
  data.tariffs[1].vigente_desde = TODAY;
  data.tariffs[1].servicio_informativo = true;
  data.tariffs.push(tariff(S2, A, { id_empleado: BARBER }));
  const { app } = await buildApp(t, data);
  assert.deepEqual(await packages(app, endpoints[0], A, BARBER), []);
});

test("busqueda: conserva texto normalizado, limite y estructura; id_barbero no es parte del contrato", async (t) => {
  const { app, state } = await buildApp(t);
  const response = await app.inject(requestUrl(endpoints[1], A, null, "  CoRTe  "));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json().data).sort(), ["paquetes", "planes", "servicios"]);
  const call = state.calls.find(({ sql }) => sql.includes("FROM public.paquetes p"));
  assert.deepEqual(call.params, [A, "%corte%", null]);
  assert.match(call.sql, /LIMIT 50$/);
  assert.match(call.sql, /st.id_empleado = \$3::uuid/);
});

test("busqueda: texto sin coincidencia no devuelve paquetes", async (t) => {
  const { app } = await buildApp(t);
  const response = await app.inject(requestUrl(endpoints[1], A, null, "inexistente"));
  assert.deepEqual(response.json().data.paquetes, []);
});

const BUSINESS_BOUNDARY_NOW = "2026-10-30T02:00:00Z";
const UTC_SESSION_DATE = "2026-10-30";
const TEGUCIGALPA_DATE = "2026-10-29";

function sqlEffectiveDate(sql) {
  // Simula la semantica de PostgreSQL en una sesion UTC para el instante fijo.
  // CURRENT_DATE usa la fecha de sesion; AT TIME ZONE usa la fecha empresarial.
  return sql.includes("AT TIME ZONE 'America/Tegucigalpa'") ? TEGUCIGALPA_DATE : UTC_SESSION_DATE;
}

function boundaryTariffEligible(sql, { vigente_desde, vigente_hasta = null }) {
  const businessDate = sqlEffectiveDate(sql);
  return vigente_desde <= businessDate && (!vigente_hasta || vigente_hasta >= businessDate);
}

function boundaryService(id, overrides = {}) {
  return {
    id_servicio: id,
    nombre_servicio: `Servicio ${id.slice(0, 4)}`,
    descripcion: null,
    duracion_min: 30,
    buffer_min: 5,
    precio_hnl: 200,
    grupo_catalogo: "barberia",
    activo: true,
    agendable: true,
    servicio_informativo: false,
    orden_visual: 10,
    vigente_desde: TEGUCIGALPA_DATE,
    vigente_hasta: null,
    ...overrides,
  };
}

async function buildBoundaryApp(t, tariffRows) {
  const app = Fastify();
  app.decorate("db", {
    query: async (sql) => {
      const text = clean(sql);
      assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|COMMIT|ROLLBACK)\b/i);
      if (text.includes("FROM public.membership_plans mp")) return { rows: [], rowCount: 0 };
      const eligible = tariffRows.filter((row) => boundaryTariffEligible(text, row));
      if (text.includes("FROM public.paquetes p")) {
        const rows = eligible.length === tariffRows.length ? [{
          id_paquete: P,
          nombre_paquete: "Paquete limite",
          descripcion: null,
          precio_hnl: 500,
          orden_visual: 10,
          items: eligible.map((row) => ({ id_servicio: row.id_servicio, nombre_servicio: row.nombre_servicio, cantidad: 1 })),
        }] : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: eligible, rowCount: eligible.length };
    },
  });
  await app.register(routes, { prefix: "/v1/public/catalog" });
  await app.ready();
  t.after(() => app.close());
  return app;
}

test("vigencias: sesion UTC conserva la fecha empresarial de Tegucigalpa en servicios globales, por sucursal y busqueda", async (t) => {
  assert.equal(new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(BUSINESS_BOUNDARY_NOW)), UTC_SESSION_DATE);
  assert.equal(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date(BUSINESS_BOUNDARY_NOW)), TEGUCIGALPA_DATE);
  const rows = [
    boundaryService("51111111-1111-4111-8111-111111111111", { vigente_desde: "2026-10-30" }),
    boundaryService("52222222-2222-4222-8222-222222222222", { vigente_hasta: "2026-10-29" }),
    boundaryService("53333333-3333-4333-8333-333333333333", { vigente_hasta: "2026-10-28" }),
    boundaryService("54444444-4444-4444-8444-444444444444"),
  ];
  const app = await buildBoundaryApp(t, rows);
  const expected = [rows[1].id_servicio, rows[3].id_servicio];
  for (const url of [
    "/v1/public/catalog/servicios",
    `/v1/public/catalog/servicios?id_sucursal=${A}`,
    `/v1/public/catalog/busqueda?q=servicio&id_sucursal=${A}`,
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.servicios.map((row) => row.id_servicio), expected);
  }
});

for (const [name, dates, visible] of [
  ["inicio hoy", { vigente_desde: "2026-10-29" }, true],
  ["inicio manana", { vigente_desde: "2026-10-30" }, false],
  ["finaliza hoy", { vigente_desde: "2026-10-01", vigente_hasta: "2026-10-29" }, true],
  ["finalizo ayer", { vigente_desde: "2026-10-01", vigente_hasta: "2026-10-28" }, false],
  ["sin fecha final", { vigente_desde: "2026-10-01", vigente_hasta: null }, true],
]) {
  test(`vigencias: paquete ${name} coincide entre listado y busqueda`, async (t) => {
    const row = boundaryService("55555555-5555-4555-8555-555555555555", dates);
    const app = await buildBoundaryApp(t, [row]);
    for (const url of [
      `/v1/public/catalog/paquetes?id_sucursal=${A}`,
      `/v1/public/catalog/busqueda?q=paquete&id_sucursal=${A}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.paquetes.length > 0, visible);
    }
  });
}
