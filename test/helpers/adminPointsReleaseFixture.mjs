import Fastify from 'fastify';
import fp from 'fastify-plugin';
import security from '../../src/plugins/security.js';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startPostgres17 } from './postgres17.mjs';
import auth from '../../src/plugins/auth.js';
import adminGate from '../../src/plugins/adminDataEntry.js';
import routes from '../../src/routes/v1/admin/puntos.js';
import { globalErrorHandler } from '../../src/utils/errors.js';

// AM: Solo PostgreSQL local. Auth externa usa identidades sinteticas; JWT/roles/guard/controlador/servicio/SQL reales.
export async function createAdminPointsReleaseFixture() {
  const isolated = await startPostgres17();
  const pool = new pg.Pool({ ...isolated.connectionOptions, max: 10 });
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  const profiles = new Map();
  let serviceQueries = 0;
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomBytes(48).toString('hex');
  const close = async () => {
    await app.close(); await pool.end(); await isolated.stop();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  };
  try {
    await pool.query((await readFile(new URL('../sql/admin-masterpoints-release.fixture.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'));
    const branch = randomUUID(), otherBranch = randomUUID();
    await pool.query("INSERT INTO sucursales(id_sucursal,id_empresa,nombre_sucursal) VALUES($1,$3,'Centro sintetico'),($2,$3,'Otra sintetica')", [branch, otherBranch, randomUUID()]);
    await pool.query("INSERT INTO tipos_puntos(tipo_puntos_codigo,descripcion,signo) VALUES('ajustar','Ajuste administrativo',1),('ajuste_resta','Resta administrativa',-1),('vencimiento','Vencimiento',-1)");
    await pool.query('INSERT INTO points_rules(puntos_para_premio) VALUES(10)');
    const makeClient = async (clientBranch = branch) => {
      const id = randomUUID(), person = randomUUID(), user = randomUUID();
      await pool.query("INSERT INTO personas(id_persona,nombres,apellidos) VALUES($1,'Cliente','Sintetico')", [person]);
      await pool.query("INSERT INTO usuarios(id_usuario,id_persona,estado_acceso) VALUES($1,$2,'activo')", [user, person]);
      await pool.query('INSERT INTO clientes(id_cliente,id_persona,id_usuario,id_sucursal_origen) VALUES($1,$2,$3,$4)', [id, person, user, clientBranch]);
      return { id, person, user, branch: clientBranch };
    };
    const token = (roles = ['admin'], branches = [branch]) => {
      const user = randomUUID();
      profiles.set(user, { id_usuario: user, id_persona: randomUUID(), roles, branch_ids: branches });
      return { user, token: jwt.sign({ sub: user, sid: randomUUID(), jti: randomUUID(), token_type: 'app' }, process.env.JWT_SECRET, { issuer: 'masterfade-api', audience: 'masterfade-app', expiresIn: '1h' }) };
    };
    const query = async (sql, params) => {
      if (sql.includes('WITH base_user')) return { rows: profiles.has(params[0]) ? [profiles.get(params[0])] : [] };
      if (sql.includes('token_jti_hash = $3')) return { rows: [{ estado: 'activa', ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 3600000), revocada_at: null }] };
      if (sql.includes('UPDATE public.seguridad_sesiones')) return { rows: [], rowCount: 0 };
      serviceQueries++;
      return pool.query(sql, params);
    };
    app.decorate('db', { query, connect: async () => {
      const client = await pool.connect();
      return { query: (sql, params) => { serviceQueries++; return client.query(sql, params); }, release: () => client.release() };
    } });
    await app.register(fp(async server => { server.decorate('config', { adminDataEntryMode: true, paymentProvider: 'disabled', corsOrigins: ['http://127.0.0.1:4209'] }); }, { name: 'env-plugin' }));
    await app.register(security); await app.register(adminGate); await app.register(auth);
    await app.register(routes, { prefix: '/v1/admin/puntos' }); await app.ready();
    const adjust = (client, actor, payload, key = randomUUID(), extraHeaders = {}) => app.inject({ method: 'POST', url: `/v1/admin/puntos/clientes/${client.id}/ajuste`, headers: { ...(actor ? { cookie: 'mf_session=' + actor.token + '; mf_csrf=synthetic-release-csrf' } : {}), 'x-csrf-token': 'synthetic-release-csrf', 'x-idempotency-key': key, ...extraHeaders }, payload });
    const ledger = async client => (await pool.query('SELECT * FROM points_transactions WHERE id_cliente=$1 ORDER BY created_at,id_points_tx', [client.id])).rows;
    const balance = async client => Number((await pool.query('SELECT COALESCE(SUM(puntos),0) AS total FROM points_transactions WHERE id_cliente=$1', [client.id])).rows[0].total);
    const seed = (client, amount = 5) => pool.query("INSERT INTO points_transactions(id_cliente,id_sucursal_origen,tipo_puntos_codigo,origen_punto_codigo,puntos,motivo) VALUES($1,$2,'ajustar','sistema',$3,'Saldo sintetico inicial')", [client.id, client.branch, amount]);
    return { app, pool, close, token, makeClient, branch, otherBranch, adjust, ledger, balance, seed, profiles, serviceQueries: () => serviceQueries };
  } catch (error) { await close(); throw error; }
}
