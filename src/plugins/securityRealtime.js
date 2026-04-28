import fp from "fastify-plugin";

const ALLOWED_EVENTS = new Set([
  "security.sessions.changed",
  "security.alerts.changed",
]);

function createSecurityRealtimeHub() {
  const subscribers = new Map();
  let sequence = 0;

  function subscribe(listener) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    subscribers.set(id, listener);
    return () => {
      subscribers.delete(id);
    };
  }

  function publish(event) {
    if (!ALLOWED_EVENTS.has(event)) return;
    sequence += 1;
    const signal = {
      event,
      changed_at: new Date().toISOString(),
      seq: sequence,
    };

    for (const listener of subscribers.values()) {
      try {
        listener(signal);
      } catch {
        // Ignore subscriber delivery errors to avoid breaking the broadcaster.
      }
    }
  }

  return {
    subscribe,
    publish,
    allowedEvents: ALLOWED_EVENTS,
  };
}

export default fp(async function securityRealtimePlugin(app) {
  app.decorate("securityRealtime", createSecurityRealtimeHub());
});
