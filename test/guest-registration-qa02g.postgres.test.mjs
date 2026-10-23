import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { requestGuestRegistration, completeGuestRegistration } from '../src/services/guestRegistrationService.js';

const RUN = process.env.RUN_GUEST_REGISTRATION_PG_INTEGRATION === 'true';
const body = { nombres: 'Synthetic', apellidos: 'Only', contrasena: 'SyntheticOnly9!',
  confirmar_contrasena: 'SyntheticOnly9!', acepta_terminos: true, consentimiento_marketing: false };
const hash = value => createHash('sha256').update(value).digest('hex');
const response = (status, value) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

// AM: SDK real y transporte simulado; nunca se contacta GoTrue ni se crea una cuenta real.
function authDouble({ persist = async () => {} } = {}) {
  const users = new Map();
  let creates = 0, updates = 0, loseNextResponse = false;
  const client = createClient('http://127.0.0.1:1', 'synthetic-local-only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, options = {}) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'http://127.0.0.1:1');
      const method = options.method || 'GET';
      if (method === 'POST' && url.pathname === '/auth/v1/admin/users') {
        const attributes = JSON.parse(options.body);
        assert.match(attributes.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        assert.equal(attributes.email_confirm, true);
        assert.equal(attributes.role, undefined);
        assert.ok(attributes.app_metadata.guest_registration_id);
        const user = { id: attributes.id, email: attributes.email, app_metadata: attributes.app_metadata,
          aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString() };
        assert.equal(users.has(user.id), false);
        await persist(user);
        users.set(user.id, user); creates++;
        if (loseNextResponse) { loseNextResponse = false; throw new TypeError('Synthetic uncertain response'); }
        return response(200, user);
      }
      const id = url.pathname.match(/^\/auth\/v1\/admin\/users\/([a-f0-9-]+)$/)?.[1];
      assert.ok(id, 'Unexpected Auth request');
      const user = users.get(id);
      if (!user) return response(404, { code: 'user_not_found', msg: 'Synthetic user missing' });
      if (method === 'PUT') {
        assert.equal(typeof JSON.parse(options.body).password, 'string'); updates++;
      } else assert.equal(method, 'GET');
      return response(200, user);
    } },
  });
  return { admin: client.auth.admin, users, creates: () => creates, updates: () => updates,
    loseNextResponse: () => { loseNextResponse = true; },
    reset: () => { users.clear(); creates = 0; updates = 0; loseNextResponse = false; } };
}

test('02G: SDK instalado transmite UUID V4 y metadata; reconcilia respuesta incierta por UUID', async () => {
  const fake = authDouble();
  const id = randomUUID(), operation = randomUUID();
  const attributes = { id, email: 'sdk@example.test', password: body.contrasena,
    email_confirm: true, app_metadata: { guest_registration_id: operation } };
  fake.loseNextResponse();
  const uncertain = await fake.admin.createUser(attributes);
  assert.ok(uncertain.error);
  assert.equal(uncertain.data.user, null);
  const found = await fake.admin.getUserById(id);
  assert.equal(found.error, null); assert.equal(found.data.user.id, id);
  assert.equal(found.data.user.app_metadata.guest_registration_id, operation);
  assert.equal((await fake.admin.updateUserById(id, { password: body.contrasena })).error, null);
  assert.equal(fake.creates(), 1); assert.equal(fake.updates(), 1);
});

// AM: Fixture reducido derivado de FUNC-QA-02K; no afirma reproducir todo Supabase.
const fixtureSql = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE qa02g_backend NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA app_private;
REVOKE ALL ON SCHEMA auth, app_private FROM PUBLIC;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text NOT NULL UNIQUE, raw_app_meta_data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE public.personas (id_persona uuid PRIMARY KEY DEFAULT gen_random_uuid(), nombres text, apellidos text, deleted_at timestamptz);
CREATE TABLE public.correos (id_correo uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_persona uuid REFERENCES public.personas(id_persona), direccion_correo text NOT NULL CONSTRAINT uq_correo_direccion UNIQUE, verificado boolean DEFAULT false, es_principal boolean DEFAULT false, deleted_at timestamptz);
CREATE TABLE public.usuarios (id_usuario uuid PRIMARY KEY REFERENCES auth.users(id), id_persona uuid NOT NULL REFERENCES public.personas(id_persona), estado boolean, estado_acceso text, credenciales_completadas_at timestamptz);
CREATE TABLE public.clientes (id_cliente uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_persona uuid NOT NULL REFERENCES public.personas(id_persona), id_usuario uuid UNIQUE REFERENCES public.usuarios(id_usuario), acepta_terminos boolean, consentimiento_marketing boolean);
CREATE TABLE public.empleados (id_empleado uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_persona uuid REFERENCES public.personas(id_persona));
CREATE TABLE public.sucursales (id_sucursal uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_correo uuid REFERENCES public.correos(id_correo));
CREATE TABLE public.roles (id_rol uuid PRIMARY KEY DEFAULT gen_random_uuid(), nombre text NOT NULL UNIQUE);
INSERT INTO public.roles(nombre) VALUES ('cliente'), ('admin');
CREATE TABLE public.roles_usuarios (id_rol uuid REFERENCES public.roles(id_rol), id_usuario uuid REFERENCES public.usuarios(id_usuario), id_sucursal uuid, activo boolean);
CREATE TABLE public.citas_grupos (id_grupo_cita uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_persona_titular uuid REFERENCES public.personas(id_persona));
CREATE TABLE public.citas_integrantes (id_cita_integrante uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_grupo_cita uuid REFERENCES public.citas_grupos(id_grupo_cita), id_persona uuid REFERENCES public.personas(id_persona), orden_integrante integer, rol_integrante_codigo text, contacto_email_snapshot text, UNIQUE(id_grupo_cita, orden_integrante));
CREATE TABLE public.citas (id_cita uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_grupo_cita uuid REFERENCES public.citas_grupos(id_grupo_cita), id_cita_integrante uuid REFERENCES public.citas_integrantes(id_cita_integrante), id_persona_cliente uuid REFERENCES public.personas(id_persona), contacto_email text, orden_integrante integer, deleted_at timestamptz);
`;

test('02G: migración, permisos y servicio con PostgreSQL 17 desechable real', { skip: !RUN }, async t => {
  assert.equal(process.env.MASTERFADE_GUEST_TEST_DISPOSABLE, '02g-ci-only');
  const url = new URL(process.env.MASTERFADE_GUEST_TEST_DATABASE_URL || '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/guest_registration_02g');
  assert.equal(url.search, '');
  assert.ok(url.port);
  const admin = new pg.Pool({ connectionString: url.href, ssl: false, max: 6,
    connectionTimeoutMillis: 5000, query_timeout: 10000 });
  let backend;
  const previousFrontend = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://qa.example.test';
  try {
    const identity = (await admin.query(`SELECT current_user, session_user, current_database() AS db,
      current_setting('server_version_num')::int AS version, inet_server_addr()::text AS host`)).rows[0];
    assert.ok(identity.version >= 170000 && identity.version < 180000);
    assert.equal(identity.db, 'guest_registration_02g');
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname IN ('public','auth','app_private')")).rows[0].n, 0);
    await admin.query(fixtureSql);
    const migration = await readFile(new URL('../db/migrations/20261019010000_guest_registration_requests.sql', import.meta.url), 'utf8');
    await admin.query(migration);

    await t.test('tabla, columnas y constraints reales; reaplicación falla sin alterar la tabla', async () => {
      const columns = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='app_private' AND table_name='guest_registration_requests'")).rows.map(r => r.column_name).sort();
      assert.deepEqual(columns, ['id','email','id_correo','original_persona_id','auth_user_id','token_hash','expires_at','last_sent_at','state','result_persona_id','result_cliente_id','completed_at','created_at'].sort());
      const constraints = (await admin.query("SELECT contype FROM pg_constraint WHERE conrelid='app_private.guest_registration_requests'::regclass")).rows;
      for (const type of ['p','u','f','c']) assert.ok(constraints.some(r => r.contype === type));
      await assert.rejects(admin.query(migration), e => e.code === '42P07');
      await admin.query('ROLLBACK');
      assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.guest_registration_requests')).rows[0].n, 0);
    });

    await t.test('RLS activa; roles públicos sin USAGE ni acceso; GRANT solo no evita RLS', async () => {
      assert.equal((await admin.query("SELECT relrowsecurity FROM pg_class WHERE oid='app_private.guest_registration_requests'::regclass")).rows[0].relrowsecurity, true);
      for (const role of ['anon','authenticated','service_role','qa02g_backend']) {
        assert.equal((await admin.query('SELECT has_schema_privilege($1, $2, $3) AS allowed', [role,'app_private','USAGE'])).rows[0].allowed, false);
        assert.equal((await admin.query('SELECT has_table_privilege($1, $2, $3) AS allowed', [role,'app_private.guest_registration_requests','SELECT'])).rows[0].allowed, false);
      }
      const probe = await admin.connect();
      try {
        for (const role of ['anon','authenticated','service_role']) {
          await probe.query(`SET ROLE ${role}`);
          await assert.rejects(probe.query('SELECT * FROM app_private.guest_registration_requests'), e => e.code === '42501');
          await probe.query('RESET ROLE');
        }
        await admin.query('GRANT USAGE ON SCHEMA app_private TO qa02g_backend; GRANT SELECT, INSERT, UPDATE ON app_private.guest_registration_requests TO qa02g_backend');
        await probe.query('SET ROLE qa02g_backend');
        await assert.rejects(probe.query(`INSERT INTO app_private.guest_registration_requests(id,email,auth_user_id,token_hash,expires_at)
          VALUES($1,'rls@example.test',$2,$3,now()+interval '30 minutes')`, [randomUUID(),randomUUID(),'a'.repeat(64)]), e => e.code === '42501');
      } finally { await probe.query('RESET ROLE'); probe.release(); }
      // AM: Política exclusiva del rol sintético CI, no propuesta de permisos para QA.
      await admin.query(`CREATE POLICY qa02g_backend_only ON app_private.guest_registration_requests
        TO qa02g_backend USING (true) WITH CHECK (true);
        GRANT USAGE ON SCHEMA auth TO qa02g_backend;
        GRANT SELECT ON auth.users,public.roles,public.empleados,public.sucursales,public.citas_grupos,public.citas_integrantes,public.citas TO qa02g_backend;
        GRANT SELECT,INSERT,UPDATE ON public.personas,public.correos,public.usuarios,public.clientes,public.roles_usuarios TO qa02g_backend;`);
      assert.equal((await admin.query("SELECT has_table_privilege('qa02g_backend','app_private.guest_registration_requests','DELETE') AS allowed")).rows[0].allowed, false);
    });

    backend = new pg.Pool({ connectionString: url.href, ssl: false, max: 4,
      options: '-c role=qa02g_backend', connectionTimeoutMillis: 5000, query_timeout: 10000 });
    assert.equal((await backend.query('SELECT current_user')).rows[0].current_user, 'qa02g_backend');
    const fake = authDouble({ persist: user => admin.query('INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES($1,$2,$3)', [user.id,user.email,user.app_metadata]) });
    const emails = [];
    const app = { db: backend, supabaseAdmin: { auth: { admin: fake.admin } },
      mailer: { configured: true, sendMail: async message => { emails.push(message); return { sent: true }; } } };
    let oldPersona, email;
    async function seed() {
      await admin.query('TRUNCATE app_private.guest_registration_requests,public.personas,auth.users CASCADE');
      fake.reset(); emails.length = 0;
      oldPersona = randomUUID(); email = 'historical@example.test';
      await admin.query('INSERT INTO public.personas(id_persona) VALUES($1)', [oldPersona]);
      await admin.query('INSERT INTO public.correos(id_persona,direccion_correo) VALUES($1,$2)', [oldPersona,email]);
      const group = (await admin.query('INSERT INTO public.citas_grupos(id_persona_titular) VALUES($1) RETURNING id_grupo_cita', [oldPersona])).rows[0].id_grupo_cita;
      const member = (await admin.query("INSERT INTO public.citas_integrantes(id_grupo_cita,id_persona,orden_integrante,rol_integrante_codigo,contacto_email_snapshot) VALUES($1,$2,1,'titular',$3) RETURNING id_cita_integrante", [group,oldPersona,email])).rows[0].id_cita_integrante;
      await admin.query('INSERT INTO public.citas(id_grupo_cita,id_cita_integrante,id_persona_cliente,contacto_email,orden_integrante) VALUES($1,$2,$3,$4,1)', [group,member,oldPersona,email]);
    }
    const operation = async () => (await admin.query('SELECT * FROM app_private.guest_registration_requests')).rows[0];
    const proof = () => Object.fromEntries(new URLSearchParams(new URL(emails.at(-1).text.split('\n').at(-1)).hash.slice(1)));
    const createCustomer = async (db, input) => (await db.query(`INSERT INTO public.clientes(id_persona,id_usuario,acepta_terminos,consentimiento_marketing)
      VALUES($1,$2,$3,$4) RETURNING id_cliente`, [input.idPersona,input.authUserId,input.aceptaTerminos,input.consentimientoMarketing])).rows[0].id_cliente;
    const complete = (p, callback = createCustomer) => completeGuestRegistration(app, { ...body,...p }, callback);

    await t.test('solicitudes concurrentes: operación única, cooldown y hash sin contraseña ni token plano', async () => {
      await seed();
      await Promise.all([requestGuestRegistration(app,email),requestGuestRegistration(app,email)]);
      assert.equal(emails.length, 1);
      const op = await operation(), p = proof();
      assert.equal(op.token_hash, hash(p.token)); assert.notEqual(op.token_hash,p.token);
      assert.equal(JSON.stringify(op).includes(body.contrasena),false);
      assert.equal(JSON.stringify(op).includes(p.token),false);
      assert.equal((await admin.query('SELECT count(*)::int n FROM auth.users')).rows[0].n,0);
      assert.equal(emails[0].to,email);
      assert.equal(new URL(emails[0].text.split('\n').at(-1)).origin,'https://qa.example.test');
    });

    await t.test('unicidad de email, UUID Auth y token; CHECK normalización, hash y estado', async () => {
      const op = await operation();
      const insert = values => admin.query(`INSERT INTO app_private.guest_registration_requests(id,email,auth_user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`, values);
      await assert.rejects(insert([randomUUID(),email,randomUUID(),'b'.repeat(64)]), e=>e.code==='23505');
      await assert.rejects(insert([randomUUID(),'other@example.test',op.auth_user_id,'b'.repeat(64)]), e=>e.code==='23505');
      await assert.rejects(insert([randomUUID(),'other@example.test',randomUUID(),op.token_hash]), e=>e.code==='23505');
      await assert.rejects(insert([randomUUID(),' Upper@example.test ',randomUUID(),'c'.repeat(64)]), e=>e.code==='23514');
      await assert.rejects(insert([randomUUID(),'other@example.test',randomUUID(),'plaintext']), e=>e.code==='23514');
      await assert.rejects(admin.query("UPDATE app_private.guest_registration_requests SET state='completed'"), e=>e.code==='23514');
      await assert.rejects(admin.query('UPDATE app_private.guest_registration_requests SET id_correo=$1',[randomUUID()]), e=>e.code==='23503');
    });

    await t.test('reenvío invalida token anterior; expiración impide Auth', async () => {
      const old = proof();
      await admin.query("UPDATE app_private.guest_registration_requests SET last_sent_at=now()-interval '2 minutes'");
      await requestGuestRegistration(app,email);
      assert.equal(emails.length,2);
      await assert.rejects(complete(old), e=>e.statusCode===401);
      await admin.query("UPDATE app_private.guest_registration_requests SET expires_at=now()-interval '1 minute'");
      await assert.rejects(complete(proof()), e=>e.statusCode===410);
      assert.equal(fake.creates(),0);
    });

    await t.test('confirmaciones concurrentes y replay: un Auth, un Cliente y ninguna transferencia histórica', async () => {
      await seed(); await requestGuestRegistration(app,email);
      const history = await admin.query('SELECT * FROM public.citas');
      const members = await admin.query('SELECT * FROM public.citas_integrantes');
      const p = proof();
      await Promise.all([complete(p),complete(p)]);
      await complete(p);
      assert.equal(fake.creates(),1);
      assert.equal((await admin.query('SELECT count(*)::int n FROM public.usuarios')).rows[0].n,1);
      assert.equal((await admin.query('SELECT count(*)::int n FROM public.clientes')).rows[0].n,1);
      assert.deepEqual((await admin.query('SELECT * FROM public.citas')).rows,history.rows);
      assert.deepEqual((await admin.query('SELECT * FROM public.citas_integrantes')).rows,members.rows);
      assert.equal((await admin.query('SELECT id_persona_titular FROM public.citas_grupos')).rows[0].id_persona_titular,oldPersona);
      const roles = (await admin.query('SELECT r.nombre,ru.id_sucursal FROM public.roles_usuarios ru JOIN public.roles r USING(id_rol)')).rows;
      assert.deepEqual(roles,[{nombre:'cliente',id_sucursal:null}]);
      const op = await operation(); assert.equal(op.state,'completed'); assert.equal(op.email,null);
      assert.notEqual(op.result_persona_id,oldPersona);
      assert.equal((await admin.query('SELECT id_persona,verificado FROM public.correos')).rows[0].id_persona,op.result_persona_id);
    });

    await t.test('fallo SQL después de Auth: rollback y reconciliación sin duplicar identidades', async () => {
      await seed(); await requestGuestRegistration(app,email); const p = proof();
      await assert.rejects(complete(p, async () => { throw new Error('Synthetic domain failure'); }), /Synthetic domain failure/);
      assert.equal((await admin.query('SELECT count(*)::int n FROM auth.users')).rows[0].n,1);
      assert.equal((await admin.query('SELECT count(*)::int n FROM public.usuarios')).rows[0].n,0);
      assert.equal((await admin.query('SELECT id_persona FROM public.correos')).rows[0].id_persona,oldPersona);
      await complete(p); assert.equal(fake.creates(),1); assert.equal(fake.updates(),1);
    });

    await t.test('timeout tras crear Auth: UUID y metadata reconcilian sin borrar ni crear otra cuenta', async () => {
      await seed(); await requestGuestRegistration(app,email); const p = proof(); fake.loseNextResponse();
      await assert.rejects(complete(p), error => error.statusCode === 503);
      const op = await operation();
      assert.equal((await admin.query('SELECT id,raw_app_meta_data FROM auth.users')).rows[0].id,op.auth_user_id);
      assert.equal((await admin.query('SELECT raw_app_meta_data FROM auth.users')).rows[0].raw_app_meta_data.guest_registration_id,op.id);
      await complete(p); assert.equal(fake.creates(),1); assert.equal(fake.updates(),1);
    });

    await t.test('historial contradictorio se rechaza antes de SMTP y Auth', async () => {
      await seed();
      await admin.query("UPDATE public.citas_integrantes SET contacto_email_snapshot='foreign@example.test'");
      await assert.rejects(requestGuestRegistration(app,email), e=>e.statusCode===409);
      assert.equal(emails.length,0); assert.equal(fake.creates(),0);
    });

    await t.test('UUID preasignado no autoriza una identidad con metadata ajena', async () => {
      await seed(); await requestGuestRegistration(app,email);
      const op = await operation();
      const foreign = { id: op.auth_user_id, email, app_metadata: { guest_registration_id: randomUUID() } };
      await admin.query('INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES($1,$2,$3)',[foreign.id,email,foreign.app_metadata]);
      fake.users.set(foreign.id,foreign);
      await assert.rejects(complete(proof()), error => error.statusCode === 409);
      assert.equal(fake.creates(),0); assert.equal(fake.updates(),0);
      assert.equal((await admin.query('SELECT count(*)::int n FROM public.usuarios')).rows[0].n,0);
      assert.equal((await admin.query('SELECT id_persona FROM public.correos')).rows[0].id_persona,oldPersona);
    });
  } finally {
    if (previousFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontend;
    if (backend) await backend.end();
    await admin.end();
  }
});
