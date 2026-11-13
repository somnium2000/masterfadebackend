# Cierre de conciliación PixelPay — 13/11/2026

Base revisada: `main` con PR #95 y #99 (`8a6913cc1c116d1bbb8bfa52917d94a4c5086a89`). Validación local, sin operaciones PixelPay reales, cambios en Supabase, configuración, despliegues ni habilitación de compras. Este documento no acredita disponibilidad productiva completa.

## Estados financieros distintos

| Estado | Evidencia necesaria | Lo que no demuestra |
| --- | --- | --- |
| A. Aprobación PixelPay | Respuesta de Sale aprobada y verificada, con identidad, hash e importes consistentes | Que la transacción local haya terminado ni que el banco haya depositado fondos |
| B. Registro y conciliación MasterFade | Evento durable verificable, `paid_at` canónico, pago e intent consistentes, cita o membresía aplicada una sola vez | Liquidación, comisión final, importe neto o depósito bancario |
| C. Acreditación bancaria | Liquidación oficial correlacionada con el abono del banco | No se deduce de HTTP 200, Status `paid`/`COMPLETED`, callback o pago local capturado |

## Continuidad con nuevas compras suspendidas

Hallazgos reproducidos con el plugin y los routers reales, sin investigar IP, Traefik ni elegibilidad:

- El callback `POST /v1/pagos/webhook/:proveedor` queda excluido del guard comercial. Con el piloto suspendido, el receptor PixelPay conserva su flag propio, firma observacional y validaciones financieras. La prueba de callback completo recibe HTTP 200 y registra `pixelpay.order_callback.received`; los reenvíos conservan idempotencia. Su resultado `processed:false, extension_pending:true` no significa que la cita o membresía ya esté conciliada.
- El guard comercial actual bloquea también operaciones existentes: `POST /v1/public/pagos/estado`, `/v1/public/pagos/pixelpay/status`, sus equivalentes autenticados `/v1/pagos/reservas/...` y `POST /v1/cliente/planes/pago-intent/:id_payment_intent/estado`. Con sesión y CSRF válidos, todos devuelven `403 PRIVATE_COMMERCE_RESTRICTED` antes de acceder al negocio o inicializar el proveedor. **La continuidad de conciliación por estas rutas no está resuelta.**
- Las compras nuevas permanecen bloqueadas: creación de intents, Sale de reservas, orden de membresía y confirmación de su pago. No se ha eximido ninguna ruta para obtener resultados artificialmente aprobados.
- Las lecturas de reportes conservan sus guardas. La ruta real `GET /v1/admin/reportes/contexto` responde 200 a `super_admin`, 403 a cliente y 401 sin sesión. La prueba autorizada ejecuta solo SELECT sobre fixtures; no acredita por sí sola todas las sumas financieras ni el runtime productivo.

`ADMIN_DATA_ENTRY_MODE` es otro control: además de su lista de rutas permitidas, `src/app.js` omite el registro de `membershipAlerts` cuando está activo. Ese scheduler procesa alertas/ciclo de vida; no debe asumirse que proporciona recuperación de pagos pendientes. Desactivar compras mediante el piloto y activar el modo administrativo no son operaciones equivalentes. No se ha cambiado ninguno de estos controles.

Pruebas de continuidad añadidas: `test/private-commerce.test.mjs`, **29 PASS, 0 FAIL, 0 SKIP**; caracterizan explícitamente el bloqueo pendiente y el acceso a reportes. Regresiones ejecutadas de webhook, autorización y reportes de sucursal/membresías: **49 PASS, 0 FAIL, 0 SKIP**. La prueba HTTP de callback completo ya existe en `test/pixelpay-webhook-safety.test.mjs` con piloto suspendido. Estos resultados no convierten el bloqueo documentado en un PASS funcional.

## Caída antes de persistir evidencia

Si PixelPay aprueba y el proceso cae antes del COMMIT del evento financiero durable, MasterFade puede quedar sin la evidencia necesaria para completar B. Un intento START/FINAL aislado, una fecha del proveedor o un Status exitoso no permiten inventar el timestamp canónico ni reemplazar la evidencia exigida por los triggers financieros. Sin evento único válido, se debe conservar el estado pendiente y requerir conciliación manual respaldada por evidencia oficial; nunca ejecutar otra Sale para resolver la incertidumbre. La recuperación tras rollback con evidencia ya comprometida es un caso distinto de esta ventana sin evidencia durable.

## Trabajo separado: acceso comercial y recuperación

La habilitación pública posterior requiere un control de admisión de nuevas compras independiente del procesamiento de operaciones existentes. Debe preservar las autenticaciones, ownership y demás guardas normales de cada flujo público o autenticado; retirar el guard privado sin sustitución no constituye ese mecanismo.

Para la conciliación de operaciones existentes, definir por separado un job interno o endpoint limitado al titular/operador autorizado, con sesión y CSRF cuando corresponda, intent existente, locks, evidencia durable correlacionada, idempotencia y controles de identidad, importe y vencimiento. Ese recorrido debe carecer de capacidad de iniciar Sale. No basta eximir `/pixelpay/sale`: la misma ruta también puede crear un cargo nuevo. Tampoco basta abrir Status, que mantiene sus límites contractuales y no fabrica evidencia de Sale.

No se implementa este cambio de acceso en el presente cierre. Hasta diseñarlo y probarlo, queda un bloqueo real para conciliar operaciones existentes a través de las rutas hoy protegidas cuando se suspenden compras.

## Contrato oficial, reservas y membresías

La evidencia de soporte del 11/11/2026 confirma el estado general en `response.data.status` y los datos financieros en `response.data.last_response.data`: transacción, autorización, ambos importes, `response_approved="1"` y `response_code="00"`. El UUID corresponde a la orden consultada y la moneda a la orden original. No confirma `payment_hash` dentro de ese objeto ni la presencia obligatoria de `payment_uuid` o `response_incomplete` allí.

Las [entidades del SDK oficial](https://docs.pixelpay.com/page/sdk/responses-entities), consultadas mediante el MCP documental, describen importes double, IDs/autorización/código/UUID/hash string y señales de aprobación/interrupción boolean. Se mantiene SDK Core 2.5.8 y la validación numérica estricta; no se convierten tipos no confirmados para conseguir aprobaciones.

Correcciones respaldadas por regresiones:

- Status no acepta como completo un objeto que declara `response_incomplete:true` o un tipo incorrecto. Si el campo está presente, debe ser boolean false. Su ausencia conserva compatibilidad con el contrato comunicado.
- Si Status incluye `payment_uuid`, debe ser string e igual al UUID realmente consultado, nunca al valor alternativo suministrado por el caller. Un campo ausente no se fabrica.
- Incluso con Status contractual `paid`, se conservan `approved:false`, `paymentHashValid:false`, `resultPaymentUuid:null` y la ausencia de evidencia de hash. HTTP 200 o el estado interno `COMPLETED` no autorizan pagos ni activaciones.
- Recuperación de membresías: selección de exactamente un evento financieramente válido con correlación al intento durable, proveedor, UUID, transacción, monto numérico, moneda y flags verificados, alineada con los triggers v2. Un evento anterior contradictorio no eclipsa al evento válido; dos eventos válidos requieren conciliación manual.
- El vencimiento de la orden de membresía y del intent se compara en PostgreSQL contra `recibido_at`, sin truncamiento JavaScript a milisegundos, tanto en la recuperación como en la confirmación directa.

Reservas: se conserva el hotfix #99, que usa el evento canónico y exige el FINAL aprobado/verificado. La nueva prueba integra el servicio real con triggers v2 y dos conexiones bloqueadas simultáneamente en el mismo advisory lock: una recuperación y un duplicado, sin segunda Sale. Se conservan identidad, estados, hold mínimo, slot reutilizado, vencimientos y rollback. La prueba de expiración concurrente es otro escenario y no acredita por sí sola toda la concurrencia HTTP.

Membresías: el servicio real se prueba con triggers v2 intactos, evento comprometido antes del fallo, rollback después de crear la suscripción, reintento sin proveedor, beneficios del snapshot y captura única. Las pruebas de identidad y límites de un microsegundo no se sustituyen por un mock.

Los fixtures cubren rechazo, HTTP 412, timeout y respuestas incompletas sin reintentar el cobro. Un 412 genérico no identifica una causa de BIN, tarjeta o geografía ni permite inferir que hubo aprobación. Las respuestas inciertas siguen pendientes; Status/callback pueden aportar observaciones, pero no reconstruyen evidencia durable ausente.

## Firma del callback y conciliación pendiente

Se conserva la firma entrante observacional HMAC SHA3-512 del cuerpo HTTP crudo con `secret_key`, confirmada por soporte, y la comparación criptográfica segura. El verificador implementa el candidato hexadecimal de 128 caracteres, pero falta un callback auténtico y validado que confirme codificación, prefijo, encabezado efectivamente usado y bytes crudos recibidos. Por eso no se habilita rechazo obligatorio. No registrar firmas completas, secretos o payloads sensibles para obtener esa evidencia.

La [firma de seguridad pública](https://docs.pixelpay.com/page/secure-signature) documenta solicitudes salientes; no sustituye el contrato entrante del soporte. El callback mantiene sus controles actuales y no ejecuta automáticamente confirmación/activación: recepción idempotente y registro observacional no equivalen a B.

## Reportes y precisión

Los ingresos de servicios se consultan en `payments` por `paid_at` explícito. Membresías usa `subscription_payments.paid_at`, con fallback `created_at` para legado. Los registros nuevos recuperados conservan la fecha del evento en pago, intent, orden y pago de suscripción. No se altera el legado ni se lo declara evidencia bancaria. Las comisiones operativas estimadas de los reportes no representan la comisión final del adquirente.

## Conciliación bancaria

Correladores locales disponibles: `orden_compra`, intent, grupo de citas u orden de membresía, intento/evento, `provider_session_id` / UUID, `referencia_externa` / transacción, `payments.provider_tx_id`, importe bruto `monto_hnl`, moneda y `payment_events.recibido_at` / `paid_at`. La autorización se exige en el contrato de Status pero no se persiste como correlador bancario canónico; una referencia observada de intento incierto sigue siendo no confiable.

Existe documentación oficial de [API Deposits Query](https://pixelpay.zendesk.com/hc/en-us/articles/26841477562132-API-Deposits-Query): `GET /api/v2/deposits`, referencia, importe, moneda, movimiento CREDIT/DEBIT, estado, descripción, fechas de contabilización/valor y reporting. No se llamó ese endpoint ni se implementó integración. Esa página no demuestra disponibilidad para esta cuenta/banco, correlación depósito→UUID/transacción ni detalle final de comisiones por venta. Su autenticación es distinta del SDK transaccional y no se mezcla con las firmas de Sale o callback.

La documentación de [flujo de fondos](https://pixelpay.zendesk.com/hc/es-419/articles/20372625797524--Puedo-conectar-PixelPay-a-mi-website-y-todo-lo-relacionado) diferencia ventas, cierre y acreditación menos comisión; su plazo genérico no es una garantía contractual para este comercio.

Para implementar C faltan muestras sanitizadas y contratos del adquirente/banco: cierre y lote, transacción→lote→abono, referencia bancaria, importes bruto/neto, comisión e impuestos, fechas efectivas, anulaciones, reembolsos, contracargos y ajustes. Solicitar la disponibilidad y el mapeo antes de diseñar almacenamiento o automatización. No declarar una Sale aprobada como dinero depositado.

## Validación ejecutada

| Grupo | PASS | FAIL / SKIP | Alcance |
| --- | ---: | --- | --- |
| 17 suites focalizadas | 552 | 0 / 0 | SDK real con transporte sustituido, reservas, membresías, webhook/firma, incertidumbre, idempotencia y bloqueo comercial |
| 5 suites de reportes y autorización | 34 | 0 / 0 | Contratos y autorización con fixtures; no extractos bancarios |
| Reservas/expiración PostgreSQL 17 | 57 | 0 / 0 | Servicio real, triggers financieros v2, dos recuperaciones simultáneamente esperando el mismo lock, rollback y precisión |
| Membresías PostgreSQL 17 | 15 | 0 / 0 | Sale simulada completa y duplicado, servicio real, triggers v2, snapshot de beneficios, rollback, recuperación, identidad y contención real |
| Total | 658 | 0 / 0 | Validación local, no homologación Live |

Las regresiones nuevas de Status fallaban antes del parche: señal de interrupción y UUID contradictorio. La prueba de membresías contra una copia temporal del servicio de `main` falló en 9 subcasos más el padre (4 PASS / 10 FAIL), incluidos ambos límites de un microsegundo y el evento inválido anterior; las copias se eliminaron. El test positivo de Sale simulada se agregó después y forma parte de los 15 PASS finales.

Reproducción PostgreSQL en PowerShell, sin variables de conexión externas:

```powershell
$env:RUN_PAYMENT_LATE_PG_INTEGRATION='true'
$env:RUN_FINANCIAL_CONTRACT_PG='true'
node --test test/payment-late-paid-at.postgres.test.mjs test/pixelpay-expiration-evidence.postgres.test.mjs
$env:RUN_MEMBERSHIP_RECONCILIATION_PG='true'
node --test test/membership-reconciliation.postgres.test.mjs
```

Ambos harnesses usan clusters temporales propios en loopback y PostgreSQL 17; no apuntan a Supabase. Las tablas de activación/membresías son fixtures sintéticos locales y los triggers financieros v2 son los reales, sin cambios. Esto no acredita todas las restricciones ni la versión servida del esquema productivo. El primer intento dentro del sandbox falló por `EACCES` al conectar a loopback; la ejecución local autorizada fuera de esa restricción completó los 57 PASS. No se contabilizó el intento fallido como validación financiera.

Lint completo: 0 errores y 25 advertencias preexistentes; lint del test PostgreSQL nuevo: 0 errores/advertencias. `git diff --check`: PASS. No se cambiaron triggers financieros, migraciones, datos históricos, frontend, QA, configuración ni controles de acceso comerciales.

## Pendientes para cierre operativo

1. Resolver en trabajo separado la continuidad de conciliación con compras suspendidas: actualmente las rutas de recuperación están bloqueadas y el callback no completa B automáticamente.
2. Conservar conciliación manual segura cuando no llegó a existir un evento durable, sin nuevas Sale ni fechas fabricadas.
3. Validar un callback auténtico para confirmar el formato de firma antes de activar rechazo obligatorio.
4. Obtener contratos/muestras de liquidación y depósito, sin confundir ingresos internos con acreditación bancaria.

Estos resultados no permiten declarar comercio público o conciliación automática completos. No se ha habilitado ningún piloto ni compra, ni autorizado merge o despliegue.
