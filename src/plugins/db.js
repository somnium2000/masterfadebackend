import fp from "fastify-plugin";
import pool from "../config/db-connection.js";
import { createClient } from "@supabase/supabase-js";

async function dbPlugin(app) {
  // Validación mínima para PostgreSQL (requerido)
  const required = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
  const missing = required.filter(
    (k) => !process.env[k] || !String(process.env[k]).trim()
  );

  if (missing.length) {
    throw new Error(
      `Missing DB env vars: ${missing.join(", ")} (revisa tu .env)`
    );
  }

  // Decoración GLOBAL (gracias a fastify-plugin)
  app.decorate("db", pool);

  // Cerramos el pool al apagar el servidor
  app.addHook("onClose", (instance, done) => {
    pool.end().then(() => done()).catch(done);
  });

  // Supabase client (OPCIONAL)
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
      "SUPABASE_URL/SUPABASE_ANON_KEY no configuradas: app.supabase no estará disponible (esto NO bloquea el arranque)."
    );
  }
}

// 👇 Esto hace que las decoraciones NO queden encapsuladas
export default fp(dbPlugin, { name: "db-plugin" });
