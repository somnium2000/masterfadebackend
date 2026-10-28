import { AppError } from '../utils/errors.js';

export async function findReservationGroupIds(client, { code, branchIds, barberId = null }) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(normalized)) throw new AppError(400, 'Introduce un código de reserva de cinco caracteres.', { code: 'RESERVATION_CODE_INVALID' });
  // AM: Reproduce hashString de JS (int32) sobre UUID uppercase; conserva todas las colisiones.
  const { rows } = await client.query(`
    WITH RECURSIVE scoped AS (
      SELECT DISTINCT c.id_grupo_cita FROM public.citas c
      WHERE c.deleted_at IS NULL AND c.id_grupo_cita IS NOT NULL
        AND c.id_sucursal = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR c.id_empleado_barbero = $2::uuid)
    ), hashed AS (
      SELECT id_grupo_cita, upper(id_grupo_cita::text) AS source, 0 AS pos, 0::bigint AS hash FROM scoped
      UNION ALL
      SELECT id_grupo_cita, source, pos + 1,
        mod(hash * 31 + ascii(substr(source, pos + 1, 1)), 4294967296::bigint)
      FROM hashed WHERE pos < length(source)
    )
    SELECT id_grupo_cita FROM hashed WHERE pos = length(source)
      AND mod(abs(CASE WHEN hash >= 2147483648 THEN hash - 4294967296 ELSE hash END), 60466176) = $3::bigint
    ORDER BY id_grupo_cita LIMIT 21
  `, [branchIds, barberId, parseInt(normalized, 36)]);
  if (rows.length > 20) throw new AppError(409, 'Hay demasiadas coincidencias. Contacta al administrador.', { code: 'RESERVATION_LOOKUP_TOO_MANY' });
  return rows.map((row) => row.id_grupo_cita);
}
