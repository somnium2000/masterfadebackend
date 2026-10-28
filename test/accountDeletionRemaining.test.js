// AM: Regresiones funcionales aisladas: ninguna llamada usa Supabase ni PostgreSQL reales.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyRecentAccountDeletionReauthentication,
  verifyRecentInternalAccountDeletionReauthentication,
  verifyRecentAdminAccountDeletionReauthentication,
  runApprovedInternalAccountDeletionAuthCleanup,
  finalizeApprovedInternalAccountDeletionAuthCleanup,
  retryAdminAccountDeletionRequest,
  evaluateAdminInternalAccountDeletionDependencies,
  anonymizeApprovedInternalAccountDeletion,
} from '../src/services/accountDeletionService.js';
import { recoverMembershipPixelPayApproval } from '../src/services/membershipService.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = id(1), PERSON = id(2), REQUEST = id(3), EMPLOYEE = id(4);
const absent = { status: 404, code: 'user_not_found', message: 'User not found' };
const now = () => Math.floor(Date.now() / 1000);
const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

// AM: getUser simula verificacion criptografica previa; AMR e iat son entradas diferentes.
for (const verify of [verifyRecentAccountDeletionReauthentication,
  verifyRecentInternalAccountDeletionReauthentication, verifyRecentAdminAccountDeletionReauthentication]) {
  const check = (amr, user = {}, sub = USER) => verify({ supabaseAdmin: { auth: {
    getUser: async () => ({ data: { user: { id: USER, ...user } } }),
  } } }, { reauthToken: jwt({ sub, iat: now(), amr }), expectedUserId: USER });
  test(`AM: ${verify.name}: password reciente`, async () => {
    assert.ok(await check([{ method: 'password', timestamp: now() }]));
  });
  test(`AM: ${verify.name}: Google reciente`, async () => {
    assert.ok(await check([{ method: 'oauth', timestamp: now() }], { identities: [{ provider: 'google' }] }));
  });
  test(`AM: ${verify.name}: refresh no renueva autenticacion`, async () => {
    await assert.rejects(check([{ method: 'password', timestamp: now() - 900 },
      { method: 'token_refresh', timestamp: now() }]), error => error.statusCode === 401);
  });
  for (const amr of [undefined, [], [{ method: 'token_refresh', timestamp: now() }],
    [{ method: 'password', timestamp: now() + 900 }], [{ method: 'password', timestamp: '1' }],
    [{ method: 'oauth', timestamp: now() }]]) {
    test(`AM: ${verify.name}: evidencia invalida ${JSON.stringify(amr)}`, async () => {
      await assert.rejects(check(amr), error => error.statusCode === 401);
    });
  }
  test(`AM: ${verify.name}: sujeto manipulado`, async () => {
    await assert.rejects(check([{ method: 'password', timestamp: now() }], {}, id(99)),
      error => error.statusCode === 401 || error.statusCode === 403);
  });
}

// AM: Estado transaccional separado del estado Auth, incluyendo COMMIT de respuesta perdida.
function fixture({ ready = true, exists = true, remove = true, deleteThrows = false,
  lookupError, ambiguousCommit = false, state = 'auth_pendiente', type = 'personal', roles = [], protectedUser = false } = {}) {
  let request = { id_solicitud: REQUEST, tipo_sujeto: type, id_usuario: USER, id_persona: PERSON,
    id_empleado: EMPLOYEE, id_cliente: id(5), estado_codigo: state, active_roles: roles,
    decision_codigo: 'aprobada', decision_at: new Date(), decision_por: id(6), resumen_impacto: {} };
  let pending, inTransaction = false, lost = false;
  let lockTail = Promise.resolve();
  const calls = [], authCalls = [];
  const app = { db: { connect: async () => { let releaseLock; return ({
    release() {},
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_unlock')) { releaseLock?.(); return { rows: [] }; }
      if (sql.includes('pg_advisory_lock')) {
        const previous = lockTail; lockTail = new Promise(resolve => { releaseLock = resolve; });
        await previous; return { rows: [] };
      }
      if (sql.startsWith('BEGIN')) { inTransaction = true; return { rows: [] }; }
      if (sql === 'ROLLBACK') { pending = undefined; inTransaction = false; return { rows: [] }; }
      if (sql === 'COMMIT') {
        inTransaction = false;
        if (pending) { request = pending; pending = undefined;
          if (ambiguousCommit && !lost) { lost = true; throw new Error('lost reply'); } }
        return { rows: [] };
      }
      if (sql.includes('AS internal_auth_ready')) return { rows: [{ internal_auth_ready: ready }] };
      if (sql.includes('FROM public.app_protected_users')) return { rows: protectedUser ? [{}] : [], rowCount: protectedUser ? 1 : 0 };
      if (sql.includes('UPDATE app_private.solicitudes_eliminacion_cuenta')) {
        if (sql.includes("estado_codigo = 'completada'")) {
          pending = { ...request, estado_codigo: 'completada', resumen_impacto: JSON.parse(params[1]) };
          return { rows: [pending], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM app_private.solicitudes_eliminacion_cuenta')) return { rows: [request] };
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  }); } }, supabaseAdmin: { auth: { admin: {
    async getUserById(userId) {
      assert.equal(inTransaction, false); assert.equal(userId, USER); authCalls.push('lookup');
      return { data: { user: exists ? { id: USER } : null }, error: lookupError || (!exists ? absent : null) };
    },
    async deleteUser(userId, soft) {
      assert.equal(inTransaction, false); assert.equal(userId, USER); assert.equal(soft, false); authCalls.push('delete');
      if (remove) exists = false;
      if (deleteThrows) throw new Error('lost delete response');
      return { error: null };
    },
  } } } };
  return { app, calls, authCalls, get request() { return request; },
    run: () => runApprovedInternalAccountDeletionAuthCleanup(app, { deletionRequestId: REQUEST }) };
}

test('AM: personal hard delete exige ausencia y no mantiene transaccion externa', async () => {
  const f = fixture(); assert.equal((await f.run()).completed, true);
  assert.deepEqual(f.authCalls, ['lookup', 'delete', 'lookup']);
  assert.equal(f.request.estado_codigo, 'completada');
});
test('AM: respuesta optimista de Auth no completa si usuario sigue presente', async () => {
  const f = fixture({ remove: false });
  await assert.rejects(f.run(), { code: 'ADMIN_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE' });
  assert.equal(f.request.estado_codigo, 'auth_pendiente');
});
for (const error of [{ status: 404, message: 'missing' }, { status: 500, message: 'User not found' }]) {
  test(`AM: lookup ambiguo ${error.status} conserva pendiente`, async () => {
    const f = fixture({ lookupError: error }); await assert.rejects(f.run());
    assert.equal(f.request.estado_codigo, 'auth_pendiente'); assert.equal(f.authCalls.includes('delete'), false);
  });
}
test('AM: ya ausente y respuesta perdida de delete son recuperables', async () => {
  for (const options of [{ exists: false }, { deleteThrows: true }]) {
    const f = fixture(options); assert.equal((await f.run()).completed, true);
    assert.equal((await f.run()).idempotent_replay, true);
    assert.ok(f.authCalls.filter(c => c === 'delete').length <= 1);
  }
});
test('AM: precondicion invalida no toca Auth', async () => {
  const f = fixture({ ready: false });
  await assert.rejects(f.run(), { code: 'ADMIN_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED' });
  assert.deepEqual(f.authCalls, []); assert.equal(f.request.estado_codigo, 'auth_pendiente');
});
test('AM: COMMIT confirmado con respuesta perdida conserva terminal', async () => {
  const f = fixture({ ambiguousCommit: true }); assert.equal((await f.run()).completed, true);
  assert.equal(f.request.estado_codigo, 'completada');
  assert.equal(f.authCalls.filter(c => c === 'delete').length, 1);
});
// AM: Dos ejecutores reales comparten el lock simulado y una sola identidad Auth.
test('AM: doble ejecucion concurrente elimina Auth una sola vez', async () => {
  const f = fixture();
  const results = await Promise.all([f.run(), f.run()]);
  assert.ok(results.every(result => result.completed));
  assert.equal(f.authCalls.filter(c => c === 'delete').length, 1);
});
test('AM: finalizador no acepta completar sin evidencia Auth', async () => {
  await assert.rejects(finalizeApprovedInternalAccountDeletionAuthCleanup({ query() { throw new Error('must not write'); } },
    { deletionRequestId: REQUEST }), { code: 'ADMIN_ACCOUNT_DELETION_AUTH_VERIFICATION_REQUIRED' });
});

// AM: Las autorizaciones se ejercitan sobre el reintento real, no listas constantes de roles.
const actor = { usuarioId: id(8), roles: ['super_admin'], highestRank: 90 };
for (const options of [{ protectedUser: true }, { roles: ['root'] }, { roles: ['super_admin'] }]) {
  test(`AM: reintento protege identidad ${JSON.stringify(options)}`, async () => {
    const f = fixture(options); await assert.rejects(retryAdminAccountDeletionRequest(f.app, { requestId: REQUEST, actor }));
    assert.deepEqual(f.authCalls, []);
  });
}
for (const unsafeActor of [{ ...actor, usuarioId: USER }, { ...actor, roles: ['security_auditor'] },
  { ...actor, roles: ['cliente'], highestRank: 0 }]) {
  test(`AM: actor no autorizado ${unsafeActor.roles}`, async () => {
    const f = fixture(); await assert.rejects(retryAdminAccountDeletionRequest(f.app, { requestId: REQUEST, actor: unsafeActor }));
    assert.deepEqual(f.authCalls, []);
  });
}
test('AM: reintento completado no repite etapas', async () => {
  const f = fixture({ state: 'completada' });
  assert.equal((await retryAdminAccountDeletionRequest(f.app, { requestId: REQUEST, actor })).completed, true);
  assert.deepEqual(f.authCalls, []);
});
test('AM: identidad compartida bloquea incluso sin empleado activo', async () => {
  const result = await evaluateAdminInternalAccountDeletionDependencies({ async query(sql) {
    if (sql.includes('AS shared_client_identity')) return { rows: [{ shared_client_identity: true }] };
    if (sql.includes('SELECT id_empleado')) return { rows: [] };
    throw new Error('Unexpected dependency query');
  } }, { personaId: PERSON, usuarioId: USER });
  assert.ok(result.blocking_reasons.some(reason => reason.code === 'INTERNAL_ACCOUNT_DELETION_SHARED_IDENTITY'));
});
test('AM: anonimizar limita bitacoras por entidad y conserva acciones sobre terceros', async () => {
  const f = fixture({ state: 'procesando' }), client = await f.app.db.connect(), captured = [];
  await anonymizeApprovedInternalAccountDeletion({ async query(sql, params) {
    captured.push({ sql, params });
    if (sql.includes('SELECT id_correo')) return { rows: [] };
    if (sql.includes('SELECT id_empleado')) return { rows: [{ id_empleado: EMPLOYEE }, { id_empleado: id(7) }] };
    if (/UPDATE public\.(personas|bitacoras|seguridad_audit_logs)/.test(sql)) return { rows: [], rowCount: 1 };
    if (sql.includes('SET estado_codigo = $2')) return { rows: [{ estado_codigo: params[1] }] };
    return client.query(sql, params);
  } }, { deletionRequestId: REQUEST });
  const audit = captured.find(c => c.sql.includes('UPDATE public.bitacoras'));
  assert.doesNotMatch(audit.sql.split('WHERE')[1], /id_usuario/);
  assert.deepEqual(audit.params, [PERSON, USER, [EMPLOYEE, id(7)]]);
  assert.match(audit.sql, /fn_redact_account_pii_jsonb_v1/);
  const security = captured.find(c => c.sql.includes('UPDATE public.seguridad_audit_logs'));
  assert.match(security.sql, /ELSE metadata END/);
  assert.equal(captured.some(c => /UPDATE public\.(citas|payments|subscriptions)/.test(c.sql)), false);
});
// AM: Diagnostico de dependencia fuera de alcance; intercepta antes de cualquier escritura simulada.
test('AM: pagos conserva evidencia y rechaza recuperar cuenta eliminada', async () => {
  const intent = id(20), order = id(21), customer = id(22), calls = [];
  const row = { id_intent: intent, id_membership_order: order, id_order: order, id_cliente: customer,
    estado_intent_codigo: 'expirado', estado_orden_codigo: 'cancelada', provider_code: 'pixelpay',
    monto_hnl: 100, moneda_codigo: 'HNL', origen_pago_codigo: 'membership', id_sucursal: id(23),
    intent_expires_at: '2026-01-02T00:00:00Z', order_expires_at: '2026-01-02T00:00:00Z',
    verified_at: '2026-01-01T00:00:00Z',
    plan_snapshot: { beneficios: {}, periodo_membresia_codigo: 'mensual' },
    payload_esencial: { id_intent: intent, id_order: order, provider: 'pixelpay', payment_hash_valid: true,
      amount_matches: true, amount: 100, currency: 'HNL', payment_uuid: 'synthetic', transaction_id: 'synthetic' } };
  const stopCode = 'MEMBERSHIP_PAYMENT_ACCOUNT_UNAVAILABLE';
  await assert.rejects(recoverMembershipPixelPayApproval({ async query(sql) {
    calls.push(sql);
    if (sql.includes('AS deletion_identity_lock')) return { rows: [{ deletion_identity_lock: true }] };
    if (sql.includes('AS cliente_activo')) return { rows: [{ cliente_activo: false, cliente_deleted_at: new Date(), anonimizado: true, usuario_activo: false, estado_acceso: 'inactivo', eliminacion_en_curso: true }] };
    if (sql.includes('FROM public.payment_intents pi')) return { rows: [row] };
    throw new Error('Unexpected recovery query');
  } }, { idPaymentIntent: intent, clienteId: customer }), error => error.code === stopCode);
  assert.equal(calls.some(sql => /UPDATE|INSERT|DELETE/.test(sql.split('FOR UPDATE')[0])), false);
  assert.ok(calls.some(sql => sql.includes('FOR UPDATE OF c, u')));
});
