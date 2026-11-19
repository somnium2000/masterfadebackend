# QA-AGENDAMIENTO-UI-PRIVACIDAD-01 — Backend

Fecha: 13 de noviembre de 2026. Base `origin/dev`: `835ffb9c2a0779c0dfc120fac9c4040d33ab01cd`. Trabajo aislado del checkout ServiciosB y de los cambios locales/concurrentes.

## A. Resumen backend

Se auditó `GET /v1/public/agenda/horarios` y se reforzó la salida del diagnóstico autorizado con una lista explícita de campos técnicos. La respuesta normal ya proyectaba horarios, tarifas y barbero público sin datos personales de otros clientes. Se conservan disponibilidad, solapamientos, selección de barberos y permisos actuales.

No hay cambios a reglas de negocio, consultas SQL, Supabase, MasterPuntos, pagos, main ni Producción. No se aplicó SQL remoto ni se ejecutó despliegue.

## B. Archivos modificados

- `src/routes/v1/public/agenda.js`
- `test/public-agenda-privacy.qa-ui.test.mjs`
- `docs/qa-agendamiento-ui-privacidad-01.md`

## C. Endpoint afectado y auditoría

`GET /v1/public/agenda/horarios`, incluido `debug=true`:

- `mapSlotsForResponse` y el esquema de respuesta enumeran campos de hora, duración y disponibilidad; no propagan filas de citas.
- Las consultas de ocupación en `getBusyIntervalsForBarber` seleccionan intervalos y estado de cita. No consultan nombres, contacto, correo, teléfono ni identificador del cliente. La prueba incluye columnas adicionales con datos privados sintéticos para detectar cualquier propagación accidental.
- `barbero` contiene el perfil público del profesional, necesario para seleccionarlo; no identifica a los clientes que ocupan horarios.
- Para visitante y Cliente, debug permanece null incluso si solicitan `debug=true`.
- Se conservan los roles existentes admitidos por `canExposeSlotDebug`: admin, super_admin y barbero. No se modifican rutas ni pantallas administrativas.
- El diagnóstico dejaba pasar `discarded_slots` completos. Se sustituye esa propagación por campos explícitos: código conocido, fechas válidas y métricas numéricas de duración/residuos. Se conservan las razones técnicas de cierre y horario no publicado; texto libre y propiedades anidadas ajenas se eliminan.
- El resumen de razones sigue contando todos los descartes. La lista detallada conserva su límite de 120; el ranking curado no cambia.

## D. Cambios aplicados

`mapDiscardedSlotsForResponse` se incorpora dentro del módulo existente de agenda. No se crean módulos funcionales nuevos. La validación financiera, las reservas y el servicio compartido de disponibilidad permanecen intactos. La respuesta pública mantiene su contrato; el diagnóstico autorizado conserva los campos técnicos actuales y deja de admitir propiedades arbitrarias.

## E. Validaciones realizadas

**47 PASS, 0 FAIL, 0 omitidas**, ejecutando:

```powershell
node --test test/public-agenda-privacy.qa-ui.test.mjs test/microfase2a2-fastify.test.mjs test/agenda-published-schedule-contract.test.mjs test/agenda-curated-operational-timezone.test.mjs test/admin-booking-service.test.mjs test/booking-hold-orchestration.test.mjs
npx eslint src/routes/v1/public/agenda.js test/public-agenda-privacy.qa-ui.test.mjs
node --check src/routes/v1/public/agenda.js
node --check test/public-agenda-privacy.qa-ui.test.mjs
git diff --check
```

Cobertura nueva: diez combinaciones de rol/debug; ocupaciones y bloqueos siguen excluyendo sus horarios; diagnóstico técnico disponible para los roles permitidos; datos privados ausentes en JSON; eliminación de PII anidada, códigos y fechas de texto libre; validación de query con 400 sin consultar disponibilidad. Las regresiones incluyen horarios publicados, zonas horarias, selección de paquetes/mixed, funciones administrativas y orquestación de holds.

Las pruebas montan Fastify y los servicios reales con respuestas SQL sintéticas. No conectan a una base ni a servicios externos. Se utiliza el manejador global real para validar errores de entrada. Los primeros fallos fueron de preparación del fixture: orden de detección de consultas CTE y falta de ese manejador, corregidos sin cambiar la aplicación.

ESLint, sintaxis Node y `git diff --check`: **PASS**. El backend no declara script de build.

## F. Riesgos pendientes

La verificación es local; no se accedió al entorno remoto. Un consumidor que dependiera de metadatos arbitrarios no documentados de debug dejará de recibirlos. Los motivos, horarios, métricas y ranking conocidos se mantienen y están cubiertos por regresión.

No hay migración SQL pendiente para este ticket. La publicación se limita a `origin/dev`, sin merge ni despliegue.

## G. Impacto frontend

El frontend reemplaza mensajes con nombres por «Horario no disponible: coincide con otra cita del grupo», conserva el bloqueo real y elimina nombres de los avisos de recuperación. Se prueban fotos, selección de barbero, tooltips y árbol accesible en Chrome. El detalle de archivos y resultados visuales está en el informe homónimo del repositorio frontend.
