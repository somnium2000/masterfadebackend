// AM | Actual routine bodies + official Advisor predicates, loopback PostgreSQL only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { startPostgres17 } from "./helpers/postgres17.mjs";

const fixtureRoot = new URL("./fixtures/security-supabase-02/", import.meta.url);
const routines = JSON.parse(await readFile(new URL("routines.json", fixtureRoot), "utf8"));
const manualRoot = new URL("../db/manual/", import.meta.url);
const base = "20261113235412_seguridad_supabase_02_routine_hardening";
const migration = await readFile(new URL(`${base}.sql`, manualRoot), "utf8");
const rollback = await readFile(new URL(`${base}.rollback.sql`, manualRoot), "utf8");
const preflight = await readFile(new URL(`${base}.preflight.sql`, manualRoot), "utf8");
const fixture = await readFile(new URL("./sql/security-supabase-02-fixture.sql", import.meta.url), "utf8");
const advisor = await readFile(new URL("./sql/security-supabase-02-advisor.sql", import.meta.url), "utf8");
const rlsCases = await readFile(new URL("./sql/security-supabase-02-rls-cases.sql", import.meta.url), "utf8");
const signatures = routines.map((r) => `${r.schema}.${r.name}(${r.args})`);
const names = new Set(routines.map((r) => r.name));
// AM | Match opt-in SQL suites: ordinary npm test does not require PostgreSQL.
const runPostgres = Boolean(process.env.MASTERFADE_TEST_PG_BIN);

async function catalog(client) {
  return (await client.query(`
    SELECT p.oid::regprocedure::text AS signature, md5(p.prosrc) AS body,
      p.proowner, p.prosecdef, p.prokind, p.prorettype, p.proargtypes::text,
      p.proargnames, p.proargmodes, p.proargdefaults::text, p.provolatile,
      p.proisstrict, p.proleakproof, p.proparallel, p.procost, p.prorows,
      p.proconfig,
      (SELECT jsonb_agg(jsonb_build_array(a.grantee, a.grantor, a.is_grantable)
                       ORDER BY a.grantee, a.grantor, a.is_grantable)
       FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a) AS acl,
      (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.oid)
       FROM pg_trigger t WHERE t.tgfoid = p.oid) AS triggers
    FROM pg_proc p WHERE p.oid = ANY(ARRAY(
      SELECT to_regprocedure(s)::oid FROM unnest($1::text[]) s))
    ORDER BY p.oid`, [signatures])).rows;
}

async function advisorRows(client) {
  const result = await client.query(advisor);
  return Array.isArray(result) ? result.flatMap((r) => r.rows) : result.rows;
}

async function findings(client) {
  const rows = (await advisorRows(client))
    .filter((r) => r.metadata?.schema === "public" && names.has(r.metadata?.name));
  return Object.fromEntries([
    "function_search_path_mutable", "anon_security_definer_function_executable",
    "authenticated_security_definer_function_executable",
  ].map((name) => [name, rows.filter((r) => r.name === name).length]));
}

async function aborts(client, sql, pattern) {
  try {
    await assert.rejects(client.query(sql), (error) => {
      assert.match(error.message, pattern,
        `unexpected SQL error: ${JSON.stringify({ message: error.message, position: error.position,
          internalPosition: error.internalPosition, internalQuery: error.internalQuery, where: error.where })}`);
      return true;
    });
  } finally {
    await client.query("ROLLBACK");
  }
}

for (const environment of ["qa", "production"]) {
  test(`SECURITY02 ${environment}: preflight, real bodies, permissions/RLS/triggers, Advisor, rollback`, { skip: !runPostgres }, async (t) => {
    const postgres = await startPostgres17();
    t.after(() => postgres.stop());
    const { client } = postgres;
    await client.query(fixture);
    const ordered = [...routines].sort((a, b) => {
      const priority = (r) => r.name === 'fn_has_role' ? 0 : r.name === 'fn_is_super_admin' ? 1 : 2;
      return priority(a) - priority(b);
    });
    for (const r of ordered) {
      await client.query(environment === "qa" && r.qa_definition_override ? r.qa_definition_override : r.definition);
    }
    await client.query(`
      CREATE TRIGGER tr_hold_unico BEFORE INSERT ON public.citas_holds
        FOR EACH ROW EXECUTE FUNCTION public.fn_hold_defaults_y_unico();
      CREATE TRIGGER tr_zz_citas_detalles_line_identity BEFORE INSERT OR UPDATE ON public.citas_detalles
        FOR EACH ROW EXECUTE FUNCTION public.fn_citas_detalles_line_identity_v2();
      REVOKE EXECUTE ON FUNCTION public.fn_is_super_admin(uuid), public.fn_es_admin_de_sucursal(uuid,uuid) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.fn_is_super_admin(uuid), public.fn_es_admin_de_sucursal(uuid,uuid) TO authenticated, service_role;
      REVOKE EXECUTE ON FUNCTION public.fn_has_role(uuid,text) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.fn_has_role(uuid,text) TO service_role;
      CREATE ROLE security02_admin NOLOGIN;
      GRANT EXECUTE ON FUNCTION public.fn_hold_defaults_y_unico() TO security02_admin WITH GRANT OPTION;
      ALTER FUNCTION public.fn_set_updated_at() SET statement_timeout = '15s';
    `);
    const initial = await catalog(client);
    assert.equal(initial.length, 41);
    const inspected = (await client.query(preflight)).rows;
    assert.equal(inspected.length, 41);
    assert.ok(inspected.every((r) => r.definition_status === 'KNOWN_DEFINITION'));
    assert.deepEqual(await findings(client), {
      function_search_path_mutable: environment === "qa" ? 31 : 36,
      anon_security_definer_function_executable: 2,
      authenticated_security_definer_function_executable: 4,
    });
    // AM | Existing RLS and trigger behavior must already pass before hardening.
    await client.query(rlsCases);

    await client.query("GRANT CREATE ON SCHEMA public TO authenticated");
    await aborts(client, migration, /public allows client CREATE/);
    await client.query("REVOKE CREATE ON SCHEMA public FROM authenticated");
    assert.deepEqual(await catalog(client), initial, "failed preflight changes no routines");
    assert.equal((await client.query("SELECT to_regclass('app_private.security02_routine_backup') AS backup")).rows[0].backup, null);

    const oldDefinition = (await client.query("SELECT pg_get_functiondef('public.fn_set_updated_at()'::regprocedure) AS def")).rows[0].def;
    await client.query(oldDefinition.replace(/RETURN NEW;/i, "RETURN OLD;"));
    await aborts(client, migration, /signature\/owner\/body\/security drift/);
    await client.query(oldDefinition);
    assert.deepEqual(await catalog(client), initial);
    await client.query("ALTER FUNCTION public.fn_set_updated_at() SET search_path = public");
    await aborts(client, migration, /unknown existing search_path/);
    await client.query(oldDefinition);
    assert.deepEqual(await catalog(client), initial);

    await client.query(`CREATE ROLE security02_inherited NOLOGIN;
      GRANT security02_inherited TO authenticated;
      GRANT EXECUTE ON FUNCTION public.fn_hold_defaults_y_unico() TO security02_inherited;`);
    await aborts(client, migration, /inherited client trigger privilege/);
    await client.query(`REVOKE security02_inherited FROM authenticated;
      REVOKE EXECUTE ON FUNCTION public.fn_hold_defaults_y_unico() FROM security02_inherited;`);
    assert.deepEqual(await catalog(client), initial, "inherited permission failure rolls all ALTERs back");

    await client.query(migration);
    const applied = await catalog(client);
    for (let i = 0; i < initial.length; i += 1) {
      const { proconfig: oldConfig, acl: oldAcl, ...oldContract } = initial[i];
      const { proconfig: newConfig, acl: newAcl, ...newContract } = applied[i];
      assert.deepEqual(newContract, oldContract, `${initial[i].signature}: no body/owner/contract/trigger changes`);
      const securityDependency = routines.find((r) =>
        `${r.name}(${r.args})`.replace(/\s/g, '') === initial[i].signature.replace(/^public\./, '').replace(/\s/g, ''));
      if (securityDependency?.production_warning && oldConfig?.some((v) => v.startsWith("search_path="))) {
        assert.deepEqual(newConfig, oldConfig);
      }
      assert.deepEqual(newConfig?.filter((v) => !v.startsWith("search_path=")) ?? [],
        oldConfig?.filter((v) => !v.startsWith("search_path=")) ?? []);
      if (!initial[i].prosecdef || initial[i].signature.startsWith('fn_has_role(')) {
        assert.deepEqual(newAcl, oldAcl, "unrelated ACL untouched");
      }
    }
    const backup = (await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE path_changed)::int AS changed,
      bool_and(original_definition IS NOT NULL AND dependencies IS NOT NULL) AS backed_up
      FROM app_private.security02_routine_backup`)).rows[0];
    assert.deepEqual(backup, { total: 41, changed: environment === "qa" ? 36 : 41, backed_up: true });
    await client.query(migration);
    assert.deepEqual(await catalog(client), applied, "idempotent apply");
    const concurrent = new pg.Client(postgres.connectionOptions);
    await concurrent.connect();
    try {
      await Promise.all([client.query(migration), concurrent.query(migration)]);
    } finally {
      await concurrent.end();
    }
    assert.deepEqual(await catalog(client), applied, "concurrent applications serialize without permission drift");
    assert.deepEqual(await findings(client), {
      function_search_path_mutable: 0,
      anon_security_definer_function_executable: 0,
      authenticated_security_definer_function_executable: 2,
    });
    const backupInfo = (await advisorRows(client)).filter((r) => r.name === 'rls_enabled_no_policy'
      && r.metadata?.schema === 'app_private' && r.metadata?.name === 'security02_routine_backup');
    assert.equal(backupInfo.length, 1, 'private default-deny backup has one justified INFO, no client policy');
    await client.query("SELECT set_config('qa_security02.expect_hardened','true',false)");
    await client.query(rlsCases);

    const access = (await client.query(`SELECT
      has_function_privilege('anon','public.fn_hold_defaults_y_unico()','EXECUTE') AS anon_trigger,
      has_function_privilege('authenticated','public.fn_citas_detalles_line_identity_v2()','EXECUTE') AS auth_trigger,
      has_function_privilege('service_role','public.fn_hold_defaults_y_unico()','EXECUTE') AS server_trigger,
      has_function_privilege('security02_admin','public.fn_hold_defaults_y_unico()','EXECUTE WITH GRANT OPTION') AS admin_option,
      has_function_privilege('anon','public.fn_is_super_admin(uuid)','EXECUTE') AS anon_rls,
      has_function_privilege('authenticated','public.fn_is_super_admin(uuid)','EXECUTE') AS auth_rls,
      has_table_privilege('authenticated','app_private.security02_routine_backup','SELECT') AS backup_exposed`
    )).rows[0];
    assert.deepEqual(access, { anon_trigger: false, auth_trigger: false, server_trigger: true,
      admin_option: true, anon_rls: false, auth_rls: true, backup_exposed: false });

    // AM | Refuse a rollback that would erase another deployment's metadata.
    await client.query("ALTER FUNCTION public.fn_set_updated_at() SET statement_timeout = '16s'");
    await aborts(client, rollback, /definition\/config drift/);
    await client.query("ALTER FUNCTION public.fn_set_updated_at() SET statement_timeout = '15s'");
    assert.deepEqual(await catalog(client), applied);
    await client.query(rollback);
    assert.deepEqual(await catalog(client), initial, "rollback restores effective grants/options and configuration");
    await client.query(rollback);
    assert.deepEqual(await catalog(client), initial, "idempotent rollback");
    await client.query("SELECT set_config('qa_security02.expect_hardened','false',false)");
    await client.query(rlsCases);
    await client.query("ALTER FUNCTION public.fn_set_updated_at() SET statement_timeout = '16s'");
    await aborts(client, migration, /post-rollback drift/);
    await client.query("ALTER FUNCTION public.fn_set_updated_at() SET statement_timeout = '15s'");
    await client.query(migration);
    assert.deepEqual(await catalog(client), applied, "reapply after rollback");
    t.diagnostic(`${environment}: search_path ${environment === "qa" ? 31 : 36}→0; anon 2→0; authenticated 4→2 (RLS exceptions)`);
  });
}
