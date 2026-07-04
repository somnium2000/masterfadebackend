import Fastify from "fastify";
import env from "./plugins/env.js";
import logger from "./plugins/logger.js";
import security from "./plugins/security.js";
import db from "./plugins/db.js";
import auth from "./plugins/auth.js";
import mailer from "./plugins/mailer.js";
import membershipAlerts from "./plugins/membershipAlerts.js";
import securityRealtime from "./plugins/securityRealtime.js";
import agendaRealtime from "./plugins/agendaRealtime.js";
import routes from "./routes/v1/index.js";
import { globalErrorHandler } from "./utils/errors.js";

function parseTrustProxy(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return false;
}

export async function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  });

  // AM: Registrar el error handler global antes de cargar rutas para unificar el contrato de errores.
  app.setErrorHandler(globalErrorHandler);

  await app.register(env);
  await app.register(logger);
  await app.register(security);
  await app.register(db);
  await app.register(mailer);
  await app.register(membershipAlerts);
  await app.register(auth);
  await app.register(securityRealtime);
  await app.register(agendaRealtime);
  await app.register(routes);

  return app;
}
