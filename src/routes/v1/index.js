import healthRoutes from "../health.js";

export default async function v1Routes(app) {
  await app.register(healthRoutes, { prefix: "/v1/health" });
}
