import agendaRoutes from "./agenda.js";
import agendaEventosRoutes from "./agendaEventos.js";
import catalogRoutes from "./catalog.js";
import citasRoutes from "./citas.js";
import pagosRoutes from "./pagos.js";
import plansRoutes from "./plans.js";

export default async function publicRoutes(app) {
  await app.register(catalogRoutes, { prefix: "/catalog" });
  await app.register(agendaRoutes, { prefix: "/agenda" });
  await app.register(agendaEventosRoutes, { prefix: "/agenda" });
  await app.register(citasRoutes, { prefix: "/citas" });
  await app.register(pagosRoutes, { prefix: "/pagos" });
  await app.register(plansRoutes, { prefix: "/catalog/planes" });
}
