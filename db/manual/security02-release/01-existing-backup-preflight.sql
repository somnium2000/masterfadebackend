-- AM: SOLO LECTURA. Ejecutar UNICAMENTE si el catalogo confirma que existe el respaldo.
-- Exigir 41 filas y status=READY en todas. No rebaselinar ni borrar un respaldo incompatible.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='60s';
WITH live AS (
 SELECT b.*,p.oid current_oid,p.proowner,p.prosrc,p.prosecdef,p.proconfig,
 (SELECT coalesce(jsonb_agg(jsonb_build_object(
 'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 'grantor',pg_get_userbyid(a.grantor),'grantable',a.is_grantable)
 ORDER BY a.grantee,a.grantor,a.is_grantable),'[]')
 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) current_acl
 FROM app_private.security02_routine_backup b LEFT JOIN pg_proc p ON p.oid=to_regprocedure(b.signature)
)
SELECT signature,CASE
 WHEN current_oid IS DISTINCT FROM routine_oid OR original_body_hash IS DISTINCT FROM md5(prosrc)
 OR original_owner IS DISTINCT FROM pg_get_userbyid(proowner)
 OR original_security_definer IS DISTINCT FROM prosecdef THEN 'IDENTITY_BODY_DRIFT'
 WHEN applied_at IS NOT NULL AND rolled_back_at IS NULL
 AND (applied_config IS DISTINCT FROM proconfig OR applied_execute_acl IS DISTINCT FROM current_acl) THEN 'APPLIED_DRIFT'
 WHEN rolled_back_at IS NOT NULL
 AND (original_config IS DISTINCT FROM proconfig OR original_execute_acl IS DISTINCT FROM current_acl) THEN 'RESTORED_DRIFT'
 ELSE 'READY' END status
FROM live ORDER BY signature;
COMMIT;
