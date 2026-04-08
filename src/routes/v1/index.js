import healthRoutes from "../health.js";
import adminRoutes from "./admin/index.js";
import authRoutes from "./auth.js";
import barberoRoutes from "./barbero.js";
import clienteRoutes from "./cliente.js";
import citasRoutes from "./citas.js";
import pagosRoutes from "./pagos.js";
import publicRoutes from "./public/index.js";
import storageRoutes from "./storage.js";

export default async function v1Routes(app) {
  await app.register(healthRoutes, { prefix: "/v1/health" });
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(publicRoutes, { prefix: "/v1/public" });
  await app.register(clienteRoutes, { prefix: "/v1/cliente" });
  await app.register(barberoRoutes, { prefix: "/v1/barbero" });
  await app.register(storageRoutes, { prefix: "/v1/storage" });
  await app.register(citasRoutes, { prefix: "/v1/citas" });
  await app.register(pagosRoutes, { prefix: "/v1/pagos" });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
}
