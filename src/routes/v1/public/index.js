import catalogRoutes from "./catalog.js";
import plansRoutes from "./plans.js";

export default async function publicRoutes(app) {
  await app.register(catalogRoutes, { prefix: "/catalog" });
  await app.register(plansRoutes, { prefix: "/catalog/planes" });
}
