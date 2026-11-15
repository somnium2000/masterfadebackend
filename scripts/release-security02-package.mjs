import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// AM: Generador offline. No abre conexiones ni ejecuta SQL.
const root = new URL('../', import.meta.url);
const read = async p => (await readFile(new URL(p, root), 'utf8')).replaceAll('\r\n', '\n');
const json = async p => JSON.parse(await read('test/fixtures/security02-release/' + p));
const prod = await json('prod-catalog.json'), qa = await json('qa-catalog.json');
const candidate = await json('release10/qa-catalog.json');
const base = 'db/manual/20261113235412_seguridad_supabase_02_routine_hardening';
const migration = await read(base + '.sql');
const manifest = new Map([...migration.matchAll(/^\s*\('([^']+)', '(?:function|procedure)', ARRAY\[[^\]]*\], '[^']+', (?:true|false), (true|false), (true|false), '([^']+)', '([^']+)'\)/gm)]
  .map(m => [m[1], { path: m[2] === 'true', existing: m[3] === 'true', target: m[4], scope: m[5] }]));
if (manifest.size !== 41) throw Error('AM: manifiesto incompleto');
const sha = text => createHash('sha256').update(text).digest('hex');
const md5 = text => createHash('md5').update(text).digest('hex');
const lit = text => "'" + String(text).replaceAll("'", "''") + "'";
const contract = r => md5(r.definition.replaceAll('\r\n', '\n').replace(/^ SET search_path TO [^\n]*\n/m, ''));
const strip = r => ({ signature: r.signature, contract: contract(r), body: r.body_md5,
  config: r.config, acl: r.execute_acl, triggers: r.triggers, references: r.references, dependents: r.dependents });
const isPoints = r => /^public\.fn_(?:points_|trg_otorgar_puntos_)/.test(r.signature);
const release10 = prod.routines.map(p => isPoints(p) ? qa.routines.find(q => q.signature === p.signature) : p);
for (const p of release10.filter(isPoints)) {
  const expected = candidate.functions.find(f => ('public.' + f.signature).replaceAll(' ', '') === p.signature.replaceAll(' ', ''));
  if (!expected || expected.hash !== p.definition_md5) throw Error('AM: deriva del candidato #123: ' + p.signature);
}
const harden = r => {
  const m = manifest.get(r.signature), result = strip(r);
  if (m.existing || (m.path && !(r.config ?? []).some(v => v.startsWith('search_path=')))) {
    result.config = [...(r.config ?? []).filter(v => !v.startsWith('search_path=')), 'search_path=' + m.target];
  }
  if (m.scope !== 'unchanged') result.acl = qa.routines.find(q => q.signature === r.signature).execute_acl;
  return result;
};
const states = {
  PROD_CURRENT: prod.routines.map(strip), PROD_HARDENED: prod.routines.map(harden),
  RELEASE10_CURRENT: release10.map(strip), RELEASE10_HARDENED: release10.map(harden),
};
const rows = Object.entries(states).flatMap(([state, list]) => list.map(r => `(${lit(state)},${lit(JSON.stringify(r))}::jsonb)`)).join(',\n');
// AM: Definicion completa (excepto search_path) + cuerpo + ACL efectiva + dependencias/triggers exactos.
const cte = `WITH expected(state,r) AS (VALUES\n${rows}\n), live AS (
 SELECT e.state,e.r, jsonb_build_object('signature',e.r->>'signature',
 'contract',md5(regexp_replace(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)), '^ SET search_path TO [^'||chr(10)||']*'||chr(10),'','m')),
 'body',md5(replace(p.prosrc,chr(13)||chr(10),chr(10))), 'config',to_jsonb(p.proconfig),
 'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled,'internal',t.tgisinternal) ORDER BY pg_get_triggerdef(t.oid)),'[]') FROM pg_trigger t WHERE t.tgfoid=p.oid),
 'references',(SELECT coalesce(jsonb_agg(jsonb_build_object('object',pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid),'type',d.deptype) ORDER BY pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid)),'[]') FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid),
 'dependents',(SELECT coalesce(jsonb_agg(jsonb_build_object('object',pg_describe_object(d.classid,d.objid,d.objsubid),'type',d.deptype) ORDER BY pg_describe_object(d.classid,d.objid,d.objsubid)),'[]') FROM pg_depend d WHERE d.refclassid='pg_proc'::regclass AND d.refobjid=p.oid)) actual,
 pg_get_userbyid(p.proowner) owner
 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.r->>'signature')
), checks AS (SELECT state,count(*) FILTER(WHERE r IS DISTINCT FROM actual OR owner IS DISTINCT FROM 'postgres') mismatches FROM live GROUP BY state)
`;
const trusted = `current_user='postgres' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('anon','authenticated') AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb))
 AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))=3
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE nspname IN ('public','auth','app_private') AND (has_schema_privilege('anon',n.oid,'CREATE') OR has_schema_privilege('authenticated',n.oid,'CREATE')))
 AND (SELECT pg_get_userbyid(nspowner)='postgres' FROM pg_namespace WHERE nspname='app_private')`;
const gate = allowed => `DO $release_security02$ BEGIN IF NOT (${trusted}) OR NOT EXISTS(${cte} SELECT 1 FROM checks WHERE mismatches=0 AND state IN (${allowed.map(lit).join(',')})) THEN RAISE EXCEPTION 'SECURITY02_RELEASE_CATALOG_DRIFT'; END IF; END $release_security02$;\n`;
const readonly = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL search_path=pg_catalog;\nSET LOCAL statement_timeout='60s';\n";
const dir = 'db/manual/security02-release/';
await mkdir(new URL(dir,root),{recursive:true});
const save = (p,s) => writeFile(new URL(dir+p,root),s);
await save('00-preflight.sql', `-- AM: SOLO LECTURA. Una variante exacta debe tener mismatches=0 y trusted=true.\n${readonly}${cte}SELECT state,mismatches,(${trusted}) trusted FROM checks ORDER BY state;\nCOMMIT;\n`);
const beforeStates = Object.keys(states), afterStates = beforeStates.filter(s => s.endsWith('HARDENED'));
const controlled = migration.replace('DO $preflight$',gate(beforeStates)+'DO $preflight$')
  .replace(/COMMIT;\s*$/, gate(afterStates)+'COMMIT;\n');
await save('10-apply.sql', '-- AM: MANUAL. Fuente 02B intacta, rodeada por guardas del catalogo real. Sin DML comercial.\n'+controlled);
const backupCheck = `SELECT 'BACKUP_INTEGRITY' code,count(*) total,count(*) FILTER(WHERE b.routine_oid=p.oid AND b.original_body_hash=md5(p.prosrc) AND b.original_owner=pg_get_userbyid(p.proowner) AND b.original_security_definer=p.prosecdef AND b.applied_config IS NOT DISTINCT FROM p.proconfig AND b.applied_at IS NOT NULL AND b.rolled_back_at IS NULL AND b.applied_execute_acl=(SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.is_grantable),'[]') FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) valid FROM app_private.security02_routine_backup b LEFT JOIN pg_proc p ON p.oid=to_regprocedure(b.signature);
SELECT 'BACKUP_PRIVATE' code,pg_get_userbyid(relowner)='postgres' AND relrowsecurity AND NOT has_table_privilege('anon',oid,'SELECT') AND NOT has_table_privilege('authenticated',oid,'SELECT') AND NOT has_table_privilege('service_role',oid,'SELECT') valid FROM pg_class WHERE oid='app_private.security02_routine_backup'::regclass;\n`;
await save('20-postflight.sql', `-- AM: SOLO LECTURA. Exigir estado *_HARDENED exacto y trusted=true; respaldo total=valid=41 y BACKUP_PRIVATE valid=true.\n${readonly}${cte}SELECT state,mismatches,(${trusted}) trusted FROM checks ORDER BY state;\n${backupCheck}COMMIT;\n`);
await save('30-rollback.sql', await read(base+'.rollback.sql'));
await save('40-rollback-postflight.sql', `-- AM: SOLO LECTURA. Exigir estado *_CURRENT exacto y trusted=true.\n${readonly}${cte}SELECT state,mismatches,(${trusted}) trusted FROM checks ORDER BY state;\nSELECT count(*) FILTER(WHERE rolled_back_at IS NOT NULL) restored, count(*) total FROM app_private.security02_routine_backup;\nCOMMIT;\n`);
await save('manifest.json', JSON.stringify({base:'3a77863038f866f2b30787a8e67cf69bd8e8adaa',qa_reference:'73f1537',
  candidate123:'57ca040ab6641896558fd939e282406acfcd6ff3',captured_at:{qa:qa.captured_at,prod:prod.captured_at},
  source_sha256:sha(migration),states:Object.keys(states),scope:'metadata only; no commercial bodies, rows, policies, owners or bindings changed'},null,2)+'\n');
