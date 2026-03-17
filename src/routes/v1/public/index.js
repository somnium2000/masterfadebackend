import agendaRoutes from "./agenda.js";
import catalogRoutes from "./catalog.js";
import citasRoutes from "./citas.js";
import plansRoutes from "./plans.js";

export default async function publicRoutes(app) {
  await app.register(catalogRoutes, { prefix: "/catalog" });
  await app.register(agendaRoutes, { prefix: "/agenda" });
  await app.register(citasRoutes, { prefix: "/citas" });
  await app.register(plansRoutes, { prefix: "/catalog/planes" });
}
