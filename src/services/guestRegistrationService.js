import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../utils/errors.js';

const neutral = { pending_verification: true, message: 'Si es posible continuar, recibirás un enlace para confirmar tu correo. Revisa tu bandeja de entrada.' };
const fail = (status = 409, code = 'AUTH_REGISTER_EMAIL_EXISTS', reason = 'REGISTRATION_UNAVAILABLE') => {
  const error = new AppError(status,
    status === 410 ? 'El enlace expiró. Solicita uno nuevo.' : 'No se pudo completar el registro. Solicita un nuevo enlace o utiliza el acceso existente.', { code });
  error.registrationReason = reason;
  return error;
};
const digest = value => createHash('sha256').update(value).digest('hex');

export async function classifyRegistrationEmail(db, email, operation = null, lock = false) {
  const identities = await db.query(`SELECT id, raw_app_meta_data FROM auth.users WHERE lower(email::text) = lower($1)`, [email]);
  if (!operation && identities.rows.length === 1 && identities.rows[0].raw_app_meta_data?.guest_registration_id) {
    const pending = await db.query(`SELECT * FROM app_private.guest_registration_requests
      WHERE auth_user_id=$1 AND email=$2 AND state='pending'`, [identities.rows[0].id, email]);
    operation = pending.rows[0] || null;
  }
  const owned = identities.rows.length === 1 && operation
    && identities.rows[0].id === operation.auth_user_id
    && identities.rows[0].raw_app_meta_data?.guest_registration_id === operation.id;
  const contacts = await db.query(`
    SELECT co.id_correo, co.id_persona, co.deleted_at, co.verificado,
      p.deleted_at AS persona_deleted, p.id_persona AS persona_exists,
      EXISTS(SELECT 1 FROM public.usuarios u WHERE u.id_persona = co.id_persona) AS has_user,
      EXISTS(SELECT 1 FROM public.clientes c WHERE c.id_persona = co.id_persona) AS has_client,
      EXISTS(SELECT 1 FROM public.empleados e WHERE e.id_persona = co.id_persona) AS has_employee,
      EXISTS(SELECT 1 FROM public.sucursales s WHERE s.id_correo = co.id_correo) AS has_branch
    FROM public.correos co LEFT JOIN public.personas p ON p.id_persona = co.id_persona
    WHERE lower(co.direccion_correo::text) = lower($1)
    ${lock ? 'FOR UPDATE OF co' : ''}`, [email]);
  if (identities.rows.length && !owned) throw fail(409, 'AUTH_REGISTER_EMAIL_EXISTS',
    contacts.rows.some(c => c.has_user && (c.has_client || c.has_employee)) ? 'REGISTERED_IDENTITY' : 'AUTH_IDENTITY_INCOMPLETE');
  if (!contacts.rows.length && !identities.rows.length) return null;
  if (contacts.rows.length !== 1) throw fail(409, 'AUTH_REGISTER_EMAIL_EXISTS', 'AMBIGUOUS_CONTACT');
  const contact = contacts.rows[0];
  if (!contact.persona_exists || contact.deleted_at || contact.persona_deleted
    || contact.has_user || contact.has_client || contact.has_employee || contact.has_branch) {
    throw fail(409, 'AUTH_REGISTER_EMAIL_EXISTS', contact.has_branch ? 'BRANCH_CONTACT'
      : contact.deleted_at || contact.persona_deleted ? 'DELETED_CONTACT'
        : contact.has_user || contact.has_client || contact.has_employee ? 'INTERNAL_IDENTITY' : 'PROTECTED_CONTACT');
  }
  return contact;
}

// AM: Reassignment must not remove the only authorization evidence from any historical group.
export async function assertGuestHistorySafe(db, contact, email) {
  const { rows } = await db.query(`
    SELECT cg.id_grupo_cita, c.id_cita, c.id_persona_cliente, c.contacto_email,
      c.id_cita_integrante, ci.id_cita_integrante AS snapshot_id,
      ci.id_persona AS snapshot_persona, ci.orden_integrante AS snapshot_order,
      ci.rol_integrante_codigo AS snapshot_role, ci.contacto_email_snapshot,
      (SELECT count(*) FROM public.citas x WHERE x.id_grupo_cita = cg.id_grupo_cita
        AND x.deleted_at IS NULL AND x.orden_integrante = 1) AS titular_count,
      EXISTS(SELECT 1 FROM public.citas x JOIN public.citas_integrantes i ON i.id_cita_integrante=x.id_cita_integrante
        AND i.id_grupo_cita=cg.id_grupo_cita WHERE x.id_grupo_cita=cg.id_grupo_cita AND x.deleted_at IS NULL
        AND x.orden_integrante<>1 AND (i.orden_integrante=1 OR i.rol_integrante_codigo='titular')) AS conflicting_titular
    FROM public.citas_grupos cg
    LEFT JOIN public.citas c ON c.id_grupo_cita = cg.id_grupo_cita AND c.deleted_at IS NULL AND c.orden_integrante = 1
    LEFT JOIN public.citas_integrantes ci ON ci.id_cita_integrante = c.id_cita_integrante AND ci.id_grupo_cita = cg.id_grupo_cita
    WHERE cg.id_persona_titular = $1::uuid`, [contact.id_persona]);
  for (const row of rows) {
    const emails = [row.contacto_email, row.contacto_email_snapshot].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
    if (row.conflicting_titular || Number(row.titular_count) !== 1 || row.id_persona_cliente !== contact.id_persona || !emails.length
      || emails.some(value => value !== email) || (row.id_cita_integrante
        && (row.snapshot_id !== row.id_cita_integrante || row.snapshot_persona !== contact.id_persona
          || Number(row.snapshot_order) !== 1 || row.snapshot_role !== 'titular'))) throw fail();
  }
}

export async function requestGuestRegistration(app, email) {
  if (!app.mailer?.configured) throw fail(503, 'AUTH_REGISTER_TEMPORARY');
  const base = new URL(process.env.FRONTEND_URL || '');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw fail(503);
  const client = await app.db.connect();
  let token, operation;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ['guest-register:' + email]);
    const current = await client.query('SELECT * FROM app_private.guest_registration_requests WHERE email = $1 FOR UPDATE', [email]);
    operation = current.rows[0];
    if (operation?.state === 'completed' || (operation && Date.now() - new Date(operation.last_sent_at).getTime() < 60000)) {
      await client.query('COMMIT'); return neutral;
    }
    const contact = await classifyRegistrationEmail(client, email, operation);
    if (!contact) { await client.query('COMMIT'); return neutral; }
    await assertGuestHistorySafe(client, contact, email);
    token = randomBytes(32).toString('hex');
    if (operation) {
      if (operation.id_correo !== contact.id_correo || operation.original_persona_id !== contact.id_persona) throw fail();
      await client.query(`UPDATE app_private.guest_registration_requests SET token_hash=$2, expires_at=now()+interval '30 minutes', last_sent_at=now() WHERE id=$1`, [operation.id, digest(token)]);
    } else {
      operation = { id: randomUUID(), auth_user_id: randomUUID() };
      await client.query(`INSERT INTO app_private.guest_registration_requests
        (id,email,id_correo,original_persona_id,auth_user_id,token_hash,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,
      [operation.id, email, contact.id_correo, contact.id_persona, operation.auth_user_id, digest(token)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '42P01') throw fail(503, 'AUTH_REGISTER_TEMPORARY');
    throw error;
  } finally { client.release(); }
  const link = new URL('/register/confirm', base);
  link.hash = new URLSearchParams({ operation: operation.id, token }).toString();
  const delivery = await app.mailer.sendMail({ to: email, subject: 'Confirma tu registro en MASTERFADE',
    text: `Confirma tu correo y elige tu contraseña final. El enlace vence en 30 minutos. Si no deseas crear una cuenta, ignora este mensaje.\n${link.href}` });
  if (!delivery?.sent) throw fail(503, 'AUTH_REGISTER_TEMPORARY');
  return neutral;
}

export async function completeGuestRegistration(app, body, createClient) {
  if (!/^[a-f0-9]{64}$/.test(String(body.token || ''))) throw fail(401, 'AUTH_REGISTER_LINK_INVALID');
  const client = await app.db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM app_private.guest_registration_requests WHERE id=$1 FOR UPDATE', [body.operation]);
    const op = result.rows[0];
    if (!op || !timingSafeEqual(Buffer.from(op.token_hash, 'hex'), Buffer.from(digest(body.token), 'hex'))) throw fail(401, 'AUTH_REGISTER_LINK_INVALID');
    if (new Date(op.expires_at).getTime() <= Date.now()) throw fail(410, 'AUTH_REGISTER_LINK_EXPIRED');
    if (op.state === 'completed') { await client.query('COMMIT'); return { registered: true }; }
    await client.query('SELECT id_persona FROM public.personas WHERE id_persona=$1 FOR UPDATE', [op.original_persona_id]);
    const contact = await classifyRegistrationEmail(client, op.email, op, true);
    if (!contact || contact.id_correo !== op.id_correo || contact.id_persona !== op.original_persona_id) throw fail();
    await assertGuestHistorySafe(client, contact, op.email);
    const admin = app.supabaseAdmin.auth.admin;
    let lookup = await admin.getUserById(op.auth_user_id);
    let authUser = lookup.data?.user;
    const recovering = Boolean(authUser);
    if (lookup.error && lookup.error.status !== 404 && lookup.error.code !== 'user_not_found') throw fail(503);
    if (!authUser) {
      const created = await admin.createUser({ id: op.auth_user_id, email: op.email, password: body.contrasena,
        email_confirm: true, app_metadata: { guest_registration_id: op.id } });
      if (created.error || !created.data?.user) throw fail(503);
      authUser = created.data.user;
    }
    if (authUser.id !== op.auth_user_id || String(authUser.email).toLowerCase() !== op.email
      || authUser.app_metadata?.guest_registration_id !== op.id || authUser.deleted_at
      || (authUser.banned_until && new Date(authUser.banned_until).getTime() > Date.now())) throw fail(409);
    if (recovering) {
      const updated = await admin.updateUserById(op.auth_user_id, { password: body.contrasena });
      if (updated.error) throw fail(503);
    }
    const persona = await client.query('INSERT INTO public.personas (nombres,apellidos) VALUES ($1,$2) RETURNING id_persona', [body.nombres.trim(), body.apellidos.trim()]);
    const personaId = persona.rows[0].id_persona;
    await client.query(`INSERT INTO public.usuarios (id_usuario,id_persona,estado,estado_acceso,credenciales_completadas_at)
      VALUES ($1,$2,TRUE,'activo',now())`, [op.auth_user_id, personaId]);
    const role = await client.query("SELECT id_rol FROM public.roles WHERE nombre='cliente'", []);
    if (role.rows.length !== 1) throw fail(503);
    await client.query('INSERT INTO public.roles_usuarios (id_rol,id_usuario,id_sucursal,activo) VALUES ($1,$2,NULL,TRUE)', [role.rows[0].id_rol, op.auth_user_id]);
    const now = new Date().toISOString();
    const clienteId = await createClient(client, { idPersona: personaId, authUserId: op.auth_user_id, branchId: null,
      aceptaTerminos: true, aceptaTerminosAt: now, consentimientoMarketing: body.consentimiento_marketing === true,
      consentimientoMarketingAt: body.consentimiento_marketing === true ? now : null });
    const moved = await client.query(`UPDATE public.correos SET id_persona=$2,verificado=TRUE,es_principal=TRUE
      WHERE id_correo=$1 AND id_persona=$3 AND deleted_at IS NULL RETURNING id_correo`, [op.id_correo, personaId, op.original_persona_id]);
    if (moved.rowCount !== 1) throw fail();
    await client.query(`UPDATE app_private.guest_registration_requests SET state='completed',email=NULL,result_persona_id=$2,
      result_cliente_id=$3,completed_at=now() WHERE id=$1`, [op.id, personaId, clienteId]);
    await client.query('COMMIT');
    return { registered: true };
  } catch (error) {
    // AM: The preallocated Auth UUID and server-owned metadata allow recovery after rollback or an ambiguous timeout.
    // AM: Never delete Auth by email or assume that an unsuccessful HTTP response means Auth was not created.
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally { client.release(); }
}
