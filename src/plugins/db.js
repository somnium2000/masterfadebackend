import fp from "fastify-plugin";
import pg from "pg";
import pool, {
  getDbListenConfig,
  getSanitizedDbListenTarget,
  getSanitizedDbTarget,
  getSupabaseDbConnectionHints
} from "../config/db-connection.js";
import { createClient } from "@supabase/supabase-js";

const { Pool } = pg;

async function dbPlugin(app) {
  const target = getSanitizedDbTarget();

  app.log.info(
    `DB target: host=${target.host}, port=${target.port}, db=${target.database}, user=${target.user} (${target.source})`
  );

  if (process.env.DB_TEST_CONNECTION === "true") {
    try {
      await pool.query("select 1 as ok");
      app.log.info("DB startup check OK (select 1)");
    } catch (error) {
      const baseMessage =
        error instanceof Error ? error.message : "Error desconocido";
      throw new Error(
        `Error al conectar con la base de datos: ${baseMessage}. ${getSupabaseDbConnectionHints()}`,
        { cause: error }
      );
    }
  }

  app.decorate("db", pool);

  let listenPool = null;
  let listenConfigError = null;
  try {
    const listenTarget = getSanitizedDbListenTarget();
    listenPool = new Pool(getDbListenConfig());
    listenPool.on("connect", (client) => {
      client.query("SET client_encoding TO 'UTF8'").catch(() => {});
    });
    app.log.info(
      `DB LISTEN target: host=${listenTarget.host}, port=${listenTarget.port}, db=${listenTarget.database}, user=${listenTarget.user} (${listenTarget.source})`
    );
  } catch (error) {
    listenConfigError = error;
    app.log.error(
      { err: error },
      "DATABASE_LISTEN_URL required for LISTEN/NOTIFY when DATABASE_URL uses Supabase transaction pooler 6543."
    );
  }
  app.decorate("dbListenPool", listenPool);
  app.decorate("dbListenConfigError", listenConfigError);

  app.addHook("onClose", (instance, done) => {
    Promise.all([
      pool.end(),
      listenPool ? listenPool.end() : Promise.resolve()
    ]).then(() => done()).catch(done);
  });

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

  if (supabaseUrl && supabaseAnonKey) {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    app.decorate("supabase", supabase);
  } else {
    app.log.warn(
      "SUPABASE_URL/SUPABASE_ANON_KEY no configuradas: app.supabase no estara disponible."
    );
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (supabaseUrl && serviceRoleKey) {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    app.decorate("supabaseAdmin", supabaseAdmin);
  } else {
    app.log.warn(
      "SUPABASE_SERVICE_ROLE_KEY no configurada: app.supabaseAdmin no estara disponible. Las escrituras via Supabase REST no podran bypassear RLS."
    );
  }
}

export default fp(dbPlugin, { name: "db-plugin" });
