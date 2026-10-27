// AM: Regresiones funcionales del Storage personal; solo DB y Storage sinteticos.
import test from 'node:test';
import assert from 'node:assert/strict';
// AM: Generar fixtures con el constructor y scope oficiales.
import { buildStorageObjectPath } from '../src/services/storage/storagePath.js';
import { getStorageScope } from '../src/services/storage/storageScopes.js';
// AM: Las carreras usan los escritores reales de Storage.
import { bindAndActivateAsset, markAssetStatus } from '../src/services/storage/storageAssetsRepo.js';
import { replaceAssetIfNeeded, resolveAssetForBinding } from '../src/services/storage/storageService.js';
import {
  selectApprovedInternalAccountDeletionStorageAssets,
  runApprovedInternalAccountDeletionStorageCleanup,
  finalizeApprovedInternalAccountDeletionStorage,
  anonymizeApprovedInternalAccountDeletion,
} from '../src/services/accountDeletionService.js';

// AM: Identidades aisladas, sin tokens, red ni credenciales.
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PERSON = ID(1), USER = ID(2), EMPLOYEE = ID(3), REQUEST = ID(4), BRANCH = ID(5);
const ownAsset = (n = 6, overrides = {}) => ({
  id_asset: ID(n), scope_key: 'public_barber_profile', entity_type: 'barbero',
  entity_id: EMPLOYEE, id_sucursal: BRANCH, owner_user_id: ID(99), owner_cliente_id: null,
  bucket_name: 'imagenes_publicas', object_path: buildStorageObjectPath(getStorageScope('public_barber_profile'), { branchId: BRANCH, contentType: 'image/png', label: `perfil-${n}` }),
  public_url: `https://synthetic.invalid/${n}.png`, visibility: 'public', status: 'activo', deleted_at: null,
  ...overrides,
});

// AM: Doble transaccional estricto; rechaza consultas no previstas y serializa conexiones.
function fixture({ assets = [ownAsset()], captured, shared = [], existing, legacy = false,
  state = 'storage_pendiente', removeMode = 'success', failCommit = false, references = [], photoAssetId = null, photoPath = null, ambiguousCommitAt = null, disconnectAtCommit = null } = {}) {
  const request = {
    id_solicitud: REQUEST, referencia_publica: 'DEL-ABCDEF123456', tipo_sujeto: 'personal',
    id_usuario: USER, id_persona: PERSON, id_empleado: EMPLOYEE,
    decision_codigo: 'aprobada', decision_at: new Date(), decision_por: ID(90),
    estado_codigo: state, usuario_estado: false, estado_acceso: 'inactivo', usuario_deleted_at: new Date(),
    resumen_impacto: { internal_anonymization: { storage_asset_ids: captured ?? assets.map(a => a.id_asset) } },
  };
  // AM: El doble fisico diferencia buckets aunque las rutas sean iguales.
  const physical = new Set(existing === undefined ? assets.map(a => `${a.bucket_name}/${a.object_path}`)
    : existing.map(path => `imagenes_publicas/${path}`));
  const objects = {
    has(path, bucket = 'imagenes_publicas') { return physical.has(`${bucket}/${path}`); },
    add(path, bucket = 'imagenes_publicas') { physical.add(`${bucket}/${path}`); },
    delete(path, bucket = 'imagenes_publicas') { physical.delete(`${bucket}/${path}`); },
  };
  const removals = [], queries = [], updated = [];
  let tail = Promise.resolve(), released = 0, commits = 0;
  const app = {
    supabaseAdmin: { storage: { from(bucket) { return { async remove(paths) {
      assert.equal(bucket, 'imagenes_publicas');
      assert.equal(activeTransactions(), 0, 'AM: Storage fuera de transacciones');
      removals.push(...paths);
      // AM: Excepcion antes de borrar tambien debe conservar el estado recuperable.
      if (removeMode === 'throw') throw new Error('AM: fallo de transporte');
      if (removeMode === 'error' || (removeMode === 'partial' && paths[0] === assets[1]?.object_path)) {
        return { error: { code: 'STORAGE_TEST_FAILURE' } };
      }
      if (removeMode !== 'false_success') for (const path of paths) objects.delete(path, bucket);
      if (removeMode === 'lost_response') throw new Error('AM: respuesta perdida despues del borrado');
      return { error: null };
    } }; } } },
    db: { async connect() {
      const connection = { transaction: false, queued: [], unlock: null, disconnected: false,
        release(error) {
          released++; assert.equal(connection.transaction, false);
          if (connection.disconnected) { assert.ok(error instanceof Error); connection.unlock?.(); connection.unlock = null; }
          else assert.equal(error, undefined);
        },
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (connection.disconnected) throw new Error('AM: conexion interrumpida');
          if (sql.includes('pg_advisory_unlock')) { connection.unlock(); connection.unlock = null; return { rows: [] }; }
          if (sql.includes('pg_advisory_lock')) {
            const prior = tail;
            tail = new Promise(resolve => { connection.unlock = resolve; });
            await prior;
            return { rows: [] };
          }
          if (sql.startsWith('BEGIN')) { connection.transaction = true; return { rows: [] }; }
          if (sql === 'COMMIT') {
            commits++;
            if (failCommit && commits === 2) { failCommit = false; throw new Error('AM: commit interrumpido'); }
            for (const change of connection.queued) change();
            connection.queued = []; connection.transaction = false;
            if (commits === disconnectAtCommit) { connection.disconnected = true; throw new Error('AM: conexion perdida tras COMMIT'); }
            if (commits === ambiguousCommitAt) throw new Error('AM: respuesta de COMMIT perdida');
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') { connection.queued = []; connection.transaction = false; return { rows: [] }; }
          if (sql.includes('FROM app_private.solicitudes_eliminacion_cuenta')) return { rows: [structuredClone(request)] };
          if (sql.includes('has_super_admin')) return { rows: [{ id_empleado: EMPLOYEE, id_sucursal: BRANCH, has_super_admin: false, is_protected: false }] };
          if (sql.includes('FROM public.empleados') && sql.includes('SELECT id_empleado')) return { rows: [{ id_empleado: EMPLOYEE }] };
          if (sql.includes('AS employee_matches')) {
            assert.match(sql, /public\.clientes/);
            const asset = assets.find(a => a.id_asset === params[0]);
            return { rows: [{ employee_matches: asset?.entity_id === EMPLOYEE && asset.id_sucursal === BRANCH,
              shared_reference: shared.includes(params[0]) }] };
          }
          if (sql.includes('AS reference_persona_id')) {
            assert.match(sql, /LEFT JOIN public\.storage_assets linked/);
            assert.match(sql, /FROM public\.promociones/);
            return { rows: references.map(reference => {
              const linked = assets.find(a => a.id_asset === reference.reference_asset_id);
              return { ...reference, reference_bucket: linked?.bucket_name ?? null, resolved_path: linked?.object_path ?? null };
            }) };
          }
          if (sql.includes('AS path_ambiguous')) {
            const buckets = new Set(assets.filter(a => a.object_path === params[0]).map(a => a.bucket_name));
            for (const key of physical) if (key.endsWith(`/${params[0]}`)) buckets.add(key.slice(0, -params[0].length - 1));
            return { rows: [{ path_ambiguous: buckets.size !== 1 }] };
          }
          if (sql.includes('AS unresolved_photo')) return { rows: [{ unresolved_photo: legacy
            || (photoAssetId !== null ? !assets.some(a => a.id_asset === photoAssetId)
              : photoPath !== null && assets.filter(a => a.object_path === photoPath).length !== 1) }] };
          if (sql.includes('SELECT sa.* FROM public.storage_assets')) {
            assert.doesNotMatch(sql, /sa\.owner_user_id = \$2::uuid\s+OR/);
            return { rows: assets.filter(a => params[2].includes(a.entity_id)
              || (photoAssetId !== null ? a.id_asset === photoAssetId : photoPath !== null && a.object_path === photoPath)
              || (a.entity_id === null && a.scope_key === 'public_barber_profile' && a.owner_user_id === USER)) };
          }
          if (sql.includes('FROM public.storage_assets') && sql.includes('FOR UPDATE')) {
            return { rows: assets.filter(a => params[0].includes(a.id_asset)) };
          }
          if (sql.includes('FROM public.storage_assets') && sql.includes('LIMIT 1')) {
            const asset = assets.find(a => a.id_asset === params[0]);
            return { rows: asset ? [structuredClone(asset)] : [] };
          }
          if (sql.includes('FROM storage.objects')) return { rows: [{ object_absent: !objects.has(params[1], params[0]) }] };
          const mutate = fn => connection.transaction ? connection.queued.push(fn) : fn();
          if (sql.includes('UPDATE public.storage_assets') && !sql.includes('ANY($1::uuid[])')) {
            // AM: Simular la condicion vigente del UPDATE atomico, no la validacion anterior.
            assert.match(sql, /AND deleted_at IS NULL/);
            assert.match(sql, /AND NOT \(COALESCE\(metadata, '\{\}'::jsonb\) \? 'account_deletion_storage'\)/);
            const asset = assets.find(a => a.id_asset === params[0]);
            const activation = sql.includes("status = 'activo'");
            if (activation) assert.match(sql, /AND status IN \('temporal', 'activo'\)/);
            if (!asset || asset.deleted_at || asset.metadata?.account_deletion_storage
              || (activation && !['temporal', 'activo'].includes(asset.status))) return { rows: [], rowCount: 0 };
            const result = { ...asset, status: activation ? 'activo' : params[1] };
            mutate(() => Object.assign(asset, result));
            return { rows: [structuredClone(result)], rowCount: 1 };
          }
          if (sql.includes('UPDATE public.storage_assets')) {
            for (const asset of assets.filter(a => params[0].includes(a.id_asset))) {
              const deleted = sql.includes("status = 'eliminado'");
              if (deleted) assert.equal(objects.has(asset.object_path), false, 'AM: ausencia antes de marcar');
              mutate(() => { updated.push(asset.id_asset); asset.status = deleted ? 'eliminado' : 'fallido';
                if (deleted) { asset.deleted_at = new Date(); asset.public_url = null; }
                else if (sql.includes("'account_deletion_storage'")) asset.metadata = { ...asset.metadata, account_deletion_storage: { request_id: params[1], status: 'quarantined' } }; });
            }
            return { rows: [], rowCount: params[0].length };
          }
          if (sql.includes('UPDATE app_private.solicitudes_eliminacion_cuenta')) {
            if (sql.includes('SET estado_codigo = $2::text')) {
              mutate(() => { request.estado_codigo = params[1]; request.resumen_impacto = JSON.parse(params[2]); request.error_codigo = params[3]; });
              return { rows: [{ estado_codigo: params[1] }] };
            }
            mutate(() => { request.error_codigo = params[1]; request.resumen_impacto.storage_cleanup = JSON.parse(params[3]); });
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`AM: consulta inesperada ${sql.slice(0, 95)}`);
        },
      };
      connections.push(connection); return connection;
    } },
  };
  const connections = [];
  function activeTransactions() { return connections.filter(c => c.transaction && c.unlock).length; }
  return { app, request, assets, objects, removals, queries, updated, get released() { return released; },
    run: () => runApprovedInternalAccountDeletionStorageCleanup(app, { deletionRequestId: REQUEST, traceRequestId: 'synthetic' }),
    setMode(mode) { removeMode = mode; },
  };
}

test('AM: archivo propio cargado por administrador se elimina fisicamente y avanza', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.storage_processed, true); assert.equal(f.request.estado_codigo, 'auth_pendiente');
  assert.deepEqual(f.removals, [f.assets[0].object_path]); assert.equal(f.assets[0].status, 'eliminado');
  assert.equal(f.released, 1);
});
test('AM: archivo de tercero cargado por solicitante se excluye y permanece intacto', async () => {
  const third = ownAsset(7, { entity_id: ID(70), owner_user_id: USER }); const before = structuredClone(third);
  const f = fixture({ assets: [ownAsset(), third], captured: [ID(6)] });
  await f.run(); assert.deepEqual(third, before); assert.equal(f.objects.has(third.object_path), true);
  assert.deepEqual(f.updated, [ID(6), ID(6)]); assert.equal(f.removals.includes(third.object_path), false);
});
test('AM: seleccion productiva ignora archivos comerciales y terceros del cargador', async () => {
  const third = ownAsset(7, { entity_id: ID(70), owner_user_id: USER });
  const commercial = ownAsset(8, { scope_key: 'public_promotion_main', entity_id: ID(80), owner_user_id: USER });
  const f = fixture({ assets: [ownAsset(), third, commercial] }); const c = await f.app.db.connect();
  const selected = await selectApprovedInternalAccountDeletionStorageAssets(c, f.request, [EMPLOYEE]);
  assert.deepEqual(selected.map(a => a.id_asset), [ID(6)]); assert.deepEqual(f.removals, []); c.release();
});
for (const [name, overrides] of [
  ['owner_cliente_id', { owner_cliente_id: ID(77) }],
  ['scope comercial', { scope_key: 'public_promotion_main' }],
  ['entidad ajena capturada', { entity_id: ID(77), owner_user_id: USER }],
  ['sin entidad', { entity_id: null, owner_user_id: USER }],
  ['sucursal contradictoria', { id_sucursal: ID(77) }],
  ['bucket invalido', { bucket_name: 'otro' }],
  ['ruta invalida', { object_path: '../otro' }],
]) test(`AM: bloquea ${name} antes de borrar o modificar assets`, async () => {
  const asset = ownAsset(6, overrides), before = structuredClone(asset); const f = fixture({ assets: [asset] });
  assert.equal((await f.run()).storage_processed, false); assert.equal(f.request.estado_codigo, 'storage_pendiente');
  assert.deepEqual(f.removals, []); assert.deepEqual(f.updated, []); assert.deepEqual(asset, before);
  assert.ok(f.request.error_codigo);
});
test('AM: referencias compartidas bloquean todo el lote y guardan evidencia funcional', async () => {
  const f = fixture({ assets: [ownAsset(), ownAsset(7)], shared: [ID(7)] });
  await f.run(); assert.deepEqual(f.removals, []); assert.deepEqual(f.updated, []);
  assert.equal(f.request.error_codigo, 'ADMIN_ACCOUNT_DELETION_STORAGE_OWNERSHIP_AMBIGUOUS');
  assert.deepEqual(f.request.resumen_impacto.storage_cleanup.blocked_asset_ids, [ID(7)]);
});
test('AM: cuenta sin archivos avanza sin configurar Storage', async () => {
  const f = fixture({ assets: [] }); delete f.app.supabaseAdmin;
  assert.equal((await f.run()).storage_processed, true); assert.equal(f.request.estado_codigo, 'auth_pendiente');
});
test('AM: objeto ya ausente no requiere remove', async () => {
  const f = fixture({ existing: [] }); await f.run(); assert.deepEqual(f.removals, []);
  assert.equal(f.assets[0].status, 'eliminado');
});
for (const mode of ['error', 'throw', 'false_success']) test(`AM: ${mode} conserva pendientes y datos de reintento`, async () => {
  const f = fixture({ removeMode: mode }); assert.equal((await f.run()).storage_processed, false);
  assert.equal(f.request.estado_codigo, 'storage_pendiente'); assert.equal(f.assets[0].status, 'fallido');
  assert.ok(f.assets[0].object_path); assert.deepEqual(f.request.resumen_impacto.internal_anonymization.storage_asset_ids, [ID(6)]);
  assert.deepEqual(f.request.resumen_impacto.storage_cleanup.pending_asset_ids, [ID(6)]);
});
test('AM: fallo parcial y reintento no repiten borrados ya verificados', async () => {
  const f = fixture({ assets: [ownAsset(), ownAsset(7)], removeMode: 'partial' });
  assert.equal((await f.run()).storage_processed, false); assert.equal(f.assets[0].status, 'eliminado');
  assert.equal(f.assets[1].status, 'fallido'); f.setMode('success');
  assert.equal((await f.run()).storage_processed, true); assert.equal(f.request.estado_codigo, 'auth_pendiente');
  assert.equal(f.removals.filter(p => p === f.assets[0].object_path).length, 1);
});
test('AM: respuesta perdida despues de borrar se resuelve comprobando ausencia', async () => {
  const f = fixture({ removeMode: 'lost_response' }); assert.equal((await f.run()).storage_processed, true);
  assert.equal(f.assets[0].status, 'eliminado');
});
test('AM: marca previa eliminado no sustituye la verificacion fisica', async () => {
  const f = fixture({ assets: [ownAsset(6, { status: 'eliminado', deleted_at: new Date() })] });
  assert.equal((await f.run()).storage_processed, true); assert.equal(f.removals.length, 1);
});
test('AM: dos ejecuciones simultaneas se serializan y el segundo es replay', async () => {
  const f = fixture(); const results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.every(r => r.storage_processed), true); assert.equal(results[1].idempotent_replay, true);
  assert.equal(f.removals.length, 1); assert.equal(f.released, 2);
});
test('AM: fallo de commit tras borrar permite recuperar sin repetir remove', async () => {
  const f = fixture({ failCommit: true }); assert.equal((await f.run()).storage_processed, false);
  assert.equal(f.request.estado_codigo, 'storage_pendiente'); assert.equal(f.assets[0].status, 'fallido');
  assert.equal((await f.run()).storage_processed, true); assert.equal(f.removals.length, 1);
});
test('AM: llamada directa al finalizador no declara exito con objeto presente', async () => {
  const f = fixture(); const c = await f.app.db.connect();
  const result = await finalizeApprovedInternalAccountDeletionStorage(c, { deletionRequestId: REQUEST });
  assert.equal(result.storage_processed, false); assert.equal(f.assets[0].status, 'activo');
  assert.equal(f.request.estado_codigo, 'storage_pendiente'); assert.deepEqual(f.removals, []); c.release();
});
test('AM: foto heredada sin referencia verificable bloquea incluso lote vacio', async () => {
  const f = fixture({ assets: [], legacy: true }); assert.equal((await f.run()).storage_processed, false);
  assert.equal(f.request.estado_codigo, 'storage_pendiente');
});
test('AM: snapshot incompleto no se interpreta como cuenta sin archivos', async () => {
  const f = fixture(); delete f.request.resumen_impacto.internal_anonymization.storage_asset_ids;
  assert.equal((await f.run()).storage_processed, false); assert.deepEqual(f.removals, []);
});
// AM: Rechazar desviaciones del snapshot sin extender automaticamente la autorizacion.
test('AM: archivo nuevo fuera del snapshot bloquea antes de Storage', async () => {
  const f = fixture({ assets: [ownAsset(), ownAsset(7)], captured: [ID(6)] });
  assert.equal((await f.run()).storage_processed, false); assert.deepEqual(f.removals, []);
  assert.equal(f.request.estado_codigo, 'storage_pendiente'); assert.deepEqual(f.updated, []);
});
test('AM: nuevo archivo durante remove impide avanzar a Auth', async () => {
  const f = fixture(); const originalFrom = f.app.supabaseAdmin.storage.from;
  f.app.supabaseAdmin.storage.from = bucket => {
    const storage = originalFrom(bucket);
    return { async remove(paths) {
      const result = await storage.remove(paths);
      f.assets.push(ownAsset(7)); f.objects.add(f.assets[1].object_path);
      return result;
    } };
  };
  assert.equal((await f.run()).storage_processed, false);
  assert.equal(f.request.estado_codigo, 'storage_pendiente'); assert.equal(f.assets[1].status, 'activo');
  assert.equal(f.objects.has(f.assets[1].object_path), true);
});
test('AM: snapshot duplicado bloquea sin mutar archivos', async () => {
  const f = fixture({ captured: [ID(6), ID(6)] });
  assert.equal((await f.run()).storage_processed, false); assert.deepEqual(f.updated, []);
});
test('AM: snapshot con asset inexistente no permite avance parcial', async () => {
  const f = fixture({ captured: [ID(6), ID(100)] });
  assert.equal((await f.run()).storage_processed, false); assert.deepEqual(f.removals, []);
  // AM: Probar que se ejecuto el SELECT productivo del snapshot, no un rechazo ajeno del doble.
  const fetch = f.queries.find(q => q.sql.includes('WHERE id_asset = ANY($1::uuid[])') && q.sql.includes('FOR UPDATE'));
  assert.deepEqual(fetch.params[0], [ID(6), ID(100)]);
  assert.equal(f.request.estado_codigo, 'storage_pendiente'); assert.deepEqual(f.updated, []);
  assert.equal(f.request.error_codigo, 'ADMIN_ACCOUNT_DELETION_STORAGE_TEMPORARY_FAILURE');
});
test('AM: usuario todavia activo bloquea la limpieza', async () => {
  const f = fixture(); f.request.usuario_estado = true;
  assert.equal((await f.run()).storage_processed, false); assert.deepEqual(f.removals, []);
});

// AM: Un snapshot vacio no omite la revalidacion de archivos concurrentes.
test('AM: anonimizar sin archivos pasa por Storage antes de Auth', async () => {
  const f = fixture({ assets: [], state: 'procesando' });
  f.request.resumen_impacto = { internal_execution: { storage_asset_ids: [] } };
  let nextState;
  const client = { async query(sql, params = []) {
    if (sql.includes('FROM app_private.solicitudes_eliminacion_cuenta')) return { rows: [f.request] };
    if (sql.includes('SELECT id_correo')) return { rows: [] };
    if (sql.includes('UPDATE app_private.solicitudes_eliminacion_cuenta')) {
      nextState = params[1]; return { rows: [{ estado_codigo: nextState }] };
    }
    assert.match(sql, /UPDATE public\.(personas|seguridad_audit_logs|bitacoras)/);
    return { rows: [], rowCount: 1 };
  } };
  await anonymizeApprovedInternalAccountDeletion(client, { deletionRequestId: REQUEST });
  assert.equal(nextState, 'storage_pendiente');
});
// AM: Regresiones 01A.1 con referencias concretas y ubicaciones fisicas separadas por bucket.
const photoReference = (asset, persona = PERSON) => ({ reference_persona_id: persona,
  reference_asset_id: asset.id_asset, reference_path: asset.object_path, reference_url: null });
const storageUrl = (bucket, path) => `https://synthetic.invalid/storage/v1/object/public/${bucket}/${path}`;
const foreignBucketAsset = own => ownAsset(7, { bucket_name: 'imagenes_privadas', visibility: 'private',
  scope_key: 'private_client_profile', entity_type: 'cliente', entity_id: ID(77), owner_cliente_id: ID(78),
  object_path: own.object_path });
const assertRejectedWithoutMutation = async f => {
  const before = structuredClone(f.assets);
  assert.equal((await f.run()).storage_processed, false);
  assert.equal(f.request.estado_codigo, 'storage_pendiente');
  assert.deepEqual(f.removals, []); assert.deepEqual(f.updated, []); assert.deepEqual(f.assets, before);
};
for (const transform of [
  path => path.replace(BRANCH, ID(80)),
  path => path.replace(BRANCH, `${BRANCH}-extra`),
  path => path.replace('/perfil/', '/otro/'),
  path => path.replace('/sucursal/', '/sucursal/extra/'),
]) test('AM: ruta contradictoria con el formato oficial bloquea antes de Storage', async () => {
  const asset = ownAsset(); asset.object_path = transform(asset.object_path);
  await assertRejectedWithoutMutation(fixture({ assets: [asset] }));
});
test('AM: ruta oficial y foto resuelta por UUID permiten limpieza', async () => {
  const own = ownAsset(); const f = fixture({ assets: [own], photoAssetId: own.id_asset,
    photoPath: own.object_path, references: [photoReference(own)] });
  assert.equal((await f.run()).storage_processed, true); assert.equal(f.request.estado_codigo, 'auth_pendiente');
});
test('AM: UUID propio resuelve colision de ruta entre buckets sin tocar tercero', async () => {
  const own = ownAsset(), foreign = foreignBucketAsset(own), before = structuredClone(foreign);
  const f = fixture({ assets: [own, foreign], captured: [own.id_asset], photoAssetId: own.id_asset,
    photoPath: own.object_path, references: [photoReference(own), photoReference(foreign, ID(77))] });
  assert.equal((await f.run()).storage_processed, true);
  assert.deepEqual(foreign, before); assert.equal(f.objects.has(foreign.object_path, foreign.bucket_name), true);
  assert.equal(f.objects.has(own.object_path, own.bucket_name), false);
  assert.equal(f.updated.includes(foreign.id_asset), false);
});
test('AM: referencia propia heredada solo ruta con dos buckets bloquea', async () => {
  const own = ownAsset(), foreign = foreignBucketAsset(own);
  await assertRejectedWithoutMutation(fixture({ assets: [own, foreign], captured: [own.id_asset],
    photoPath: own.object_path, references: [{ reference_persona_id: PERSON,
      reference_asset_id: null, reference_path: own.object_path }] }));
});
test('AM: referencia propia heredada en bucket unico se verifica sin asumir uploader', async () => {
  const own = ownAsset(); const f = fixture({ assets: [own], photoPath: own.object_path,
    references: [{ reference_persona_id: PERSON, reference_asset_id: null, reference_path: own.object_path }] });
  assert.equal((await f.run()).storage_processed, true);
});
test('AM: referencia ajena solo ruta con dos buckets permanece ambigua', async () => {
  const own = ownAsset();
  await assertRejectedWithoutMutation(fixture({ assets: [own, foreignBucketAsset(own)], captured: [own.id_asset],
    references: [{ reference_persona_id: ID(77), reference_asset_id: null, reference_path: own.object_path }] }));
});
test('AM: UUID ajeno que comparte el asset propio bloquea', async () => {
  const own = ownAsset();
  await assertRejectedWithoutMutation(fixture({ assets: [own], references: [photoReference(own, ID(77))] }));
});
test('AM: UUID propio con ruta contradictoria bloquea sin mutaciones', async () => {
  const own = ownAsset();
  await assertRejectedWithoutMutation(fixture({ assets: [own], references: [
    { ...photoReference(own), reference_path: `${own.object_path}.otro` },
  ] }));
});
test('AM: UUID inexistente no se resuelve por coincidencia de ruta', async () => {
  const own = ownAsset();
  await assertRejectedWithoutMutation(fixture({ assets: [own], references: [
    { ...photoReference(own), reference_asset_id: ID(999) },
  ] }));
});
test('AM: referencia comercial al mismo bucket/ruta por URL bloquea', async () => {
  const own = ownAsset();
  await assertRejectedWithoutMutation(fixture({ assets: [own], references: [{ reference_persona_id: null,
    reference_asset_id: null, reference_path: own.object_path,
    reference_url: storageUrl(own.bucket_name, own.object_path) }] }));
});
test('AM: referencia comercial por UUID de otro bucket no colisiona por ruta', async () => {
  const own = ownAsset(), foreign = foreignBucketAsset(own), before = structuredClone(foreign);
  const f = fixture({ assets: [own, foreign], captured: [own.id_asset], references: [
    { ...photoReference(foreign, null), reference_url: storageUrl(foreign.bucket_name, foreign.object_path) },
  ] });
  assert.equal((await f.run()).storage_processed, true); assert.deepEqual(foreign, before);
  assert.equal(f.objects.has(foreign.object_path, foreign.bucket_name), true);
});
test('AM: URL comercial explicita de otro bucket no convierte rutas iguales en compartidas', async () => {
  const own = ownAsset(), foreign = foreignBucketAsset(own), before = structuredClone(foreign);
  const f = fixture({ assets: [own, foreign], captured: [own.id_asset], references: [{ reference_persona_id: null,
    reference_asset_id: null, reference_path: own.object_path,
    reference_url: storageUrl(foreign.bucket_name, foreign.object_path) }] });
  assert.equal((await f.run()).storage_processed, true); assert.deepEqual(foreign, before);
  assert.equal(f.objects.has(foreign.object_path, foreign.bucket_name), true);
});
test('AM: ruta comercial sin UUID ni bucket bloquea aunque haya dos buckets', async () => {
  const own = ownAsset();
  await assertRejectedWithoutMutation(fixture({ assets: [own, foreignBucketAsset(own)], captured: [own.id_asset],
    references: [{ reference_persona_id: null, reference_asset_id: null, reference_path: own.object_path }] }));
});
test('AM: UUID comercial de otro bucket y URL al propio son contradictorios', async () => {
  const own = ownAsset(), foreign = foreignBucketAsset(own);
  await assertRejectedWithoutMutation(fixture({ assets: [own, foreign], captured: [own.id_asset], references: [
    { ...photoReference(foreign, null), reference_url: storageUrl(own.bucket_name, own.object_path) },
  ] }));
});
// AM: La ambiguedad tambien incluye objetos fisicos sin fila en storage_assets.
test('AM: ruta heredada colisiona con objeto de otro bucket sin asset registrado', async () => {
  const own = ownAsset(); const f = fixture({ assets: [own], captured: [own.id_asset],
    references: [{ reference_persona_id: PERSON, reference_asset_id: null, reference_path: own.object_path }] });
  f.objects.add(own.object_path, 'imagenes_privadas');
  await assertRejectedWithoutMutation(f);
  assert.equal(f.objects.has(own.object_path, 'imagenes_privadas'), true);
});
test('AM: URL comercial codificada al mismo objeto sigue bloqueando', async () => {
  const own = ownAsset();
  await assertRejectedWithoutMutation(fixture({ assets: [own], references: [{ reference_persona_id: null,
    reference_asset_id: null, reference_path: null,
    reference_url: storageUrl(own.bucket_name, own.object_path.replaceAll('-', '%2D')) }] }));
});
// AM: 01A.2: los escritores reales se enfrentan al estado vigente despues de la cuarentena.
for (const state of ['temporal', 'activo']) test(`AM: activacion legitima desde ${state} conserva compatibilidad`, async () => {
  const f = fixture({ assets: [ownAsset(6, { status: state })] }); const writer = await f.app.db.connect();
  const result = await bindAndActivateAsset(writer, { idAsset: ID(6), entityId: EMPLOYEE, idSucursal: BRANCH });
  assert.equal(result.status, 'activo'); assert.equal(f.assets[0].status, 'activo'); writer.release();
});
for (const overrides of [
  { status: 'fallido' }, { status: 'reemplazado' }, { status: 'eliminado' },
  { status: 'activo', deleted_at: new Date() },
  { status: 'activo', metadata: { account_deletion_storage: { request_id: REQUEST } } },
]) test('AM: UPDATE atomico rechaza estado no autorizado o cuarentena', async () => {
  const f = fixture({ assets: [ownAsset(6, overrides)] }); const before = structuredClone(f.assets);
  const writer = await f.app.db.connect();
  await assert.rejects(() => bindAndActivateAsset(writer, { idAsset: ID(6), entityId: EMPLOYEE }),
    { statusCode: 409, code: 'STORAGE_ASSET_STATUS_INVALID' });
  assert.deepEqual(f.assets, before); writer.release();
});
test('AM: activacion inexistente se diferencia del conflicto de estado', async () => {
  const f = fixture({ assets: [] }); const writer = await f.app.db.connect();
  await assert.rejects(() => bindAndActivateAsset(writer, { idAsset: ID(6) }),
    { statusCode: 404, code: 'STORAGE_ASSET_NOT_FOUND' }); writer.release();
});
test('AM: escritor que valido antes no puede activar ni cambiar metadata tras cuarentena', async () => {
  const f = fixture(); const writer = await f.app.db.connect();
  const stale = await resolveAssetForBinding(writer, { assetId: ID(6), scopeKey: 'public_barber_profile',
    entityType: 'barbero', entityId: EMPLOYEE, idSucursal: BRANCH });
  assert.equal(stale.status, 'activo');
  const originalFrom = f.app.supabaseAdmin.storage.from;
  f.app.supabaseAdmin.storage.from = bucket => {
    const storage = originalFrom(bucket);
    return { async remove(paths) {
      assert.equal(f.assets[0].metadata.account_deletion_storage.request_id, REQUEST);
      const before = structuredClone(f.assets[0]);
      await assert.rejects(() => bindAndActivateAsset(writer, { idAsset: stale.id_asset, entityId: EMPLOYEE }),
        { statusCode: 409, code: 'STORAGE_ASSET_STATUS_INVALID' });
      await assert.rejects(() => markAssetStatus(writer, { idAsset: stale.id_asset, status: 'reemplazado', metadata: { stale: true } }),
        { statusCode: 409, code: 'STORAGE_ASSET_STATUS_INVALID' });
      assert.deepEqual(f.assets[0], before);
      return storage.remove(paths);
    } };
  };
  assert.equal((await f.run()).storage_processed, true); assert.equal(f.removals.length, 1); writer.release();
});
test('AM: escritor de estado no puede quitar cuarentena aunque intente activar', async () => {
  const f = fixture({ assets: [ownAsset(6, { status: 'fallido', metadata: { account_deletion_storage: { request_id: REQUEST } } })] });
  const before = structuredClone(f.assets); const writer = await f.app.db.connect();
  await assert.rejects(() => markAssetStatus(writer, { idAsset: ID(6), status: 'activo' }),
    { statusCode: 409, code: 'STORAGE_ASSET_STATUS_INVALID' });
  assert.deepEqual(f.assets, before); writer.release();
});
test('AM: escritor de estado legitimo e inexistente conservan contrato', async () => {
  const f = fixture(); const writer = await f.app.db.connect();
  assert.equal((await markAssetStatus(writer, { idAsset: ID(6), status: 'reemplazado' })).status, 'reemplazado');
  assert.equal(await markAssetStatus(writer, { idAsset: ID(999), status: 'reemplazado' }), null); writer.release();
});
for (const stage of [1, 2]) test(`AM: COMMIT ${stage} confirmado con respuesta perdida se recupera sin regresion`, async () => {
  const f = fixture({ ambiguousCommitAt: stage }); const first = await f.run();
  if (stage === 1) {
    assert.equal(first.storage_processed, false); assert.equal(f.request.estado_codigo, 'storage_pendiente');
    assert.equal(f.removals.length, 0); assert.equal(f.assets[0].status, 'fallido');
    assert.equal(f.assets[0].metadata.account_deletion_storage.request_id, REQUEST);
  } else {
    assert.equal(first.storage_processed, true); assert.equal(first.idempotent_replay, true);
    assert.equal(f.request.estado_codigo, 'auth_pendiente');
  }
  assert.equal((await f.run()).storage_processed, true); assert.equal(f.request.estado_codigo, 'auth_pendiente');
  assert.equal(f.removals.length, 1); assert.ok(f.assets[0].object_path);
  assert.deepEqual(f.request.resumen_impacto.internal_anonymization.storage_asset_ids, [ID(6)]);
});
for (const stage of [1, 2]) test(`AM: desconexion tras COMMIT ${stage} descarta conexion y permite reintento`, async () => {
  const f = fixture({ disconnectAtCommit: stage });
  await assert.rejects(f.run, { statusCode: 503, code: 'ADMIN_ACCOUNT_DELETION_STORAGE_TEMPORARY_FAILURE' });
  assert.equal(f.request.estado_codigo, stage === 1 ? 'storage_pendiente' : 'auth_pendiente');
  assert.ok(f.assets[0].object_path); assert.equal(f.assets[0].metadata.account_deletion_storage.request_id, REQUEST);
  assert.equal((await f.run()).storage_processed, true); assert.equal(f.removals.length, 1);
});
test('AM: referencia tardia de tercero bloquea Auth y conserva rutas e identificadores', async () => {
  const own = ownAsset(), references = []; const f = fixture({ assets: [own], references });
  const originalFrom = f.app.supabaseAdmin.storage.from;
  f.app.supabaseAdmin.storage.from = bucket => {
    const storage = originalFrom(bucket);
    return { async remove(paths) {
      const result = await storage.remove(paths); references.push(photoReference(own, ID(77))); return result;
    } };
  };
  assert.equal((await f.run()).storage_processed, false); assert.equal(f.request.estado_codigo, 'storage_pendiente');
  assert.equal(f.assets[0].status, 'fallido'); assert.ok(f.assets[0].object_path);
  assert.deepEqual(f.request.resumen_impacto.internal_anonymization.storage_asset_ids, [own.id_asset]);
  assert.deepEqual(references, [photoReference(own, ID(77))]);
});
// AM: La limpieza tardia de una foto reemplazada tampoco puede sobrescribir la cuarentena.
test('AM: replaceAssetIfNeeded con snapshot obsoleto no modifica ni elimina un asset en cuarentena', async () => {
  const asset = ownAsset(6, { status: 'fallido', metadata: { account_deletion_storage: { request_id: REQUEST } } });
  const f = fixture({ assets: [asset] }); const before = structuredClone(asset); const writer = await f.app.db.connect();
  await assert.rejects(() => replaceAssetIfNeeded(f.app, writer, { previousAssetId: asset.id_asset,
    nextAssetId: ID(99), prevalidatedAsset: { ...asset, status: 'activo', metadata: {} } }),
  { statusCode: 409, code: 'STORAGE_ASSET_STATUS_INVALID' });
  assert.deepEqual(asset, before); assert.deepEqual(f.removals, []); writer.release();
});
// AM: El finalizador real debe detectar el UUID inexistente aunque todos los objetos restantes ya esten ausentes.
test('AM: finalizador productivo rechaza snapshot incompleto antes de comprobar ausencias o avanzar a Auth', async () => {
  const f = fixture({ captured: [ID(6), ID(100)], existing: [] });
  const client = await f.app.db.connect();
  await assert.rejects(() => finalizeApprovedInternalAccountDeletionStorage(client, { deletionRequestId: REQUEST }),
    { code: 'CLIENT_ACCOUNT_DELETION_STORAGE_ASSET_NOT_FOUND' });
  assert.equal(f.request.estado_codigo, 'storage_pendiente'); assert.deepEqual(f.updated, []);
  assert.equal(f.queries.some(q => q.sql.includes('FROM storage.objects')), false);
  assert.equal(f.queries.some(q => q.sql.includes('UPDATE app_private.solicitudes_eliminacion_cuenta')), false);
  assert.deepEqual(f.removals, []); client.release();
});
test('AM: desaparicion de metadata entre borrado y finalizacion bloquea Auth conservando snapshot completo', async () => {
  const f = fixture({ assets: [ownAsset(), ownAsset(7)] }); const observed = [];
  const connect = f.app.db.connect.bind(f.app.db);
  f.app.db.connect = async () => {
    const client = await connect(), query = client.query.bind(client);
    client.query = async (sql, params) => {
      const result = await query(sql, params);
      if (sql.includes('WHERE id_asset = ANY($1::uuid[])') && sql.includes('FOR UPDATE')) {
        observed.push(result.rows.map(row => row.id_asset));
      }
      return result;
    };
    return client;
  };
  const originalFrom = f.app.supabaseAdmin.storage.from;
  f.app.supabaseAdmin.storage.from = bucket => {
    const storage = originalFrom(bucket);
    return { async remove(paths) {
      const result = await storage.remove(paths);
      if (paths[0] === f.assets[1]?.object_path) f.assets.splice(1, 1);
      return result;
    } };
  };
  assert.equal((await f.run()).storage_processed, false);
  assert.deepEqual(observed, [[ID(6), ID(7)], [ID(6)]]);
  assert.equal(f.request.estado_codigo, 'storage_pendiente');
  assert.deepEqual(f.request.resumen_impacto.internal_anonymization.storage_asset_ids, [ID(6), ID(7)]);
  assert.equal(f.removals.length, 2); assert.equal(f.assets[0].status, 'fallido');
  assert.equal(f.queries.some(q => q.sql.includes("status = 'eliminado'")), false);
});
