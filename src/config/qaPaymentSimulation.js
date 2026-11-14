const PRODUCTION_NODE_ENVS = new Set(["production", "prod", "staging", "preprod"]);
const PRODUCTION_ENTORNOS = new Set(["production", "prod", "staging", "preprod"]);

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function readStrictBoolean(value, name, fallback = false) {
  const normalized = normalize(value);
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} invalido. Usa true o false.`);
}

export function resolveQaPaymentSimulationConfig(env = process.env) {
  const nodeEnv = normalize(env.NODE_ENV);
  const entorno = normalize(env.ENTORNO);
  const paymentProvider = normalize(env.PAYMENT_PROVIDER);
  const todoPagoMode = normalize(env.TODOPAGO_MODE);
  const todoPagoSimulatedEnabled = readStrictBoolean(
    env.TODOPAGO_SIMULATED_ENABLED,
    "TODOPAGO_SIMULATED_ENABLED",
    false
  );
  const explicitlyEnabled = readStrictBoolean(
    env.ENABLE_QA_PAYMENT_SIMULATION,
    "ENABLE_QA_PAYMENT_SIMULATION",
    false
  );
  const todoPagoSimulationSelected = paymentProvider === "todopago"
    && todoPagoMode === "preprod_simulated";
  const productionRuntime = PRODUCTION_NODE_ENVS.has(nodeEnv)
    || PRODUCTION_ENTORNOS.has(entorno);

  if (todoPagoSimulationSelected && productionRuntime) {
    throw new Error("TodoPago simulado esta prohibido en produccion/staging.");
  }

  const qaRuntimeAuthorized = nodeEnv === "development"
    && entorno === "qa"
    && todoPagoSimulationSelected
    && todoPagoSimulatedEnabled;

  if (explicitlyEnabled && !qaRuntimeAuthorized) {
    throw new Error(
      "ENABLE_QA_PAYMENT_SIMULATION requiere NODE_ENV=development, ENTORNO=qa, PAYMENT_PROVIDER=todopago y TodoPago simulado activo."
    );
  }

  if (entorno === "qa" && todoPagoSimulationSelected && !explicitlyEnabled) {
    throw new Error("TodoPago simulado en QA requiere ENABLE_QA_PAYMENT_SIMULATION=true.");
  }

  return Object.freeze({
    enabled: explicitlyEnabled && qaRuntimeAuthorized,
  });
}

export function resolveQaVipPurchaseSimulationConfig(env = process.env) {
  const nodeEnv = normalize(env.NODE_ENV);
  const entorno = normalize(env.ENTORNO);
  const paymentProvider = normalize(env.PAYMENT_PROVIDER);
  const todoPagoMode = normalize(env.TODOPAGO_MODE);
  const todoPagoSimulatedEnabled = readStrictBoolean(
    env.TODOPAGO_SIMULATED_ENABLED,
    "TODOPAGO_SIMULATED_ENABLED",
    false
  );
  const qaPaymentSimulationEnabled = readStrictBoolean(
    env.ENABLE_QA_PAYMENT_SIMULATION,
    "ENABLE_QA_PAYMENT_SIMULATION",
    false
  );
  const membershipSimulatorEnabled = readStrictBoolean(
    env.MEMBERSHIP_PAYMENT_SIMULATOR_ENABLED,
    "MEMBERSHIP_PAYMENT_SIMULATOR_ENABLED",
    false
  );
  const explicitlyEnabled = readStrictBoolean(
    env.ENABLE_QA_VIP_PURCHASE_SIMULATION,
    "ENABLE_QA_VIP_PURCHASE_SIMULATION",
    false
  );
  const productionRuntime = PRODUCTION_NODE_ENVS.has(nodeEnv)
    || PRODUCTION_ENTORNOS.has(entorno);

  if (productionRuntime && (membershipSimulatorEnabled || explicitlyEnabled)) {
    throw new Error("La simulacion de compra VIP esta prohibida en produccion/staging.");
  }

  if (!explicitlyEnabled) return Object.freeze({ enabled: false });

  const enabled = nodeEnv === "development"
    && entorno === "qa"
    && paymentProvider === "todopago"
    && todoPagoMode === "preprod_simulated"
    && todoPagoSimulatedEnabled
    && qaPaymentSimulationEnabled
    && membershipSimulatorEnabled;

  if (!enabled) {
    throw new Error(
      "ENABLE_QA_VIP_PURCHASE_SIMULATION requiere NODE_ENV=development, ENTORNO=qa, PAYMENT_PROVIDER=todopago, TODOPAGO_MODE=preprod_simulated, TODOPAGO_SIMULATED_ENABLED=true, ENABLE_QA_PAYMENT_SIMULATION=true y MEMBERSHIP_PAYMENT_SIMULATOR_ENABLED=true."
    );
  }

  return Object.freeze({ enabled: true });
}
