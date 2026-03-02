import catalogRoutes from "./catalog.js";

export default async function publicRoutes(app) {
  await app.register(catalogRoutes, { prefix: "/catalog" });
}
