import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// AM: Genera SQL manual desde fuentes versionadas y catalogos de lectura, nunca conecta a una BD.
const root = new URL('../', import.meta.url);
const read = async name => (await readFile(new URL(name, root), 'utf8')).replace(/\r\n/g, '\n');
const save = (name, content) => writeFile(new URL('db/manual/release10/' + name, root), content);
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const prod = JSON.parse(await read('test/fixtures/masterpuntos-release10/current/prod-catalog.json'));
const qaObserved = JSON.parse(await read('test/fixtures/masterpuntos-release10/current/qa-catalog.json'));
const extra = JSON.parse(await read('test/fixtures/masterpuntos-release10/current/prod-extra.json'));
// AM: Mismos cuerpos efectivos QA; conservar el path endurecido productivo en las nueve rutinas publicas.
const qa = {...qaObserved,functions:qaObserved.functions.map(f=>{
  if(f.signature.startsWith('app_private.'))return f;
  const definition=f.definition.replace(" SET search_path TO 'pg_catalog', 'public'\n", " SET search_path TO 'pg_catalog', 'public', 'pg_temp'\n");
  return {...f,definition,config:['search_path=pg_catalog, public, pg_temp'],hash:createHash('md5').update(definition).digest('hex')};
})};
const data = (await read('db/manual/release10/data-checks.sql')).replace(/;\s*$/, '');
const values = list => list.map(row => '(' + row.map(literal).join(',') + ')').join(',\n');
const publicSignature = f => f.signature.startsWith('app_private.') ? f.signature : 'public.' + f.signature;
const functionRows = list => values(list.map(f => [publicSignature(f), f.hash, f.acl ? '{'+f.acl.join(',')+'}' : '']));
const functionCheck = (list, exact = true) => `NOT EXISTS (SELECT 1 FROM (VALUES\n${functionRows(list)}\n) e(signature,hash,acl)
 WHERE to_regprocedure(e.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(e.signature))) <> e.hash
 OR (SELECT pg_get_userbyid(proowner) <> 'postgres' OR prosecdef OR COALESCE(proacl::text,'')<>e.acl FROM pg_proc WHERE oid=to_regprocedure(e.signature)))
 ${exact ? `AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','app_private') AND (p.proname ILIKE '%point%' OR p.proname ILIKE '%punto%'))=${list.length}` : ''}`;
const triggers = list => values(list.map(t => [t.table,t.name,t.definition]));
const triggerCheck = (list, containment=false) => `NOT EXISTS (SELECT 1 FROM (VALUES\n${triggers(list)}\n) e(tablename,name,definition)
 LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.tablename) AND t.tgname=e.name
 WHERE t.oid IS NULL OR NOT (t.tgenabled='O' ${containment ? "OR (e.name LIKE 'tr_points_paid_%' AND t.tgenabled='D')" : ''}) OR pg_get_triggerdef(t.oid)<>e.definition)`;
const scopedTriggers = s => s.triggers.filter(t => t.name.startsWith('tr_points_'));
const original = `${functionCheck(prod.functions)} AND ${triggerCheck(scopedTriggers(prod))}
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr_points_paid_%' AND NOT tgisinternal)`;
const target = `${functionCheck(qa.functions)} AND ${triggerCheck(scopedTriggers(qa))}`;
const columns = [...prod.columns,...extra.columns].filter(c =>
  c.table.startsWith('points_') || ['citas','citas_grupos','citas_detalles','clientes','payments','payment_intents',
    'subscriptions','subscription_consumptions','subscription_payments','membership_purchase_orders','payment_events','payment_providers','tipos_puntos'].includes(c.table));
const indexes = prod.indexes.filter(i => ['uq_points_cycle_active_cliente','uq_points_tx_acumular_por_cita','uq_points_tx_canje_por_cita','uq_points_tx_vencimiento_por_cycle'].includes(i.name));
const catalogChecks = `SELECT 'CATALOG_DRIFT' code, CASE WHEN (${original}) OR (${target}) THEN 0 ELSE 1 END::bigint affected
 UNION ALL SELECT 'REQUIRED_COLUMNS',count(*) FROM (VALUES\n${values(columns.map(c=>[c.table,c.name,c.type]))}\n) e(tablename,name,type)
 WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=e.tablename AND c.column_name=e.name AND c.udt_name=e.type)
 UNION ALL SELECT 'REQUIRED_UNIQUE_INDEXES',count(*) FROM (VALUES\n${values(indexes.map(i=>[i.name,i.definition]))}\n) e(name,definition)
 WHERE NOT EXISTS(SELECT 1 FROM pg_indexes i JOIN pg_class ic ON ic.relname=i.indexname JOIN pg_index ix ON ix.indexrelid=ic.oid
 WHERE i.schemaname='public' AND i.indexname=e.name AND i.indexdef=e.definition AND ix.indisvalid AND ix.indisunique)
 UNION ALL SELECT 'PRIVATE_HELPER_GRANTS',count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='app_private' AND p.proname LIKE 'points_%_v1' AND (p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] OR p.prosecdef)`;
// AM: El respaldo efectivo de SEGURIDAD-02 es dependencia inmutable, no un sello a actualizar.
const backupRows=values(prod.security_backup.map(b=>[b.signature,JSON.stringify(Object.fromEntries(Object.entries(b).filter(([key])=>key!=='routine_oid')))]));
const backupGuard=`SELECT 'SECURITY02_BACKUP_DRIFT' code,count(*)::bigint affected FROM (VALUES\n${backupRows}\n) e(signature,metadata)
 LEFT JOIN app_private.security02_routine_backup b USING(signature)
 WHERE b.signature IS NULL OR b.routine_oid<>to_regprocedure(e.signature)::oid OR to_jsonb(b)-'routine_oid'<>e.metadata::jsonb`;
const checks = `SELECT * FROM (${catalogChecks}) catalog UNION ALL SELECT * FROM (${data}) data_checks UNION ALL ${backupGuard}`;
const requireZero = query => `DO $release10$ DECLARE r record; BEGIN
 FOR r IN ${query} LOOP
 IF r.affected<>0 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BLOCKED: % (%)',r.code,r.affected; END IF;
 END LOOP; END $release10$;\n`;
const digest = `(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t)`;
const cyclesDigest = `(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY id_cycle),'')) FROM public.points_cycles t)`;
const begin = `BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='60s';\nSET LOCAL TimeZone='UTC';\nSET LOCAL search_path=pg_catalog,public;\n`;
const lockTables = ['citas','citas_grupos','citas_detalles','clientes','payments','payment_intents','subscriptions',
  'subscription_consumptions','subscription_payments','membership_purchase_orders','payment_events','payment_providers',
  'points_cycles','points_transactions','points_rules','points_rule_services','tipos_puntos'].sort();
const locks = `LOCK TABLE ${lockTables.map(t=>'public.'+t).join(',')} IN SHARE ROW EXCLUSIVE MODE;\n`;
const beforeDigest = `SELECT set_config('masterfade.release10_ledger',${digest},true),set_config('masterfade.release10_cycles',${cyclesDigest},true);\n`;
const assertDigest = `DO $unchanged$ BEGIN IF ${digest}<>current_setting('masterfade.release10_ledger')
 OR ${cyclesDigest}<>current_setting('masterfade.release10_cycles') THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_LEDGER_CHANGED'; END IF; END $unchanged$;\n`;
await mkdir(new URL('db/manual/release10/', root), { recursive: true });
await save('00-preflight.sql', `-- AM: SOLO LECTURA; cualquier affected>0 es NO-GO. No llamar helpers mutables.\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL TimeZone='UTC';\nSET LOCAL statement_timeout='60s';\nSET LOCAL search_path=pg_catalog,public;\n${checks};\nSELECT count(*) ledger_rows,COALESCE(sum(puntos::bigint),0) ledger_sum,${digest} ledger_md5,${cyclesDigest} cycles_md5 FROM public.points_transactions;\nCOMMIT;\n`);
const sources = ['db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql','db/manual/20261113161929_masterpuntos_paid_confirmation_v1.sql'];
let merged = '';
const hashes = {};
for (const file of sources) {
  const sql = await read(file);
  hashes[file] = createHash('sha256').update(sql).digest('hex');
  merged += `\n-- AM: Fuente exacta ${file}; SHA256 ${hashes[file]}\n` + sql.replace(/^BEGIN;\s*$/mg,'').replace(/^COMMIT;\s*$/mg,'');
}
const harden = prod.functions
  .map(f => `ALTER FUNCTION ${publicSignature(f)} SET search_path TO pg_catalog,public,pg_temp;`).join('\n');
const targetGuard = `SELECT 'TARGET_FUNCTIONS_OR_TRIGGERS' code,CASE WHEN ${target} THEN 0 ELSE 1 END::bigint affected UNION ALL ${backupGuard}`;
await save('10-apply.sql', `-- AM: MANUAL, requiere autorizacion y ventana sin escritores. DDL atomico, sin backfill.\n${begin}${locks}${requireZero(checks)}${beforeDigest}${merged}\n-- AM: Solo cuatro dependencias MasterPuntos de SEGURIDAD-02; no importar su hardening global.\n${harden}\n${requireZero(targetGuard)}${assertDigest}COMMIT;\n`);
await save('20-postflight.sql', `-- AM: SOLO LECTURA; ejecutar antes de reabrir trafico y comparar hashes con 00.\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL TimeZone='UTC';\nSET LOCAL search_path=pg_catalog,public;\n${targetGuard};\n${data};\nSELECT count(*) ledger_rows,COALESCE(sum(puntos::bigint),0) ledger_sum,${digest} ledger_md5,${cyclesDigest} cycles_md5 FROM public.points_transactions;\nSELECT p.oid::regprocedure signature,md5(pg_get_functiondef(p.oid)) hash,p.prosecdef,p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','app_private') AND (p.proname ILIKE '%point%' OR p.proname ILIKE '%punto%') ORDER BY 1::text;\nCOMMIT;\n`);
// AM: Reversion de contencion: detiene nuevos creditos, conserva guardas, expiracion y cada movimiento.
const disable = scopedTriggers(qa).filter(t=>t.name.startsWith('tr_points_paid_')).map(t=>`ALTER TABLE public.${t.table} DISABLE TRIGGER ${t.name};`).join('\n');
const containmentGuard = `SELECT 'TARGET_FUNCTIONS_OR_TRIGGERS' code,CASE WHEN ${functionCheck(qa.functions)} AND ${triggerCheck(scopedTriggers(qa),true)} THEN 0 ELSE 1 END::bigint affected UNION ALL ${backupGuard}`;
await save('30-rollback-containment.sql', `-- AM: MANUAL; mantener trafico detenido. No restaurar backend antiguo ni reabrir con creditos suspendidos.\n${begin}${locks}${requireZero(containmentGuard)}${beforeDigest}${disable}\n${assertDigest}COMMIT;\n`);
// AM: Restauracion exacta solamente para abortar antes de reabrir, con ledger/ciclos aun iguales al preflight.
const restore = prod.functions.map(f=>f.definition+';').join('\n');
const removePaid = scopedTriggers(qa).filter(t=>t.name.startsWith('tr_points_paid_')).map(t=>`DROP TRIGGER ${t.name} ON public.${t.table};`).join('\n');
const restoreTriggers = scopedTriggers(prod).map(t=>t.definition.replace('CREATE TRIGGER','CREATE OR REPLACE TRIGGER')+';').join('\n');
const removeHelpers = qa.functions.filter(f=>f.signature.startsWith('app_private.')).map(f=>`DROP FUNCTION ${f.signature};`).reverse().join('\n');
await save('31-restore-before-traffic.sql', `-- AM: SOLO antes de reabrir. Introducir hashes 00; valores vacios bloquean. Mantener trafico detenido.\n${begin}${locks}${requireZero(targetGuard)}DO $gate$ BEGIN
 IF COALESCE(current_setting('masterfade.release10_expected_ledger',true),'')<>${digest}
 OR COALESCE(current_setting('masterfade.release10_expected_cycles',true),'')<>${cyclesDigest}
 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_RESTORE_REQUIRES_UNCHANGED_BASELINE'; END IF; END $gate$;\n${beforeDigest}${removePaid}\n${restore}\n${restoreTriggers}\n${removeHelpers}\n${requireZero(`SELECT 'RESTORE_CATALOG' code,CASE WHEN ${original} THEN 0 ELSE 1 END::bigint affected`)}${assertDigest}COMMIT;\n`);
await save('manifest.json', JSON.stringify({base:'55a86efb8b492402f79d7ec2930cdcfbd4fc72fb',captured_at:{prod:prod.captured_at,qa:qaObserved.captured_at},qa_project:'jgipiyhjtpgyaujfhghf',prod_project:'pdzsmkjnyazpkoocjbpw',sources:hashes,qa_functions:qa.functions.map(f=>({signature:publicSignature(f),hash:f.hash,body_hash:f.body_hash})),prod_functions:prod.functions.map(f=>({signature:publicSignature(f),hash:f.hash,body_hash:f.body_hash})),note:'Cuerpos QA sin cambios; path endurecido de PROD preservado. Historico legitimo sin ciclo bloquea aplicacion. Respaldo SEGURIDAD-02 no se rebaselina.'},null,2)+'\n');
