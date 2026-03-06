import catalogRoutes from "./catalog.js";
import empleadosRoutes from "./empleados.js";
import sucursalesRoutes from "./sucursales.js";

export default async function adminRoutes(app) {
  await app.register(catalogRoutes, { prefix: "/catalog" });
  await app.register(empleadosRoutes, { prefix: "/empleados" });
  await app.register(sucursalesRoutes, { prefix: "/sucursales" });
}
