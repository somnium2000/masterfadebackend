import fp from "fastify-plugin";
import {
  classifyExpiryAlert,
  listActiveSubscriptionsForAlerts,
  registerSubscriptionAlertEvent,
  summarizeCriticalBalance,
} from "../services/membershipService.js";

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseInterval(value, fallback = 60 * 60 * 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(15000, Math.floor(parsed));
}

async function getConsumptionRows(client, idSuscripcion) {
  try {
    const { rows } = await client.query(
      `
        SELECT
          item_tipo,
          id_servicio,
          item_codigo,
          item_nombre,
          cantidad,
          coverage_status
        FROM public.subscription_consumptions
        WHERE id_suscripcion = $1::uuid
      `,
      [idSuscripcion]
    );
    return rows;
  } catch (error) {
    // AM: Degradación segura para entornos con migración parcial de membresías.
    if (["42P01", "42703", "42704"].includes(String(error?.code || ""))) {
      return [];
    }
    throw error;
  }
}

async function processMembershipAlertsTick(app) {
  if (!app.mailer?.configured) return;

  const client = await app.db.connect();
  try {
    const subscriptions = await listActiveSubscriptionsForAlerts(client);
    for (const row of subscriptions) {
      const email = String(row?.correo_principal || "").trim();
      if (!email) continue;

      const subscriptionId = row.id_suscripcion;
      const planName = row.nombre_plan || "Plan MasterFade";
      const fullName = row.nombre_cliente || "Cliente";

      try {
        const expiryInfo = classifyExpiryAlert(row, { thresholdDays: 3 });
        if (expiryInfo.should_notify) {
          const canSendExpiry = await registerSubscriptionAlertEvent(client, {
            idSuscripcion: subscriptionId,
            alertType: "vencimiento_3_dias",
            payload: {
              dias_restantes: expiryInfo.dias_restantes,
              horas_restantes: expiryInfo.horas_restantes,
              minutos_restantes: expiryInfo.minutos_restantes,
            },
          });

          if (canSendExpiry) {
            void app.mailer.sendMembershipExpiryWarningEmail({
              to: email,
              fullName,
              planName,
              endAt: row.fin_at,
              daysRemaining: expiryInfo.dias_restantes,
            });
          }
        }

        const consumptionRows = await getConsumptionRows(client, subscriptionId);
        const balanceSummary = summarizeCriticalBalance(row.beneficios_snapshot, consumptionRows);

        if (balanceSummary.is_critical_1_1) {
          const canSendCritical = await registerSubscriptionAlertEvent(client, {
            idSuscripcion: subscriptionId,
            alertType: "saldo_1_1",
            payload: {
              servicios_restantes: balanceSummary?.totales?.servicios_restantes ?? 0,
            },
          });

          if (canSendCritical) {
            // AM: Alerta crítica centrada en remanente de servicios operativos.
            void app.mailer.sendMembershipCriticalBalanceEmail({
              to: email,
              fullName,
              planName,
              serviciosRestantes: balanceSummary?.totales?.servicios_restantes ?? 1,
            });
          }
        }
      } catch (subscriptionError) {
        app.log.error(
          { err: subscriptionError, id_suscripcion: subscriptionId },
          "Fallo procesando alertas de membresia para suscripcion"
        );
      }
    }
  } finally {
    client.release();
  }
}

async function membershipAlertsPlugin(app) {
  const enabled = parseBool(process.env.MEMBERSHIP_ALERTS_ENABLED, true);
  if (!enabled) {
    app.log.info("Scheduler de alertas de membresias deshabilitado");
    return;
  }

  if (!app.db) {
    app.log.warn("Scheduler de alertas de membresias omitido: DB no configurada");
    return;
  }

  const intervalMs = parseInterval(process.env.MEMBERSHIP_ALERTS_INTERVAL_MS, 60 * 60 * 1000);
  const timer = setInterval(() => {
    processMembershipAlertsTick(app).catch((error) => {
      app.log.error({ err: error }, "Fallo en scheduler de alertas de membresias");
    });
  }, intervalMs);

  timer.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(timer);
  });

  // Primer tick en segundo plano para ambientes con reinicios frecuentes.
  void processMembershipAlertsTick(app).catch((error) => {
    app.log.error({ err: error }, "Fallo en tick inicial de alertas de membresias");
  });

  app.log.info({ intervalMs }, "Scheduler de alertas de membresias habilitado");
}

export default fp(membershipAlertsPlugin, { name: "membership-alerts-plugin" });
