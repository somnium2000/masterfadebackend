export default async function authRoutes(app) {
  // GET placeholder (lo dejo por compatibilidad)
  app.get("/login", async (request) => {
    return {
      ok: true,
      message: "Login endpoint GET placeholder",
      method: "GET",
      requestId: request.id
    };
  });

  // LOGIN REAL (POST)
  // POST /v1/auth/login
  // Body esperado (acepta varios nombres para que no choques con frontend):
  // {
  //   "nombre_usuario": "super_admin",  // o "username" o "email"
  //   "contrasena": "ClaveNueva1"       // o "password"
  // }
  app.post("/login", async (request, reply) => {
    // Validación defensiva (evita crashes)
    const body = request.body && typeof request.body === "object" ? request.body : {};

    const nombreUsuario =
      String(body.nombre_usuario ?? body.username ?? body.email ?? "").trim();

    const contrasena =
      String(body.contrasena ?? body.password ?? "").trim();

    if (!nombreUsuario || !contrasena) {
      return reply.code(400).send({
        ok: false,
        message: "Faltan credenciales: nombre_usuario/username/email y contrasena/password son requeridos",
        requestId: request.id
      });
    }

    if (!app.db) {
      return reply.code(500).send({
        ok: false,
        message: "DB no configurada (app.db no existe). Revisa el plugin de DB y tu .env",
        requestId: request.id
      });
    }

    // JWT (ya existe en tu .env)
    const jwtSecret = process.env.JWT_SECRET?.trim();
    if (!jwtSecret) {
      return reply.code(500).send({
        ok: false,
        message: "Falta JWT_SECRET en el .env",
        requestId: request.id
      });
    }

    try {
      // Llamamos la función en PostgreSQL (Supabase) que valida usuario + password
      // IMPORTANTE: Asegúrate de haber creado fn_login_usuario en pgAdmin antes.
      const { rows } = await app.db.query(
        "SELECT public.fn_login_usuario($1, $2) AS result",
        [nombreUsuario, contrasena]
      );

      const result = rows?.[0]?.result;

      if (!result || result.ok !== true) {
        return reply.code(401).send({
          ok: false,
          message: result?.message || "Credenciales inválidas",
          requestId: request.id
        });
      }

      const user = result.user;

      // JWT básico (sin datos sensibles)
      // Nota: jsonwebtoken en ESM puede importarse dinámicamente para evitar problemas de compatibilidad.
      const jwtModule = await import("jsonwebtoken");
      const jwt = jwtModule.default;

      const token = jwt.sign(
        {
          sub: String(user.id_usuario),
          nombre_usuario: user.nombre_usuario
        },
        jwtSecret,
        { expiresIn: process.env.JWT_EXPIRES_IN?.trim() || "12h" }
      );

      return reply.code(200).send({
        ok: true,
        message: "Login exitoso",
        token,
        user,
        requestId: request.id
      });
    } catch (error) {
      // Caso típico: la función no existe aún
      const msg =
        error instanceof Error ? error.message : "Error desconocido en login";

      return reply.code(500).send({
        ok: false,
        message: "Error al procesar login",
        detail: msg,
        hint:
          msg.includes("fn_login_usuario")
            ? "Parece que no existe la función public.fn_login_usuario. Créala en pgAdmin y vuelve a intentar."
            : undefined,
        requestId: request.id
      });
    }
  });
}
