import fp from "fastify-plugin";
import { createAgendaEventDispatcher } from "../services/agendaEventDispatcher.js";

export default fp(async function agendaRealtimePlugin(app) {
  const settings = app.config?.agendaSse || {};
  const disabledApi = {
    enabled: false,
    canAcceptConnection() {
      return { ok: false, reason: "disabled" };
    },
    async start() {},
    async stop() {},
    getStats() {
      return { running: false, subscribers: 0 };
    },
  };

  if (!settings.enabled) {
    app.decorate("agendaRealtime", disabledApi);
    return;
  }

  const dispatcher = createAgendaEventDispatcher({
    pool: app.db,
    config: settings,
    logger: app.log,
  });

  app.decorate("agendaRealtime", {
    enabled: true,
    ...dispatcher,
  });

  app.addHook("onReady", async () => {
    await dispatcher.start();
  });

  app.addHook("onClose", async () => {
    await dispatcher.stop();
  });
}, {
  name: "agenda-realtime-plugin",
  dependencies: ["env-plugin", "db-plugin"],
});
