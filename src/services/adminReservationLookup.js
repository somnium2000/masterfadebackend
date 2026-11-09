import { AppError } from '../utils/errors.js';

// AM: Polinomio del hash int32 para los 36 caracteres del UUID; coeficientes constantes, sin input SQL.
const HASH_TERMS = Array.from({ length: 36 }, (_, index) => {
  const weight = (31n ** BigInt(35 - index)) % 4294967296n;
  return `ascii(substr(source, ${index + 1}, 1))::bigint * ${weight}`;
}).join(' + ');

export async function findReservationGroupIds(client, { code, branchIds, barberId = null }) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(normalized)) throw new AppError(400, 'Introduce un código de reserva de cinco caracteres.', { code: 'RESERVATION_CODE_INVALID' });
  // AM: Materializar evita repetir el calculo y generar 37 filas por grupo. No cambia la identidad.
  const { rows } = await client.query(`
    WITH scoped AS MATERIALIZED (
      SELECT DISTINCT c.id_grupo_cita, upper(c.id_grupo_cita::text) AS source FROM public.citas c
      WHERE c.deleted_at IS NULL AND c.id_grupo_cita IS NOT NULL
        AND c.id_sucursal = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR c.id_empleado_barbero = $2::uuid)
    ), hashed AS MATERIALIZED (
      SELECT id_grupo_cita, mod((${HASH_TERMS}), 4294967296::bigint) AS hash FROM scoped
    )
    SELECT id_grupo_cita FROM hashed
    WHERE mod(abs(CASE WHEN hash >= 2147483648 THEN hash - 4294967296 ELSE hash END), 60466176) = $3::bigint
    ORDER BY id_grupo_cita LIMIT 21
  `, [branchIds, barberId, parseInt(normalized, 36)]);
  if (rows.length > 20) throw new AppError(409, 'Hay demasiadas coincidencias. Contacta al administrador.', { code: 'RESERVATION_LOOKUP_TOO_MANY' });
  return rows.map((row) => row.id_grupo_cita);
}
