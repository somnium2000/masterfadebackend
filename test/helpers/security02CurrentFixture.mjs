import { readFile } from 'node:fs/promises';
import { startPostgres17 } from './postgres17.mjs';

// AM: SOLO loopback. Cuerpos/ACL/triggers reales; tablas estructurales sin datos remotos.
export const securitySource = async p => (await readFile(new URL('../../'+p,import.meta.url),'utf8'));
export async function decorateSecurity02(c,environment='prod') {
    const snap=JSON.parse(await securitySource(`test/fixtures/security02-release/${environment}-catalog.json`));
    await c.query((await securitySource('test/sql/security-supabase-02-fixture.sql'))
      .replaceAll('CREATE SCHEMA ','CREATE SCHEMA IF NOT EXISTS ').replaceAll('CREATE TABLE public.','CREATE TABLE IF NOT EXISTS public.'));
    for(const r of snap.roles.filter(r=>r.name!=='postgres')){
      if(!(await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[r.name])).rowCount)await c.query(`CREATE ROLE ${r.name}`);
      await c.query(`ALTER ROLE ${r.name} ${r.super?'SUPERUSER':'NOSUPERUSER'} ${r.bypassrls?'BYPASSRLS':'NOBYPASSRLS'} ${r.createrole?'CREATEROLE':'NOCREATEROLE'} ${r.createdb?'CREATEDB':'NOCREATEDB'}`);
    }
    const ordered=[...snap.routines].sort((a,b)=> (a.signature.includes('fn_has_role')?-2:a.signature.includes('fn_is_super_admin')?-1:0)-(b.signature.includes('fn_has_role')?-2:b.signature.includes('fn_is_super_admin')?-1:0));
    for(const r of ordered) {
      await c.query(r.definition);
      if(r.acl!==null){
        await c.query(`REVOKE EXECUTE ON ${r.kind==='p'?'PROCEDURE':'FUNCTION'} ${r.signature} FROM PUBLIC,anon,authenticated,service_role`);
        for(const a of r.execute_acl)await c.query(`GRANT EXECUTE ON ${r.kind==='p'?'PROCEDURE':'FUNCTION'} ${r.signature} TO ${a.grantee}${a.grantable?' WITH GRANT OPTION':''}`);
      }
    }
    for(const r of snap.routines)for(const t of r.triggers){
      const name=t.definition.match(/TRIGGER (\S+)/)[1];
      if(!(await c.query('SELECT 1 FROM pg_trigger WHERE tgname=$1',[name])).rowCount)await c.query(t.definition);
    }
    // AM: Contratos auxiliares fuera del alcance; solo permiten enlazar las politicas reales.
    await c.query(`CREATE TABLE IF NOT EXISTS public.bitacoras(id uuid); CREATE TABLE IF NOT EXISTS public.payment_events(id_intent uuid);
      CREATE FUNCTION public.fn_empleado_id_por_uid(uuid) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
      CREATE FUNCTION public.fn_cliente_id_por_uid(uuid) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';`);
    const policies=JSON.parse(await securitySource(`test/fixtures/security02-release/${environment}-policies.json`));
    for(const p of policies)await c.query(`CREATE POLICY ${p.name} ON public.${p.table} AS ${p.permissive?'PERMISSIVE':'RESTRICTIVE'} FOR ${{r:'SELECT',w:'UPDATE',a:'INSERT',d:'DELETE','*':'ALL'}[p.command]} TO ${p.roles.join(',')}${p.using?' USING ('+p.using+')':''}${p.check?' WITH CHECK ('+p.check+')':''}`);
    return snap;
}
export async function createSecurity02CurrentFixture(environment='prod') {
  const f=await startPostgres17();
  try {const snap=await decorateSecurity02(f.client,environment);return {...f,snap};}
  catch(error){await f.stop();throw error;}
}
