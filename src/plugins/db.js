import pool from "../config/db-connection.js";
import { createClient } from "@supabase/supabase-js";

export default async function dbPlugin(app) {
  // NUEVO:
  // PORQUE: Antes el plugin fallaba si NO existían SUPABASE_URL/SUPABASE_ANON_KEY.
  // IMPACTO: Ahora la DB principal es PostgreSQL vía node-postgres (pg) y Supabase JS queda opcional.

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

  // Decoramos el pool para usarlo como app.db
  app.decorate("db", pool);

  // Cerramos el pool al apagar el servidor
  app.addHook("onClose", (instance, done) => {
    pool.end().then(() => done()).catch(done);
  });

  // Supabase client (OPCIONAL) — no tumba el arranque si no está configurado
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
