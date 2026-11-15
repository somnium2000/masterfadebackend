import { readFile,writeFile,mkdir } from 'node:fs/promises';

// AM: Solo genera SELECT manuales desde catalogos verificados. No conecta ni escribe en BD.
const root=new URL('../',import.meta.url);
const read=async f=>JSON.parse(await readFile(new URL('test/fixtures/vip-release/'+f,root),'utf8'));
const prod=await read('prod-catalog.json'),qa=await read('qa-catalog.json');
const lit=v=>"'"+String(v).replaceAll("'","''")+"'";
const wanted=['subscriptions','subscription_consumptions','citas','citas_detalles','reserva_idempotencia','citas_admin_beneficios_resumen'];
const cols=prod.columns.filter(c=>wanted.includes(c.table));
for(const c of cols)if(!qa.columns.some(q=>q.schema===c.schema&&q.table===c.table&&q.name===c.name&&q.type===c.type))throw Error('AM: deriva QA/PROD '+c.table+'.'+c.name);
const values=cols.map(c=>'('+[c.schema,c.table,c.name,c.type].map(lit).join(',')+')').join(',\n');
const indexes=prod.indexes.filter(i=>['uq_subc_source_key','ux_subscriptions_active_client_branch'].includes(i.name));
if(indexes.length!==2)throw Error('AM: indices de concurrencia no reconocidos');
const checks=`SELECT 'REQUIRED_COLUMNS' code,count(*)::bigint affected FROM (VALUES\n${values}\n) e(schemaname,tablename,name,type)
WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema=e.schemaname AND c.table_name=e.tablename AND c.column_name=e.name AND c.udt_name=e.type)
UNION ALL SELECT 'REQUIRED_UNIQUE_INDEXES',count(*) FROM (VALUES
${indexes.map(i=>'('+lit(i.name)+','+lit(i.definition)+')').join(',\n')}
) e(name,definition) WHERE NOT EXISTS(SELECT 1 FROM pg_indexes i JOIN pg_class c ON c.relname=i.indexname JOIN pg_index ix ON ix.indexrelid=c.oid WHERE i.schemaname='public' AND i.indexname=e.name AND i.indexdef=e.definition AND ix.indisunique AND ix.indisvalid)
UNION ALL SELECT 'CONSUMPTION_CLIENT_OR_BRANCH_MISMATCH',count(*) FROM public.subscription_consumptions sc
JOIN public.subscriptions s ON s.id_suscripcion=sc.id_suscripcion LEFT JOIN public.citas c ON c.id_cita=sc.id_cita
WHERE sc.id_cliente IS DISTINCT FROM s.id_cliente OR (sc.source_kind='appointment_completed' AND (c.id_cliente IS DISTINCT FROM sc.id_cliente OR c.id_sucursal IS DISTINCT FROM s.id_sucursal_contratada))
UNION ALL SELECT 'DUPLICATE_SOURCE_KEY',count(*) FROM (SELECT source_key FROM public.subscription_consumptions WHERE source_key IS NOT NULL GROUP BY source_key HAVING count(*)>1) d
UNION ALL SELECT 'INVALID_QUANTITY',count(*) FROM public.subscription_consumptions WHERE cantidad IS NULL OR cantidad<=0
UNION ALL SELECT 'ACTIVE_CLIENT_BRANCH_DUPLICATED',count(*) FROM (SELECT id_cliente,id_sucursal_contratada FROM public.subscriptions WHERE estado_suscripcion_codigo='activa' GROUP BY id_cliente,id_sucursal_contratada HAVING count(*)>1) d`;
const evidence=`SELECT 'RESERVATION_EVIDENCE' code,count(*) rows,count(*) FILTER(WHERE response_payload->'membership_consumption'->>'version'='1') version1 FROM app_private.reserva_idempotencia
UNION ALL SELECT 'ADMIN_EVIDENCE',count(*),count(*) FILTER(WHERE resumen_beneficios->'membership_consumption'->>'version'='1') FROM public.citas_admin_beneficios_resumen`;
const snapshot=`SELECT count(*) rows,coalesce(sum(cantidad::bigint),0) units,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY id_consumo),'')) consumptions_md5 FROM public.subscription_consumptions t`;
const sql=`-- AM: SOLO LECTURA. Exigir affected=0 y certificacion separada del productor de evidencia.
-- Cero filas con version1 NO certifica al productor. Ver procedimiento: main aun no lo integra.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TimeZone='UTC'; SET LOCAL search_path=pg_catalog,public; SET LOCAL statement_timeout='60s';
${checks};
${evidence};
${snapshot};
COMMIT;\n`;
await mkdir(new URL('db/manual/vip-release/',root),{recursive:true});
for(const name of ['00-preflight.sql','20-postflight.sql'])await writeFile(new URL('db/manual/vip-release/'+name,root),sql);
await writeFile(new URL('db/manual/vip-release/manifest.json',root),JSON.stringify({base:'32e05f8e0e04e53279099a52d5d9f4eaaa84c9ad',qa_source:'9bd3bfacbd83967d55e6cbb0d2f086cd92806feb',captured_at:{prod:prod.captured_at,qa:qa.captured_at},database_writes_required:false,producer_contract:'membership_consumption version 1, persisted from canonical lines by trusted server',producer_integrated_in_main:false,decision:'NO-GO operativo hasta productor certificado; sin SQL de backfill ni cambios a checkout/reservas del companero'},null,2)+'\n');
