import healthRoutes from "../health.js";
import adminRoutes from "./admin/index.js";
import authRoutes from "./auth.js";
import citasRoutes from "./citas.js";
import pagosRoutes from "./pagos.js";
import publicRoutes from "./public/index.js";

export default async function v1Routes(app) {
  await app.register(healthRoutes, { prefix: "/v1/health" });
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(publicRoutes, { prefix: "/v1/public" });
  await app.register(citasRoutes, { prefix: "/v1/citas" });
  await app.register(pagosRoutes, { prefix: "/v1/pagos" });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
}
