import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/public/catalog.js";

const BRANCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_BRANCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function service(overrides = {}) {
  return {
    id_servicio: "11111111-1111-4111-8111-111111111111",
    nombre_servicio: "Servicio sintético",
    descripcion: null,
    duracion_min: 30,
    buffer_min: 5,
    grupo_catalogo: "barberia",
    activo: true,
    visible_publico: true,
    agendable: true,
    servicio_informativo: false,
    orden_visual: 10,
    precio_hnl: 250,
    id_sucursal: BRANCH,
    tarifa_activa: true,
    tarifa_vigente: true,
    sucursal_habilitada: true,
    ...overrides,
  };
}

function publishedByServiceQuery(sql, row) {
  const supportsInformativeZero = /JOIN public\.servicios tariff_service[\s\S]*tariff_service\.id_servicio = st\.id_servicio/.test(sql)
    && /ss\.precio_hnl = 0[\s\S]*ss\.servicio_informativo/.test(sql);
  const validPrice = row.precio_hnl > 0
    || (supportsInformativeZero && row.precio_hnl === 0 && (row.servicio_informativo === true || row.agendable === false));
  return row.activo && row.visible_publico && row.tarifa_activa && row.tarifa_vigente
    && row.sucursal_habilitada && validPrice;
}

async function buildApp(t, rows) {
  const calls = [];
  const app = Fastify();
  app.decorate("db", {
    query: async (sql, params = []) => {
      const text = String(sql);
      calls.push(text);
      if (text.includes("FROM public.servicios s") && text.includes("JOIN service_scope")) {
        const branchId = params[0] ?? null;
        const candidates = rows.filter((row) => (!branchId || row.id_sucursal === branchId) && publishedByServiceQuery(text, row));
        const selected = new Map();
        for (const row of candidates.sort((left, right) => left.precio_hnl - right.precio_hnl || left.id_sucursal.localeCompare(right.id_sucursal))) {
          if (!selected.has(row.id_servicio)) selected.set(row.id_servicio, row);
        }
        const published = [...selected.values()];
        return { rows: published, rowCount: published.length };
      }
      return { rows: [], rowCount: 0 };
    },
  });
  await app.register(routes, { prefix: "/v1/public/catalog" });
  await app.ready();
  t.after(() => app.close());
  return { app, calls };
}

for (const endpoint of [
  `/v1/public/catalog/servicios?id_sucursal=${BRANCH}`,
  `/v1/public/catalog/busqueda?q=servicio&id_sucursal=${BRANCH}`,
]) {
  test(`${endpoint}: publica precio cero solo cuando la tarifa es informativa`, async (t) => {
    const rows = [
      service(),
      service({ id_servicio: "21111111-1111-4111-8111-111111111111", servicio_informativo: true }),
      service({ id_servicio: "31111111-1111-4111-8111-111111111111", precio_hnl: 0, servicio_informativo: true }),
      service({ id_servicio: "41111111-1111-4111-8111-111111111111", precio_hnl: 0 }),
      service({ id_servicio: "51111111-1111-4111-8111-111111111111", precio_hnl: 0, agendable: false }),
    ];
    const { app, calls } = await buildApp(t, rows);
    const response = await app.inject(endpoint);
    assert.equal(response.statusCode, 200);
    const published = response.json().data.servicios;
    assert.deepEqual(published.map((row) => row.id_servicio).sort(), [...rows.slice(0, 3), rows[4]].map((row) => row.id_servicio).sort());
    assert.equal(published.find((row) => row.id_servicio === rows[4].id_servicio).servicio_informativo, true);
    const sql = calls.find((call) => call.includes("JOIN service_scope"));
    for (const clause of ["st.activo IS TRUE", "su.estado IS TRUE", "s.activo IS TRUE", "s.visible_publico IS TRUE"]) {
      assert.ok(sql.includes(clause), `Conserva control: ${clause}`);
    }
    assert.match(sql, /JOIN public\.servicios tariff_service\s+ON tariff_service\.id_servicio = st\.id_servicio/);
    assert.match(sql, /st\.precio_hnl > 0[\s\S]*st\.precio_hnl = 0[\s\S]*st\.servicio_informativo[\s\S]*tariff_service\.agendable IS FALSE/);
  });

  for (const [name, override] of [
    ["tarifa inactiva", { tarifa_activa: false }],
    ["tarifa vencida", { tarifa_vigente: false }],
    ["sucursal deshabilitada", { sucursal_habilitada: false }],
    ["servicio inactivo", { activo: false }],
  ]) {
    test(`${endpoint}: no publica informativo con ${name}`, async (t) => {
      const { app } = await buildApp(t, [service({ precio_hnl: 0, servicio_informativo: true, ...override })]);
      const response = await app.inject(endpoint);
      assert.deepEqual(response.json().data.servicios, []);
    });
  }
}

for (const endpoint of [
  "/v1/public/catalog/servicios",
  "/v1/public/catalog/busqueda?q=servicio",
]) {
  test(`${endpoint}: tarifa agendable cero no desplaza oferta positiva de otra sucursal`, async (t) => {
    const serviceId = "61111111-1111-4111-8111-111111111111";
    const rows = [
      service({ id_servicio: serviceId, id_sucursal: BRANCH, precio_hnl: 0 }),
      service({ id_servicio: serviceId, id_sucursal: OTHER_BRANCH, precio_hnl: 275 }),
    ];
    const { app } = await buildApp(t, rows);
    const response = await app.inject(endpoint);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.servicios.length, 1);
    assert.equal(response.json().data.servicios[0].precio_hnl, 275);
  });

  test(`${endpoint}: filtro de sucursal no toma la tarifa válida de otra sucursal`, async (t) => {
    const serviceId = "71111111-1111-4111-8111-111111111111";
    const rows = [
      service({ id_servicio: serviceId, id_sucursal: BRANCH, precio_hnl: 0 }),
      service({ id_servicio: serviceId, id_sucursal: OTHER_BRANCH, precio_hnl: 290 }),
    ];
    const { app } = await buildApp(t, rows);
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await app.inject(`${endpoint}${separator}id_sucursal=${BRANCH}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.servicios, []);
  });
}

test("agendamiento conserva la exclusión explícita de tarifas informativas", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/services/agendaService.js", import.meta.url), "utf8"));
  assert.match(source, /COALESCE\(at\.servicio_informativo, FALSE\) IS FALSE/);
});
