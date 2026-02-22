import healthRoutes from "../health.js";
import authRoutes from "./auth.js";

export default async function v1Routes(app) {
  await app.register(healthRoutes, { prefix: "/v1/health" });
  await app.register(authRoutes, { prefix: "/v1/auth" });
}
