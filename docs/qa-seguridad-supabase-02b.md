# QA-SEGURIDAD-SUPABASE-02B

## A. Resumen

Corrección de la lista de cuerpos reconocidos por SEGURIDAD-02 sobre `origin/dev`, base `f11491a439ccf4341e484ae2c1a7f04a6f314a0c`. El usuario comunicó tres hashes del preflight remoto de lectura. Los tres corresponden exactamente a cuerpos activos de migraciones ya versionadas; el manifiesto anterior se basaba en snapshots anteriores a esas versiones.

La correspondencia usa el `prosrc` completo y normalización exclusiva CRLF→LF, igual que el preflight. Los hashes facilitados coinciden con los MD5 LF de las fuentes. No se ejecutó SQL remoto, no se extrajeron nuevos cuerpos remotos y no se modificaron QA/Producción, frontend, main, pagos ni reglas de MasterPuntos. La evidencia del estado remoto es la proporcionada por el usuario; las definiciones y la revisión semántica son locales y reproducibles.

## B. Archivos modificados

- `db/manual/20261113235412_seguridad_supabase_02_routine_hardening.sql`: tres ampliaciones de arrays de hashes; resto idéntico.
- `db/manual/20261113235412_seguridad_supabase_02_routine_hardening.preflight.sql`: las mismas tres ampliaciones.
- `docs/qa-seguridad-supabase-02-inventory.json` y `test/fixtures/security-supabase-02/routines.json`: procedencia de las tres variantes; definiciones y datos anteriores conservados.
- `docs/qa-seguridad-supabase-02-inventory.md` y este informe: explicación de la corrección.
- `test/security-supabase-02.pg.test.js`: asociación de hashes por firma, variantes antiguas/reportadas, negativos y protección del respaldo.
- `test/sql/security-supabase-02b-expiration-cases.sql`: regresión transaccional de vencimiento sobre datos sintéticos.

No hay endpoints afectados ni cambios de contratos API. El rollback y las migraciones comerciales permanecen sin modificaciones.

## C. Comparación y cambio aplicado

| Firma | Hash LF reconocido | Fuente activa | Observación facilitada |
| --- | --- | --- | --- |
| `public.fn_points_materialize_expired_cycles(uuid)` | `1fc9e808d8d6d56570897b5c84480144` | `db/migrations/20261030010000_masterpuntos_readonly_expiration_v1.sql:55` | QA y Producción |
| `public.fn_points_tx_guard_acumular_final()` | `6ff488db9f5a4e7843b32dd978ae529a` | `db/manual/20261113161929_masterpuntos_paid_confirmation_v1.sql:149` | QA |
| `public.fn_trg_otorgar_puntos_por_cita()` | `8270cf772d8160350926c8762482ca4b` | Mismo SQL de pago, línea 197 | QA |

Fuentes: commits `500879c6837c332c7a7ce37531ed584f0528ba12` (vencimiento) y `835ffb9c2a0779c0dfc120fac9c4040d33ab01cd` (pago confirmado). Las pruebas extraen la primera declaración activa de cada fuente y comprueban el hash fijado. El bloque comentado de reversión de vencimientos no se utiliza.

La versión de vencimientos ordena y bloquea ciclos con `FOR UPDATE`, calcula el remanente firmado del ledger, utiliza `ON CONFLICT` con el índice parcial de vencimientos y cuenta actualizaciones efectivas. Es la evolución concurrente segura de la definición de octubre reconocida antes. Conserva la separación entre lectura de saldo y materialización; no acredita citas.

La guarda de pago exige `app_private.points_appointment_paid_v1`, valida beneficiario/titular del grupo y ciclo activo de doce meses, y conserva inmutables las acreditaciones existentes en UPDATE. La acreditación depende de pago y reserva confirmados; no exige completar el servicio. Sus helpers de evidencia, cobertura de membresía y hooks diferidos permanecen intactos.

`fn_trg_otorgar_puntos_por_cita()` contiene `BEGIN RETURN NEW; END;` deliberadamente: el SQL de pago neutralizó los hooks antiguos para que finalizar una cita no vuelva a acreditar. Comparte legítimamente hash con `fn_trg_otorgar_puntos_plan_confirmada()`. El nuevo hash se agrega al array de `por_cita`, sin autorizarlo para la guarda.

Los arrays conservan las versiones anteriores para endurecer sus metadatos sin cambiar su lógica cuando existan. El SQL nunca instala una versión comercial ni transforma un cuerpo antiguo en uno nuevo. Las comprobaciones de propietario, firma/tipo, SECURITY DEFINER, esquema confiable, ACL/grantor, bindings, idempotencia y concurrencia siguen iguales. La verificación exacta del cuerpo respaldado también sigue igual: reconocer otra versión no permite rebaselinar un respaldo ni restaurar encima de una modificación posterior.

## D. Validaciones

Entorno PostgreSQL 17.11 en loopback. Resultados finales:

| Validación | Resultado |
| --- | --- |
| Tres cuerpos activos, hashes LF y correspondencia exacta con ambas listas por firma | PASS |
| QA/Producción anteriores + QA/Producción con variantes reportadas | PASS: cuatro escenarios PostgreSQL, sin omisiones |
| RLS, triggers, permisos administrativos y rechazo de cuerpos/firma incorrectos | PASS |
| Aplicación doble/concurrente, rollback doble, reapply y bloqueo de deriva contra respaldo | PASS |
| Vencimiento firmado/idempotente antes/después y tras rollback | PASS |
| Suite completa backend con PostgreSQL de seguridad habilitado | PASS: 3004 pruebas; 2984 aprobadas, 0 fallos, 20 omitidas |
| Regresión existente de pago confirmado + lecturas/vencimiento | PASS: 80 aprobadas, 0 fallos, 0 omitidas |
| ESLint | PASS: 0 errores; 25 warnings preexistentes; test modificado con max-warnings=0 |
| Revisión de alcance y diff --check | PASS |

Las 20 omisiones de la suite completa son suites/benchmark PostgreSQL existentes que requieren activación propia; no se contabilizan como aprobadas. La suite de pago se activó y ejecutó por separado. El control de fuentes/listas y los cuatro escenarios de seguridad suman cinco pruebas ejecutadas sin omisiones.

En los cuatro escenarios se conservan los resultados del Advisor local: QA 31→0 y fixture Producción 36→0 avisos de search_path; anon 2→0; authenticated 4→2 (helpers necesarios por RLS). El respaldo privado conserva su INFO esperado de RLS sin políticas. No se consultó de nuevo el Advisor alojado.

Cobertura del control: ambos manifiestos deben contener exactamente los hashes derivados del inventario por firma; se rechaza un comentario de cuerpo no revisado en cada una de las tres funciones y el cuerpo no-op puesto en la guarda. Se ejercitan cuatro reconstrucciones aisladas: QA/Producción anteriores y QA/Producción con las variantes reportadas. En cada una se verifican RLS, triggers, permisos, doble aplicación, aplicaciones concurrentes, doble rollback y reapply, preservando los cuerpos/contratos originales del escenario.

Los escenarios reportados también ejecutan vencimiento real con signo e índice parcial reales: +10−3=7, un único débito −7, reintento idempotente, aislamiento entre clientes y ciclo con remanente cero. Cada caso revierte filas e infraestructura de prueba. Se ejecuta antes/después del endurecimiento y después del rollback. No constituye una prueba adicional de concurrencia de vencimientos.

La regresión existente de pago se ejecuta con PostgreSQL local explícitamente habilitado. Sus datos y confirmaciones son sintéticos; ninguna pasarela recibe solicitudes. La suite conserva sus pruebas de pago/evidencia, VIP, grupos, duplicados/concurrencia, no_show/completada y canjes. No se modifica ese test ni sus fuentes comerciales.

Comandos reproducibles:

```powershell
$env:MASTERFADE_TEST_PG_BIN = 'C:/ruta/local/postgresql17/bin'
node --test test/security-supabase-02.pg.test.js
npm test
$env:MASTERFADE_PHASE02_PG_BIN = $env:MASTERFADE_TEST_PG_BIN
node --test test/masterpuntos-paid-confirmation.postgres.test.mjs test/masterpoints-readonly-expiration.qa-mp-01c.test.mjs
npm run lint
git diff --check
```

## E. Riesgos y pendiente manual

El SQL SEGURIDAD-02 corregido continúa pendiente de aplicación manual. Se entrega el mismo archivo con su preflight y rollback existentes. No se aplica en esta tarea ni se cambia historial remoto de migraciones.

El preflight debe volver a ejecutarse en el entorno autorizado; cualquier cuerpo, propietario, ACL o configuración todavía desconocidos debe seguir abortando. Si un respaldo anterior refleja un cuerpo distinto del presente, la ampliación de hashes no elimina ese conflicto: exige revisión manual. Se mantienen las excepciones de dos avisos autenticados necesarios por RLS y el INFO esperado del respaldo privado sin políticas descritos en SEGURIDAD-02.

La reconstrucción aislada no replica todo Supabase ni confirma HTTP RPC o propietarios/ACL remotos actuales. No hubo despliegue, merge ni cambios históricos/comerciales. Los cambios concurrentes locales de package.json/package-lock.json del checkout original se preservaron.
