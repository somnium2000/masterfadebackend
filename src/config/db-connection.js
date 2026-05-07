import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string") return "";
  return value.trim();
}

function maskUser(user) {
  if (!user) return "<empty>";
  if (user.length <= 6) return `${user.slice(0, 2)}***`;
  return `${user.slice(0, 5)}...<masked>`;
}

function parseDatabaseName(pathname) {
  const raw = (pathname || "").replace(/^\/+/, "");
  return raw || "postgres";
}

function parseTargetFromDatabaseUrl(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      "DATABASE_URL no es valida. Usa formato postgresql://usuario:password@host:puerto/db"
    );
  }

  return {
    source: "DATABASE_URL",
    host: url.hostname,
    port: url.port ? toInt(url.port, 5432) : 5432,
    user: decodeURIComponent(url.username || ""),
    database: parseDatabaseName(url.pathname)
  };
}

function parseTargetFromDbEnv() {
  const host = trimEnv("DB_HOST");
  const user = trimEnv("DB_USER");
  const password = process.env.DB_PASSWORD;
  const database = trimEnv("DB_NAME") || "postgres";
  const port = toInt(process.env.DB_PORT, 5432);

  const missing = ["DB_HOST", "DB_USER", "DB_PASSWORD"].filter((key) => {
    const value = process.env[key];
    return value == null || String(value).trim() === "";
  });

  if (missing.length) {
    throw new Error(
      `Faltan variables DB requeridas: ${missing.join(", ")}. Configura DATABASE_URL o DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME.`
    );
  }

  return {
    source: "DB_*",
    host,
    port,
    user,
    password,
    database
  };
}

function isSupabasePoolerHost(host = "") {
  return host.toLowerCase().includes("pooler.supabase.com");
}

function isSupabaseDirectHost(host = "") {
  const value = host.toLowerCase();
  return value.startsWith("db.") && value.endsWith(".supabase.co");
}

function isPoolerTarget(target) {
  return isSupabasePoolerHost(target.host) || Number(target.port) === 6543;
}

function isDirectTarget(target) {
  return isSupabaseDirectHost(target.host) || Number(target.port) === 5432;
}

function hasPoolerUserSuffix(user = "") {
  const parts = String(user).split(".");
  return parts.length >= 2 && parts[0] && parts[parts.length - 1];
}

function getSupabaseProjectRefFromEnv() {
  const supabaseUrl = trimEnv("SUPABASE_URL");
  if (!supabaseUrl) return "";

  try {
    const url = new URL(supabaseUrl);
    const [projectRef] = (url.hostname || "").split(".");
    return projectRef || "";
  } catch {
    return "";
  }
}

export function getSupabaseDbConnectionHints() {
  return [
    "Pooler (recomendado para backend persistente): host aws-0-<region>.pooler.supabase.com con puerto 5432 (session) o 6543 (transaction).",
    "User en pooler: postgres.<PROJECT_REF> (ej: postgres.pdzsmkjnyazpkoocjbpw).",
    "Direct: host db.<PROJECT_REF>.supabase.co con puerto 5432.",
    "Asegura SSL: ssl: { rejectUnauthorized: true } y configura DB_SSL_CA_BASE64 si tu entorno requiere CA explicita."
  ].join(" ");
}

function resolveSslConfig() {
  const isProduction = String(process.env.NODE_ENV || process.env.ENTORNO || "").toLowerCase() === "production";
  const sslEnabledRaw = String(process.env.DB_SSL ?? "").trim().toLowerCase();
  const sslEnabled = sslEnabledRaw
    ? ["1", "true", "yes", "on", "require"].includes(sslEnabledRaw)
    : true;

  if (!sslEnabled) {
    if (isProduction) {
      throw new Error("DB_SSL no puede estar desactivado en produccion.");
    }
    return false;
  }

  const rejectUnauthorizedRaw = String(process.env.DB_SSL_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase();
  const rejectUnauthorized = rejectUnauthorizedRaw
    ? ["1", "true", "yes", "on"].includes(rejectUnauthorizedRaw)
    : isProduction;

  const caBase64 = trimEnv("DB_SSL_CA_BASE64");
  if (caBase64) {
    return {
      rejectUnauthorized,
      ca: Buffer.from(caBase64, "base64").toString("utf-8"),
    };
  }

  return { rejectUnauthorized };
}

function validateSupabaseTarget(target) {
  const port = Number(target.port);

  if (isSupabasePoolerHost(target.host)) {
    // Pooler: permitir SESSION (5432) o TRANSACTION (6543)
    if (port !== 5432 && port !== 6543) {
      throw new Error(
        `Configuracion DB invalida: host de pooler (${target.host}) debe usar puerto 5432 (session) o 6543 (transaction). ${getSupabaseDbConnectionHints()}`
      );
    }
    return; // OK
  }

  if (isSupabaseDirectHost(target.host) && Number(target.port) !== 5432) {
    throw new Error(
      `Configuracion DB invalida: host directo (${target.host}) debe usar puerto 5432. ${getSupabaseDbConnectionHints()}`
    );
  }

  if (isPoolerTarget(target) && !hasPoolerUserSuffix(target.user)) {
    throw new Error(
      `Configuracion DB invalida para pooler Supabase: el usuario '${target.user || "<empty>"}' debe incluir el PROJECT_REF (ej. postgres.<PROJECT_REF>). ${getSupabaseDbConnectionHints()}`
    );
  }

  if (isPoolerTarget(target)) {
    const projectRef = getSupabaseProjectRefFromEnv();
    const userProjectRef = String(target.user || "").split(".").pop();

    if (projectRef && userProjectRef && projectRef !== userProjectRef) {
      throw new Error(
        `Configuracion DB invalida para pooler Supabase: DB_USER usa PROJECT_REF '${userProjectRef}' pero SUPABASE_URL apunta a '${projectRef}'. ${getSupabaseDbConnectionHints()}`
      );
    }
  }

  if (isDirectTarget(target)) {
    // Conexion directa a Supabase permite usuario normal (ej. postgres).
  }
}

function getPoolOptions() {
  return {
    connectionTimeoutMillis: toInt(process.env.DB_CONNECT_TIMEOUT_MS, 5000),
    idleTimeoutMillis: toInt(process.env.DB_IDLE_TIMEOUT_MS, 10000),
    max: toInt(process.env.DB_POOL_MAX, 10)
  };
}

function resolveDbSettings() {
  const databaseUrl = trimEnv("DATABASE_URL");
  const poolOptions = getPoolOptions();
  const sslConfig = resolveSslConfig();

  if (databaseUrl) {
    const target = parseTargetFromDatabaseUrl(databaseUrl);
    validateSupabaseTarget(target);

    return {
      target,
      pgConfig: {
        connectionString: databaseUrl,
        ssl: sslConfig,
        ...poolOptions
      }
    };
  }

  const envTarget = parseTargetFromDbEnv();
  validateSupabaseTarget(envTarget);

  return {
    target: {
      source: envTarget.source,
      host: envTarget.host,
      port: envTarget.port,
      user: envTarget.user,
      database: envTarget.database
    },
    pgConfig: {
      host: envTarget.host,
      port: envTarget.port,
      user: envTarget.user,
      password: envTarget.password,
      database: envTarget.database,
      ssl: sslConfig,
      ...poolOptions
    }
  };
}

export function getDbConfig() {
  return resolveDbSettings().pgConfig;
}

export function getDbTargetInfo() {
  return resolveDbSettings().target;
}

export function getSanitizedDbTarget() {
  const target = getDbTargetInfo();
  return {
    source: target.source,
    host: target.host || "<empty>",
    port: target.port,
    database: target.database || "postgres",
    user: maskUser(target.user)
  };
}

const pool = new Pool(getDbConfig());

// AM: Fuerza UTF-8 por conexion para preservar caracteres Unicode (incluida la letra ñ)
// de forma consistente entre app y PostgreSQL.
pool.on("connect", (client) => {
  client.query("SET client_encoding TO 'UTF8'").catch(() => {});
});

export default pool;
