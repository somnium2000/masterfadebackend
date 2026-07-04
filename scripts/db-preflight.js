import "dotenv/config";

import pool from "../src/config/db-connection.js";
import { runDatabaseSchemaPreflight } from "../src/services/databaseSchemaPreflight.js";

const logger = {
  info: (message) => console.log(message),
  error: (payload, message) => {
    const missing = Array.isArray(payload?.missing) ? payload.missing : [];
    if (missing.length) {
      console.error(message);
      console.error(JSON.stringify(missing, null, 2));
      return;
    }
    console.error(message || payload?.err?.message || "Database preflight failed");
  },
};

try {
  await runDatabaseSchemaPreflight(pool, logger);
  process.exitCode = 0;
} catch (error) {
  console.error(error?.code || "DB_PREFLIGHT_FAILED");
  console.error(error?.message || "Database preflight failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
