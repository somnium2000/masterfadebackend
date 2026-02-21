export default async function healthRoutes(app) {
  app.get("/", async (request) => {
    return {
      ok: true,
      requestId: request.id
    };
  });

  // NUEVO:
  // PORQUE: Validar conectividad real contra PostgreSQL (Supabase) usando el pool (app.db).
  // IMPACTO: Si la DB está caída o credenciales están mal, lo verás aquí.
  app.get("/db", async (request, reply) => {
    if (!app.db) {
      return reply.code(500).send({
        ok: false,
        provider: "postgres",
        status: 500,
        message: "DB pool no está configurado (app.db no existe)",
        requestId: request.id
      });
    }

    try {
      const result = await app.db.query("select 1 as ok");
      const ok = result?.rows?.[0]?.ok === 1;

      return reply.code(ok ? 200 : 502).send({
        ok,
        provider: "postgres",
        status: ok ? 200 : 502,
        requestId: request.id
      });
    } catch (error) {
      return reply.code(502).send({
        ok: false,
        provider: "postgres",
        status: 0,
        message: error instanceof Error ? error.message : "DB query failed",
        requestId: request.id
      });
    }
  });

  // Mantenemos la ruta anterior para compatibilidad.
  // Si tienes SUPABASE_URL/SUPABASE_ANON_KEY, este endpoint seguirá sirviendo como “health” del REST.
  app.get("/supabase", async (request, reply) => {
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      // Si no está configurado, devuelve una respuesta clara (sin tumbar el server)
      return reply.code(501).send({
        ok: false,
        provider: "supabase-rest",
        status: 501,
        message: "SUPABASE_URL/SUPABASE_ANON_KEY no están configuradas",
        requestId: request.id
      });
    }

    const restUrl = new URL("/rest/v1/", supabaseUrl).toString();

    try {
      if (typeof fetch !== "function") {
        return reply.code(500).send({
          ok: false,
          provider: "supabase-rest",
          status: 500,
          message: "fetch no está disponible en esta versión de Node",
          requestId: request.id
        });
      }

      const response = await fetch(restUrl, {
        method: "GET",
        headers: {
          apikey: supabaseAnonKey,
          authorization: `Bearer ${supabaseAnonKey}`
        }
      });

      const ok = [200, 401, 404].includes(response.status);
      return reply.code(ok ? 200 : 502).send({
        ok,
        provider: "supabase-rest",
        status: response.status,
        requestId: request.id
      });
    } catch (error) {
      return reply.code(502).send({
        ok: false,
        provider: "supabase-rest",
        status: 0,
        message:
          error instanceof Error ? error.message : "Supabase request failed",
        requestId: request.id
      });
    }
  });
}
