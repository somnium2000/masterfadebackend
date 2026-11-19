import { AppError } from '../../utils/errors.js';

export const PIXELPAY_QA_ORIGINS = new Set(['sandbox_session', '3ds_diagnostic']);
export async function loadPixelPayQaOrigin(db, idIntent) {
  try {
    // AM: JSON projection keeps ordinary legacy schemas readable; a marked START requires the new column.
    const result = await db.query(`SELECT to_jsonb(a)->>'qa_test_origin' AS qa_test_origin
      FROM app_private.pixelpay_sale_attempts a WHERE a.id_intent=$1::uuid
        AND to_jsonb(a)->>'qa_test_origin' IS NOT NULL LIMIT 1`, [idIntent]);
    const origin = result.rows[0]?.qa_test_origin;
    if (origin == null) return null;
    if (PIXELPAY_QA_ORIGINS.has(origin)) return origin;
  } catch (error) {
    // AM: An absent legacy table cannot contain a marked START; all other read failures stop outbound work.
    if (error.code === '42P01') return null;
  }
  throw new AppError(503, 'No se pudo verificar el estado local del pago.', { code: 'PIXELPAY_QA_ORIGIN_UNAVAILABLE' });
}
export function pixelPayQaFlags(origin) {
  return origin ? { qa_3ds_diagnostic: true, ...(origin === 'sandbox_session' ? { qa_sandbox_session: true } : {}) } : {};
}
