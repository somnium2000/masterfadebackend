import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import pool from "../src/config/db-connection.js";
import { listOldTemporalAssets, markAssetStatus } from "../src/services/storage/storageAssetsRepo.js";

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function run() {
  const olderThanHours = Math.max(1, parseNumber(process.env.STORAGE_CLEANUP_TEMP_HOURS, 24));
  const limit = Math.max(1, Math.min(2000, parseNumber(process.env.STORAGE_CLEANUP_TEMP_LIMIT, 250)));
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas para cleanup de Storage.");
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const dbClient = await pool.connect();
  try {
    const candidates = await listOldTemporalAssets(dbClient, { olderThanHours, limit });
    if (!candidates.length) {
      console.log(`[storage-cleanup] No hay assets temporales mayores a ${olderThanHours}h.`);
      return;
    }

    console.log(`[storage-cleanup] Candidatos: ${candidates.length}`);
    for (const asset of candidates) {
      const { error } = await supabaseAdmin.storage
        .from(asset.bucket_name)
        .remove([asset.object_path]);

      if (error && !String(error.message || "").toLowerCase().includes("not found")) {
        await markAssetStatus(dbClient, {
          idAsset: asset.id_asset,
          status: "fallido",
          metadata: {
            cleanup_error: error.message || "REMOVE_FAILED",
            cleanup_at: new Date().toISOString(),
          },
        });
        console.warn(`[storage-cleanup] Fallo remove ${asset.id_asset}: ${error.message}`);
        continue;
      }

      await markAssetStatus(dbClient, {
        idAsset: asset.id_asset,
        status: "eliminado",
        deletedAt: new Date().toISOString(),
        metadata: {
          cleanup_at: new Date().toISOString(),
        },
      });
      console.log(`[storage-cleanup] Eliminado ${asset.id_asset}`);
    }
  } finally {
    dbClient.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error("[storage-cleanup] Error:", error.message || error);
  process.exit(1);
});
