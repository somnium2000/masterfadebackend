import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function guestFixture(options = {}) {
  const oldPersona = randomUUID(), correoId = randomUUID();
  const email = 'guest@example.test';
  let state = { operation: null, personas: [{ id_persona: oldPersona }], users: [], clients: [], roles: [],
    contact: options.free ? null : { id_correo: correoId, id_persona: oldPersona, persona_exists: oldPersona,
      verificado: false, deleted_at: null, persona_deleted: null, has_user: false, has_client: false,
      has_employee: false, has_branch: false, ...options.contact } };
  const auth = new Map(); const passwords = new Map(); const emails = []; const calls = [];
  let createCount = 0, failSql = options.failSql, timeout = options.timeout;
  if (options.authExists) auth.set(randomUUID(), { email, app_metadata: {} });
  let queue = Promise.resolve();
  async function connect() {
    let local, unlock;
    const lock = async () => {
      if (unlock) return;
      const previous = queue; queue = new Promise(resolve => { unlock = resolve; }); await previous;
      local = structuredClone(state);
    };
    return { release() { if (unlock) { unlock(); unlock = null; } }, query: async (sql, params = []) => {
      const q = sql.replace(/\s+/g, ' ').trim(); calls.push({ q, params });
      if (q === 'BEGIN') { local = structuredClone(state); return { rows: [] }; }
      if (q === "SET LOCAL lock_timeout = '3s'") return { rows: [] };
      if (q.includes('pg_advisory_xact_lock') && String(params[0]).startsWith('password-operation:')) return { rows: [] };
      if (q.includes('pg_advisory_xact_lock') || /guest_registration_requests WHERE .*FOR UPDATE/.test(q)) await lock();
      if (q.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (q === 'ROLLBACK') { local = null; if (unlock) { unlock(); unlock = null; } return { rows: [] }; }
      if (q === 'COMMIT') { state = local; local = null; if (unlock) { unlock(); unlock = null; } return { rows: [] }; }
      const s = local || state;
      if (failSql && q.includes(failSql)) { failSql = null; throw new Error('synthetic SQL failure'); }
      const result = rows => ({ rows, rowCount: rows.length });
      if (q.startsWith('SELECT id_persona FROM public.personas')) {
        assert.equal(params[0],oldPersona);assert.match(q,/FOR UPDATE/);return result([{id_persona:oldPersona}]);
      }
      if (q.includes('WITH base_user')) {
        const user = s.users.find(u=>u.id===params[0]);
        return result(user ? [{id_usuario:user.id,id_persona:user.persona,email,
          roles:s.roles.filter(r=>r.user===user.id).map(r=>r.role),branch_ids:[],cliente_id:s.clients.find(c=>c.user===user.id)?.id}] : []);
      }
      if (q.includes('app_protected_users')) return result([]);
      if (q.includes('COUNT(') && q.includes('seguridad_login_logs')) return result([{total:0}]);
      if (q.includes('SELECT estado_acceso')) return result([{estado_acceso:'activo'}]);
      if (q.startsWith('UPDATE public.usuarios')) return result([{estado_acceso:'activo'}]);
      if (q.includes('seguridad_')) {
        assert.ok(/seguridad_(login_logs|usuarios_acceso|sesiones|session_policy|audit_logs|alertas)/.test(q));
        return result([]);
      }
      if (q.startsWith('SELECT id, raw_app_meta_data FROM auth.users')) return result([...auth].filter(([,u]) => u.email === params[0]).map(([id,u]) => ({ id, raw_app_meta_data: u.app_metadata })));
      if (q.includes('FROM public.correos co LEFT JOIN public.personas')) {
        assert.ok(q.includes('public.usuarios') && q.includes('public.empleados') && q.includes('public.sucursales'));
        if (!s.contact) return result([]);
        const c = { ...s.contact, has_user: s.contact.has_user || s.users.some(u => u.persona === s.contact.id_persona),
          has_client: s.contact.has_client || s.clients.some(c => c.persona === s.contact.id_persona) };
        return result(options.multiple ? [c, { ...c, id_correo: randomUUID() }] : [c]);
      }
      if (q.includes('FROM public.citas_grupos cg')) {
        assert.equal(params[0], oldPersona);
        return result(options.unsafeHistory ? [{ titular_count: 0 }] : [{ titular_count: 1, id_persona_cliente: oldPersona,
          contacto_email: email, contacto_email_snapshot: email, id_cita_integrante: correoId, snapshot_id: correoId,
          snapshot_persona: oldPersona, snapshot_order: 1, snapshot_role: 'titular' }]);
      }
      if (q.startsWith('SELECT * FROM app_private.guest_registration_requests')) return result(s.operation ? [structuredClone(s.operation)] : []);
      if (q.startsWith('INSERT INTO app_private.guest_registration_requests')) {
        assert.ok(!s.operation); s.operation = { id: params[0], email: params[1], id_correo: params[2], original_persona_id: params[3],
          auth_user_id: params[4], token_hash: params[5], expires_at: new Date(Date.now()+1800000).toISOString(), last_sent_at: new Date().toISOString(), state: 'pending' };
        return result([]);
      }
      if (q.startsWith('UPDATE app_private.guest_registration_requests SET token_hash')) {
        s.operation.token_hash = params[1]; s.operation.last_sent_at = new Date().toISOString(); s.operation.expires_at = new Date(Date.now()+1800000).toISOString(); return result([]);
      }
      if (q.startsWith("UPDATE app_private.guest_registration_requests SET state='completed'")) {
        Object.assign(s.operation, { state: 'completed', email: null, result_persona_id: params[1], result_cliente_id: params[2] }); return result([]);
      }
      if (q.startsWith('INSERT INTO public.personas')) {
        const id = randomUUID(); s.personas.push({ id_persona: id }); return result([{ id_persona: id }]);
      }
      if (q.startsWith('INSERT INTO public.usuarios')) { s.users.push({ id: params[0], persona: params[1] }); return result([]); }
      if (q.startsWith('SELECT id_rol')) return result([{ id_rol: correoId }]);
      if (q.startsWith('INSERT INTO public.roles_usuarios')) { assert.match(q, /NULL|\$3::uuid/); s.roles.push({ user: params[1], role: 'cliente' }); return result([]); }
      if (q.includes('information_schema.columns')) return result([{column_name:'acepta_terminos_at'},{column_name:'consentimiento_marketing_at'}]);
      if (q.startsWith('INSERT INTO public.clientes')) {
        const id = randomUUID(); s.clients.push({ id, persona: params[0], user: params[1], marketing: params[3], terms: params[4] }); return result([{id_cliente:id}]);
      }
      if (q.startsWith('UPDATE public.correos')) {
        assert.match(q, /id_persona=\$3/); assert.equal(params[0], correoId); assert.equal(params[2], oldPersona);
        Object.assign(s.contact, { id_persona: params[1], verificado: true }); return result([{id_correo:correoId}]);
      }
      if (q.startsWith('INSERT INTO public.correos')) { s.contact = {id_persona:params[0],verificado:true}; return result([]); }
      throw new Error('Unexpected query in strict guest fixture: ' + q.slice(0,100));
    } };
  }
  const db = { connect, query: async (sql, params) => { const c = await connect(); try { return await c.query(sql,params); } finally { c.release(); } } };
  const app = { db, mailer: { configured: true, sendMail: async message => { emails.push(message); return {sent:!options.smtpFail}; } },
    supabaseAdmin: { auth: { admin: {
      getUserById: async id => ({ data: {user:auth.has(id)?{id,...auth.get(id)}:null}, error:auth.has(id)?null:{status:404} }),
      createUser: async attributes => {
        createCount++;
        if (options.authFail) return {error:{status:503}};
        if ([...auth.values()].some(u=>u.email===attributes.email)) return {error:{status:409}};
        const id = attributes.id || randomUUID();
        auth.set(id,{email:attributes.email,app_metadata:attributes.app_metadata||{}}); passwords.set(id,attributes.password);
        if (timeout) { timeout=false; throw new Error('synthetic timeout after Auth creation'); }
        return {data:{user:{id,...auth.get(id)}}};
      },
      updateUserById: async (id, body) => { passwords.set(id,body.password); return {error:null}; },
      deleteUser: async () => { throw new Error('Must not compensate by deleting an ambiguous Auth identity'); },
    } } } };
  return { app, db, calls, emails, auth, passwords, email, oldPersona,
    state:()=>state, creates:()=>createCount, expire:()=>{state.operation.expires_at=new Date(0).toISOString();},
    allowResend:()=>{state.operation.last_sent_at=new Date(0).toISOString();},
    proof:()=>{const u=new URL(emails.at(-1).text.split('\n').at(-1));return Object.fromEntries(new URLSearchParams(u.hash.slice(1)));} };
}
