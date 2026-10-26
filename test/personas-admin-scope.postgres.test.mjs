import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { assertPersonasTargetScope, getPersonasAdminScope, scopePersonasQuery } from "../src/services/personasAdminScope.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = uuid(1), B = uuid(2), ACTOR = uuid(3);

// AM: Solo crea un clúster temporal nuevo en loopback; no acepta conexiones ni credenciales de QA.
test("PostgreSQL aislado: alcance real, multirrol, origen nulo, búsqueda y paginación", {
  skip: process.env.RUN_PERSONAS_SCOPE_PG !== "true",
}, async () => {
  const bin = process.env.MASTERFADE_TEST_PG_BIN;
  assert.ok(bin, "MASTERFADE_TEST_PG_BIN requerido para PostgreSQL aislado");
  const directory = await mkdtemp(path.join(tmpdir(), "masterfade-personas-scope-"));
  const dataDirectory = path.join(directory, "data");
  const run = (name, args) => {
    const r = spawnSync(path.join(bin, process.platform === "win32" ? `${name}.exe` : name), args,
      { encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
  };
  let started = false;
  let client;
  try {
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    run("initdb", ["-D", dataDirectory, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-sync"]);
    run("pg_ctl", ["-D", dataDirectory, "-l", path.join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"]);
    started = true;
    client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres", ssl: false });
    await client.connect();
    await client.query(`
      CREATE TABLE public.personas(id_persona uuid PRIMARY KEY, nombres text, deleted_at timestamptz);
      CREATE TABLE public.usuarios(id_usuario uuid PRIMARY KEY, id_persona uuid, deleted_at timestamptz);
      CREATE TABLE public.empleados(id_empleado uuid PRIMARY KEY, id_persona uuid, id_sucursal uuid, roles_reactivacion jsonb, deleted_at timestamptz);
      CREATE TABLE public.clientes(id_cliente uuid PRIMARY KEY, id_persona uuid, id_usuario uuid, id_sucursal_origen uuid, deleted_at timestamptz);
      CREATE TABLE public.roles(id_rol uuid PRIMARY KEY, nombre text);
      CREATE TABLE public.roles_usuarios(id_usuario uuid, id_rol uuid, id_sucursal uuid, activo boolean);
      CREATE TABLE public.app_protected_users(id_usuario uuid, activo boolean);
    `);
    for (const [n, nombre] of [[100, "admin"], [101, "barbero"], [102, "cliente"], [103, "super_admin"]]) {
      await client.query("INSERT INTO public.roles VALUES ($1, $2)", [uuid(n), nombre]);
    }
    for (const [branch, role, active] of [[A, 100, true], [B, 100, false], [B, 101, true]]) {
      await client.query("INSERT INTO public.roles_usuarios VALUES ($1, $2, $3, $4)", [ACTOR, uuid(role), branch, active]);
    }
    for (const n of [10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 30, 40, 50, 51]) {
      await client.query("INSERT INTO public.personas VALUES ($1, $2, NULL)", [uuid(n), `Persona ${n}`]);
      await client.query("INSERT INTO public.usuarios VALUES ($1, $2, NULL)", [uuid(n + 200), uuid(n)]);
    }
    for (const [n, branch] of [[10, A], [11, B], [12, A], [13, A], [14, A], [15, A], [16, A], [30, A], [50, A]]) {
      const history = n === 16 ? JSON.stringify([{ usuario: uuid(216), rol: "barbero", sucursal: B }]) : null;
      await client.query("INSERT INTO public.empleados VALUES ($1, $2, $3, $4::jsonb, NULL)", [uuid(n + 100), uuid(n), branch, history]);
    }
    for (const [n, branch] of [[20, A], [21, B], [22, null], [30, B]]) {
      await client.query("INSERT INTO public.clientes VALUES ($1, $2, $3, $4, NULL)", [uuid(n + 100), uuid(n), uuid(n + 200), branch]);
    }
    await client.query("INSERT INTO public.clientes VALUES ($1, $2, $3, $4, NULL)", [uuid(151), uuid(51), uuid(250), A]);
    for (const [n, role, branch, active] of [[12, 101, B, true], [14, 103, null, false], [15, 101, B, false], [20, 102, null, true], [40, 100, A, true]]) {
      await client.query("INSERT INTO public.roles_usuarios VALUES ($1, $2, $3, $4)", [uuid(n + 200), uuid(role), branch, active]);
    }
    await client.query("INSERT INTO public.app_protected_users VALUES ($1, TRUE)", [uuid(213)]);
    const scope = await getPersonasAdminScope(client, { roles: ["admin", "barbero"], branch_ids: [A, B], user: { id_usuario: ACTOR } });
    assert.deepEqual(scope.branchIds, [A]);
    const employeeSql = "SELECT e.id_empleado FROM public.empleados e\n  WHERE e.deleted_at IS NULL ORDER BY e.id_empleado";
    const read = async (sql, params, kind, selectedScope = scope) => {
      const query = scopePersonasQuery(sql, params, selectedScope, kind);
      return (await client.query(query.text, query.values)).rows;
    };
    assert.deepEqual(await read(employeeSql, [], "empleado"), [{ id_empleado: uuid(110) }]);
    assert.deepEqual((await read(employeeSql, [], "empleado", { global: false, branchIds: [A, B] })).map((row) => row.id_empleado),
      [10, 11, 12, 15, 16, 30].map((n) => uuid(n + 100)));
    assert.deepEqual(await read(employeeSql, [], "empleado", { global: false, branchIds: [] }), []);
    const clientSql = "SELECT c.id_cliente FROM public.clientes c JOIN public.personas p ON p.id_persona = c.id_persona\n  WHERE c.deleted_at IS NULL";
    assert.deepEqual(await read(clientSql, [], "cliente"), [{ id_cliente: uuid(120) }]);
    const globalClients = await read(clientSql, [], "cliente", { global: true, branchIds: [] });
    assert.ok(globalClients.some((row) => row.id_cliente === uuid(122)));
    const userSql = "SELECT u.id_usuario FROM public.usuarios u\n  WHERE u.deleted_at IS NULL ORDER BY u.id_usuario";
    assert.deepEqual((await read(userSql, [], "usuario")).map((row) => row.id_usuario), [210, 220, 240].map(uuid));
    const search = `${clientSql} AND p.nombres ILIKE $1 ORDER BY c.id_cliente LIMIT $2 OFFSET $3`;
    assert.deepEqual(await read(search, ["%Persona%", 1, 1], "cliente"), []);
    const count = `SELECT COUNT(*)::int AS total FROM (${clientSql} AND p.nombres ILIKE $1) found`;
    assert.deepEqual(await read(count, ["%Persona%"], "cliente"), [{ total: 1 }]);
    await assertPersonasTargetScope(client, scope, "empleado", uuid(110));
    for (const [kind, id] of [["empleado", uuid(111)], ["empleado", uuid(112)], ["cliente", uuid(122)]]) {
      await assert.rejects(assertPersonasTargetScope(client, scope, kind, id), { statusCode: 403, code: "AUTH_FORBIDDEN_BRANCH" });
    }
    await client.query("BEGIN");
    const lockedScope = await getPersonasAdminScope(client, { roles: ["admin"], user: { id_usuario: ACTOR } }, { lock: true });
    await assertPersonasTargetScope(client, lockedScope, "empleado", uuid(110), { lock: true });
    await client.query("ROLLBACK");
  } finally {
    await client?.end();
    if (started) run("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("masterfade-personas-scope-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
