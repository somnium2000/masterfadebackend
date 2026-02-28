import Fastify from "fastify";
import env from "./plugins/env.js";
import logger from "./plugins/logger.js";
import security from "./plugins/security.js";
import db from "./plugins/db.js";
import routes from "./routes/v1/index.js";
import { globalErrorHandler } from "./utils/errors.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(env);
  await app.register(logger);
  await app.register(security);
  await app.register(db);
  await app.register(routes);

  app.setErrorHandler(globalErrorHandler);

  return app;
}
