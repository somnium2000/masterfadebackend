const fs = require('fs');
const path = 'src/services/agendaService.js';
const content = fs.readFileSync(path, 'utf8');

const target = `      WITH active_tariffs AS (
        SELECT
          st.id_servicio,
          st.precio_hnl,
          COALESCE(st.servicio_informativo, FALSE) AS servicio_informativo,
          ROW_NUMBER() OVER (
            PARTITION BY st.id_servicio
            ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
          ) AS rn
        FROM public.servicios_tarifas st
        WHERE st.id_sucursal = $1::uuid
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND (
            ($3::uuid IS NULL AND st.id_empleado IS NULL)
            OR ($3::uuid IS NOT NULL AND st.id_empleado = $3::uuid)
          )
          AND st.vigente_desde <= CURRENT_DATE`;

const replacement = `      WITH active_tariffs AS (
        SELECT
          st.id_servicio,
          st.precio_hnl,
          COALESCE(st.servicio_informativo, FALSE) AS servicio_informativo,
          ROW_NUMBER() OVER (
            PARTITION BY st.id_servicio
            ORDER BY 
              (CASE WHEN st.id_empleado IS NOT NULL THEN 1 ELSE 2 END) ASC,
              st.vigente_desde DESC, 
              st.updated_at DESC, 
              st.id_tarifa DESC
          ) AS rn
        FROM public.servicios_tarifas st
        WHERE st.id_sucursal = $1::uuid
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND (
            st.id_empleado IS NULL OR st.id_empleado = $3::uuid
          )
          AND st.vigente_desde <= CURRENT_DATE`;

let newContent = content.replace(target, replacement);

if (newContent === content) {
    // try normalizing line endings
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const normalizedTarget = target.replace(/\r\n/g, '\n');
    newContent = normalizedContent.replace(normalizedTarget, replacement);
}

fs.writeFileSync(path, newContent, 'utf8');
console.log('SQL updated:', newContent !== content);
