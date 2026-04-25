import catalogRoutes from "./catalog.js";
import configuracionRoutes from "./configuracion.js";
import cortesiasRoutes from "./cortesias.js";
import adminCitasRoutes from "./citas.js";
import empleadosRoutes from "./empleados.js";
import masterPuntosRoutes from "./masterpuntos.js";
import membresiasRoutes from "./membresias.js";
import personasRoutes from "./personas.js";
import plansRoutes from "./plans.js";
import reportesRoutes from "./reportes.js";
import seguridadRoutes from "./seguridad.js";
import storageRoutes from "./storage.js";
import sucursalesRoutes from "./sucursales.js";

export default async function adminRoutes(app) {
  await app.register(personasRoutes, { prefix: "/personas" });
  await app.register(catalogRoutes, { prefix: "/catalog" });
  await app.register(cortesiasRoutes, { prefix: "/catalog/cortesias" });
  await app.register(plansRoutes, { prefix: "/catalog/planes" });
  await app.register(empleadosRoutes, { prefix: "/empleados" });
  await app.register(sucursalesRoutes, { prefix: "/sucursales" });
  await app.register(masterPuntosRoutes, { prefix: "/masterpuntos" });
  await app.register(membresiasRoutes, { prefix: "/membresias" });
  await app.register(adminCitasRoutes, { prefix: "/citas" });
  await app.register(reportesRoutes, { prefix: "/reportes" });
  await app.register(seguridadRoutes, { prefix: "/seguridad" });
  await app.register(configuracionRoutes, { prefix: "/configuracion" });
  await app.register(storageRoutes, { prefix: "/storage" });
}
