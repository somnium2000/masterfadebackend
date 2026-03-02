import catalogRoutes from "./catalog.js";

export default async function adminRoutes(app) {
  await app.register(catalogRoutes, { prefix: "/catalog" });
}
