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
import { buildTrustProxy } from "./utils/trustProxy.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: buildTrustProxy(process.env.TRUST_PROXY),
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
