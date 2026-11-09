import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { startPostgres17 } from "./helpers/postgres17.mjs";

const RUN = process.env.RUN_ACCOUNT_DELETION_PG_INTEGRATION === "true";

test("PostgreSQL 17: account deletion schema preserves internal history and guards the Auth lifecycle", { skip: !RUN }, async () => {
  const isolated = await startPostgres17();
  const { client } = isolated;
  try {
    await client.query(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE SCHEMA app_private;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
      CREATE TABLE public.personas (id_persona uuid PRIMARY KEY);
      CREATE TABLE public.usuarios (
        id_usuario uuid PRIMARY KEY REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
        id_persona uuid UNIQUE REFERENCES public.personas(id_persona),
        estado boolean NOT NULL DEFAULT true,
        estado_acceso text NOT NULL DEFAULT 'activo',
        deleted_at timestamptz
      );
      ALTER TABLE public.usuarios RENAME CONSTRAINT usuarios_id_usuario_fkey TO fk_usuario_auth;
      CREATE FUNCTION public.fn_bloquear_delete_fisico() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='DELETE fisico bloqueado';
      END;
      $$;
      CREATE TRIGGER trg_bloquear_delete_usuarios
        BEFORE DELETE ON public.usuarios
        FOR EACH ROW EXECUTE FUNCTION public.fn_bloquear_delete_fisico();
      CREATE TABLE public.clientes (id_cliente uuid PRIMARY KEY, id_persona uuid UNIQUE REFERENCES public.personas(id_persona));
      CREATE TABLE public.empleados (id_empleado uuid PRIMARY KEY, id_persona uuid REFERENCES public.personas(id_persona));
      CREATE TABLE public.bitacoras (
        id_bitacora uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tabla text NOT NULL,
        registro_id uuid,
        accion text NOT NULL,
        descripcion text,
        datos_antes jsonb,
        datos_despues jsonb,
        id_usuario uuid
      );
    `);

    const migration = await readFile(
      new URL("../db/migrations/20261109201526_account_deletion_prod_alignment_v1.sql", import.meta.url),
      "utf8"
    );
    await client.query(migration);

    const columns = await client.query(`
      SELECT count(*)::integer AS count
      FROM information_schema.columns
      WHERE table_schema = 'app_private' AND table_name = 'solicitudes_eliminacion_cuenta'
    `);
    assert.equal(columns.rows[0].count, 34);

    const contracts = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM pg_constraint WHERE conrelid='app_private.solicitudes_eliminacion_cuenta'::regclass) AS constraints,
        (SELECT count(*)::integer FROM pg_indexes WHERE schemaname='app_private' AND tablename='solicitudes_eliminacion_cuenta') AS indexes,
        (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid='app_private.solicitudes_eliminacion_cuenta'::regclass AND NOT tgisinternal) AS triggers,
        (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND tgname='tr_guard_masterfade_auth_user_delete' AND NOT tgisinternal) AS auth_guard,
        (SELECT confdeltype FROM pg_constraint WHERE conrelid='public.usuarios'::regclass AND conname='fk_usuario_auth') AS auth_delete_action
    `);
    assert.deepEqual(contracts.rows[0], {
      constraints: 29,
      indexes: 14,
      triggers: 2,
      auth_guard: 1,
      auth_delete_action: null
    });

    const grants = await client.query(`
      SELECT count(*)::integer AS count
      FROM information_schema.role_table_grants
      WHERE table_schema='app_private'
        AND table_name='solicitudes_eliminacion_cuenta'
        AND grantee IN ('anon','authenticated','service_role','PUBLIC')
    `);
    assert.equal(grants.rows[0].count, 0);

    const redacted = await client.query(`
      SELECT app_private.fn_redact_account_pii_jsonb_v1(
        '{"nombre":"Ana","email":"ana@example.test","nested":{"token":"secret","estado":"activo"},"items":[{"telefono":"9999","codigo":"ok"}]}'::jsonb
      ) AS value
    `);
    assert.deepEqual(redacted.rows[0].value, {
      nombre: "Cliente eliminado",
      email: null,
      nested: { token: null, estado: "activo" },
      items: [{ telefono: null, codigo: "ok" }]
    });
    assert.equal((await client.query("SELECT app_private.fn_redact_account_pii_jsonb_v1(NULL::jsonb) AS value")).rows[0].value, null);
    const redactorAcl = await client.query(`
      SELECT p.proacl::text AS acl, p.provolatile, p.proisstrict, p.prosecdef
      FROM pg_proc p
      WHERE p.oid='app_private.fn_redact_account_pii_jsonb_v1(jsonb)'::regprocedure
    `);
    assert.deepEqual(redactorAcl.rows[0], {
      acl: "{postgres=X/postgres}",
      provolatile: "i",
      proisstrict: true,
      prosecdef: false
    });

    const person = "11111111-1111-4111-8111-111111111111";
    const clientId = "22222222-2222-4222-8222-222222222222";
    await client.query("INSERT INTO public.personas(id_persona) VALUES ($1)", [person]);
    await client.query("INSERT INTO public.clientes(id_cliente,id_persona) VALUES ($1,$2)", [clientId, person]);
    const inserted = await client.query(`
      INSERT INTO app_private.solicitudes_eliminacion_cuenta
        (tipo_sujeto,id_persona,id_cliente,modo_proceso,requiere_aprobacion,origen_codigo,idempotency_key,execution_token_hash,execution_token_issued_at,execution_token_expires_at)
      VALUES ('cliente',$1,$2,'autonomo',false,'cliente','account-delete-0000000001',repeat('a',64),now(),now()+interval '15 minutes')
      RETURNING id_solicitud
    `, [person, clientId]);
    const requestId = inserted.rows[0].id_solicitud;

    const audit = await client.query("SELECT datos_despues FROM public.bitacoras WHERE registro_id=$1", [requestId]);
    assert.equal(audit.rowCount, 1);
    assert.equal(Object.hasOwn(audit.rows[0].datos_despues, "execution_token_hash"), false);

    await assert.rejects(
      client.query("UPDATE app_private.solicitudes_eliminacion_cuenta SET id_cliente=NULL WHERE id_solicitud=$1", [requestId]),
      /identidad inmutable/
    );
    await assert.rejects(
      client.query("DELETE FROM app_private.solicitudes_eliminacion_cuenta WHERE id_solicitud=$1", [requestId]),
      /historicas y no pueden eliminarse/
    );

    const authUser = "33333333-3333-4333-8333-333333333333";
    const authPerson = "44444444-4444-4444-8444-444444444444";
    await client.query("INSERT INTO auth.users(id) VALUES ($1)", [authUser]);
    await client.query("INSERT INTO public.personas(id_persona) VALUES ($1)", [authPerson]);
    await client.query("INSERT INTO public.usuarios(id_usuario,id_persona) VALUES ($1,$2)", [authUser, authPerson]);
    await assert.rejects(
      client.query("DELETE FROM auth.users WHERE id=$1", [authUser]),
      /AUTH_USER_DELETE_REQUIRES_INTERNAL_DEACTIVATION/
    );
    await client.query("UPDATE public.usuarios SET estado=false,estado_acceso='inactivo',deleted_at=now() WHERE id_usuario=$1", [authUser]);
    await client.query("DELETE FROM auth.users WHERE id=$1", [authUser]);
    assert.equal((await client.query("SELECT count(*)::integer AS count FROM public.usuarios WHERE id_usuario=$1", [authUser])).rows[0].count, 1);
    await assert.rejects(
      client.query("INSERT INTO public.usuarios(id_usuario,id_persona) VALUES ($1,$2)", ["55555555-5555-4555-8555-555555555555", authPerson]),
      /USUARIO_AUTH_LINK_NOT_FOUND/
    );
  } finally {
    await isolated.stop();
  }
});
