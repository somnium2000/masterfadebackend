import catalogRoutes from "./catalog.js";
import configuracionRoutes from "./configuracion.js";
import adminCitasRoutes from "./citas.js";
import empleadosRoutes from "./empleados.js";
import masterPuntosRoutes from "./masterpuntos.js";
import personasRoutes from "./personas.js";
import plansRoutes from "./plans.js";
import sucursalesRoutes from "./sucursales.js";

export default async function adminRoutes(app) {
  await app.register(personasRoutes, { prefix: "/personas" });
  await app.register(catalogRoutes, { prefix: "/catalog" });
  await app.register(plansRoutes, { prefix: "/catalog/planes" });
  await app.register(empleadosRoutes, { prefix: "/empleados" });
  await app.register(sucursalesRoutes, { prefix: "/sucursales" });
  await app.register(masterPuntosRoutes, { prefix: "/masterpuntos" });
  await app.register(adminCitasRoutes, { prefix: "/citas" });

}
