// AM | Actual routine bodies + official Advisor predicates, loopback PostgreSQL only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createHash } from "node:crypto";
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
const expirationCases = await readFile(new URL('./sql/security-supabase-02b-expiration-cases.sql', import.meta.url), 'utf8');
const signatures = routines.map((r) => `${r.schema}.${r.name}(${r.args})`);
const names = new Set(routines.map((r) => r.name));
// AM | Match opt-in SQL suites: ordinary npm test does not require PostgreSQL.
const runPostgres = Boolean(process.env.MASTERFADE_TEST_PG_BIN);
// AM | Read the active versioned definition, never the commented rollback block.
const verifiedVariants = [];
for (const routine of routines) {
  for (const review of routine.verified_variants_02b ?? []) {
    const source = (await readFile(new URL(`../${review.definition_source}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${routine.schema}.${routine.name}(`);
    assert.ok(start >= 0 && (start === 0 || source[start - 1] === '\n'));
    const rest = source.slice(start);
    const marker = rest.match(/\bAS\s+(\$[a-z_0-9]*\$)/i);
    assert.ok(marker);
    const bodyStart = marker.index + marker[0].length;
    const end = rest.indexOf(marker[1], bodyStart);
    assert.ok(end > bodyStart && rest[end + marker[1].length] === ';');
    const body = rest.slice(bodyStart, end);
    assert.equal(createHash('md5').update(body).digest('hex'), review.prosrc_md5_lf);
    verifiedVariants.push({ ...review, routine, body, definition: rest.slice(0, end + marker[1].length + 1),
      signature: `${routine.schema}.${routine.name}(${routine.args})` });
  }
}

test('SECURITY02B: exact reviewed source hashes stay bound to their signatures in both manifests', () => {
  assert.deepEqual(Object.fromEntries(verifiedVariants.map((v) => [v.signature, v.prosrc_md5_lf])), {
    'public.fn_points_materialize_expired_cycles(uuid)': '1fc9e808d8d6d56570897b5c84480144',
    'public.fn_points_tx_guard_acumular_final()': '6ff488db9f5a4e7843b32dd978ae529a',
    'public.fn_trg_otorgar_puntos_por_cita()': '8270cf772d8160350926c8762482ca4b',
  });
  for (const sql of [migration, preflight]) {
    const manifest = new Map([...sql.matchAll(/^\s*\('([^']+)', '(?:function|procedure)', ARRAY\[([^\]]*)\]/gm)]
      .map((m) => [m[1], [...m[2].matchAll(/'([a-f0-9]{32})'/g)].map((h) => h[1])]));
    assert.equal(manifest.size, 41);
    for (const r of routines) {
      assert.deepEqual(manifest.get(`${r.schema}.${r.name}(${r.args})`),
        [...new Set([r.prosrc_md5_lf, r.qa_prosrc_md5_lf,
          ...(r.verified_variants_02b ?? []).map((v) => v.prosrc_md5_lf)].filter(Boolean))]);
    }
  }
});

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

for (const scenario of [
  { environment: 'qa', observed: false }, { environment: 'production', observed: false },
  { environment: 'qa', observed: true }, { environment: 'production', observed: true },
]) {
  const { environment, observed } = scenario;
  test(`SECURITY02 ${environment}${observed ? ' verified 02B' : ''}: preflight, real bodies, permissions/RLS/triggers, Advisor, rollback`, { skip: !runPostgres }, async (t) => {
    const postgres = await startPostgres17();
    t.after(() => postgres.stop());
    const { client } = postgres;
    await client.query(fixture);
    const ordered = [...routines].sort((a, b) => {
      const priority = (r) => r.name === 'fn_has_role' ? 0 : r.name === 'fn_is_super_admin' ? 1 : 2;
      return priority(a) - priority(b);
    });
    for (const r of ordered) {
      const variant = observed && verifiedVariants.find((v) => v.routine === r && v.observed_environments.includes(environment));
      await client.query(variant ? variant.definition
        : environment === "qa" && r.qa_definition_override ? r.qa_definition_override : r.definition);
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
    if (observed) {
      for (const v of verifiedVariants.filter((v) => v.observed_environments.includes(environment))) {
        assert.equal(inspected.find((r) => r.signature === v.signature).canonical_body_hash, v.prosrc_md5_lf);
        // AM | Even a harmless unreviewed comment must still fail the exact hash guard.
        await client.query(v.definition.replace(v.body, `${v.body}\n-- AM: unreviewed body sentinel\n`));
        const changed = (await client.query(preflight)).rows.find((r) => r.signature === v.signature);
        assert.equal(changed.definition_status, 'BODY_REVIEW');
        await aborts(client, migration, /signature\/owner\/body\/security drift/);
        await client.query(v.definition);
      }
      if (environment === 'qa') {
        const noop = verifiedVariants.find((v) => v.routine.name === 'fn_trg_otorgar_puntos_por_cita');
        const guard = verifiedVariants.find((v) => v.routine.name === 'fn_points_tx_guard_acumular_final');
        await client.query(noop.definition.replace(noop.routine.name, guard.routine.name));
        assert.equal((await client.query(preflight)).rows.find((r) => r.signature === guard.signature).definition_status, 'BODY_REVIEW');
        await aborts(client, migration, /signature\/owner\/body\/security drift/);
        await client.query(guard.definition);
      }
      assert.deepEqual(await catalog(client), initial, 'negative hash tests restore every original contract');
    }
    assert.deepEqual(await findings(client), {
      function_search_path_mutable: environment === "qa" ? 31 : 36,
      anon_security_definer_function_executable: 2,
      authenticated_security_definer_function_executable: 4,
    });
    // AM | Existing RLS and trigger behavior must already pass before hardening.
    await client.query(rlsCases);
    if (observed) await client.query(expirationCases);

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
    if (!observed) {
      // AM | A newly allowed body never authorizes overwriting an older backup.
      const expiration = verifiedVariants.find((v) => v.routine.name === 'fn_points_materialize_expired_cycles');
      const saved = (await client.query('SELECT pg_get_functiondef(to_regprocedure($1)) AS def', [expiration.signature])).rows[0].def;
      await client.query(expiration.definition);
      await aborts(client, rollback, /definition\/config drift/);
      await aborts(client, migration, /backup identity\/body drift/);
      await client.query(saved);
      assert.deepEqual(await catalog(client), applied, 'approved drift cannot rebase the original backup');
    }
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
    if (observed) await client.query(expirationCases);

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
    if (observed) await client.query(expirationCases);
    await client.query("ALTER FUNCTION public.fn_set_updated_at() SET statement_timeout = '16s'");
    await aborts(client, migration, /post-rollback drift/);
    await client.query("ALTER FUNCTION public.fn_set_updated_at() SET statement_timeout = '15s'");
    await client.query(migration);
    assert.deepEqual(await catalog(client), applied, "reapply after rollback");
    t.diagnostic(`${environment}: search_path ${environment === "qa" ? 31 : 36}→0; anon 2→0; authenticated 4→2 (RLS exceptions)`);
  });
}
