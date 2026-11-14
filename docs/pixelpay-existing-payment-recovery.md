# Conciliacion PixelPay de operaciones existentes

Base: backend main `3eddf5d9f94af62fa537d8ffd9e52446fdaf1387`, con PR #99 y #100. Este cambio no habilita compras ni depende del piloto, allowlists o Traefik.

## API autenticada independiente

| Metodo y ruta | Funcion | Limite |
| --- | --- | --- |
| GET `/v1/cliente/pagos/:id_intent` | Consultar un intent PixelPay propio existente: origen, estado, monto, moneda y paid_at | 10/minuto por IP y grupo fijo |
| POST `/v1/cliente/pagos/:id_intent/conciliar` | Recuperar reserva o membresia exclusivamente desde evidencia durable | 3/minuto por IP y grupo fijo |

El POST recibe un objeto vacio `{}`. No acepta monto, UUID, transaccion, fecha, cliente o referencias financieras del caller. Ambas respuestas usan `Cache-Control: private, no-store`. No se llama Sale, Status ni Void; no se crea intent, hold u orden. No se consulta al proveedor aunque falte evidencia.

Se conserva el bloqueo de todas las rutas comerciales originales y de los antiguos endpoints de estado que comparten esos recorridos. No hay exenciones genericas de `/v1/pagos/*` ni aperturas en rutas publicas. El nuevo router se registra separadamente y exige los siguientes controles en su propia frontera:

- Cookie de sesion vigente, JWT validado, claims actuales y rol cliente.
- Identidad de usuario/persona/cliente coherente, activa, no borrada ni anonimizada y sin eliminacion en curso.
- CSRF valido en POST, con los controles globales y validacion explicita del router.
- Propiedad por IDs persistidos. Reserva: los tres IDs del titular deben coincidir; en origen autenticado tambien debe coincidir el creador del intent. En origen publico, un creador del sistema no sustituye la comprobacion de los tres IDs del titular. Membresia: cliente y usuario de la orden coincidentes.
- Operaciones inexistentes, ajenas, ambiguas o de otro proveedor: 404 sin revelar su estado. Un rol de administrador no concede acceso global a pagos de otros clientes.
- Rate limiting por grupo e IP, sin usar el ID del intent ni query strings como llave que permita evadir el limite. La IP limita frecuencia; no autoriza la recuperacion.

## Transacciones e identidad

La autorizacion inicial se revalida antes de persistir cambios. Reserva: el recuperador recibe el owner derivado de claims, toma el advisory lock de eliminacion de cuenta antes de los locks financieros, vuelve a verificar identidad activa bajo locks y compara la titularidad dentro de la transaccion. Las llamadas internas anteriores sin ese nuevo contexto mantienen su comportamiento.

Membresia: el router inicia la transaccion, toma el advisory lock del usuario autenticado, revalida la identidad con locks compartidos y vuelve a cargar el intent propio antes de llamar al recuperador durable existente. El servicio conserva sus locks y controles de orden/identidad. En errores se hace rollback; si falla el rollback del router, la conexion se descarta.

Se mantienen los contratos de evidencia de Sale aprobada/verificada, monto, moneda, UUID, transaccion, evento unico, intento, vigencia y timestamp canonico `payment_events.recibido_at`. No se modifican triggers financieros. Se conservan microsegundos, idempotencia y la recuperacion tardia permitida por esos contratos.

## Respuestas y limites

- Conciliacion correcta: 200 con el resultado del recuperador. Un reenvio ya conciliado devuelve duplicado sin otra Sale.
- Evidencia ausente, insuficiente o fuera de vigencia: 202 con `manual_reconciliation_required:true`, sin inventar aprobacion o fecha. Otras contradicciones/control de cuenta pueden devolver un 4xx seguro; no se transforman en aprobacion.
- La consulta GET muestra el estado persistido: no demuestra deposito bancario ni crea evidencia.
- Un pago publico sin vinculacion suficiente al titular autenticado permanece para conciliacion manual autorizada. No se permite recuperar por conocer solo un correo, UUID o identificador de intent.
- `ADMIN_DATA_ENTRY_MODE` conserva su bloqueo independiente. Este PR no lo desactiva ni abre sus allowlists. Suspender nuevas compras mediante el guard comercial no equivale a activar ese modo.
- El webhook conserva su recepcion, idempotencia, validaciones y firma observacional actuales. No se convierte en un endpoint de captura automatica.
- No hay cambios de frontend: los consumidores deben usar explicitamente esta nueva API. Los antiguos recorridos mixtos de compra/estado siguen restringidos.

## Validacion local

Las pruebas HTTP usan los plugins reales de sesion, roles, CSRF, rate limiting y guard comercial con piloto suspendido. Cubren lecturas propias, recuperacion sin evidencia hacia manual, operaciones ajenas, cuenta revocada/inactiva, CSRF, roles, payload financiero rechazado y limites resistentes a variar intent/query. El factory del proveedor esta prohibido en esos tests.

Las pruebas PostgreSQL 17 existentes se amplian con ambos routers reales, sesion sintetica firmada, consultas de identidad y recuperadores reales con triggers financieros v2 intactos: captura unica, fechas exactas, duplicado, recuperacion tardia y rechazo de cambio de propietario/cuenta. Tambien conservan los casos de concurrencia y rollback anteriores. Los esquemas de activacion son fixtures locales; el fixture de reserva representa puntos al tope, sin canje ni ciclos, y no acredita MasterPuntos.

No se llama a PixelPay Live ni a Supabase; no se cambia QA o produccion. Para validar sin proveedor, usar un cluster aislado con fixtures y:

```powershell
node --test test/payment-recovery-routes.test.mjs
$env:RUN_PAYMENT_LATE_PG_INTEGRATION='true'
$env:RUN_FINANCIAL_CONTRACT_PG='true'
$env:RUN_MEMBERSHIP_RECONCILIATION_PG='true'
node --test --test-concurrency=1 test/payment-late-paid-at.postgres.test.mjs test/membership-reconciliation.postgres.test.mjs
```

Resultado final: **377 PASS** en nueve suites focalizadas y **60 PASS** en las suites PostgreSQL anteriores, **437 PASS / 0 FAIL / 0 SKIP** en total. La prueba HTTP nueva aporta 25 de esos casos con los plugins reales. No sumar otra vez las regresiones de callback incluidas en esa matriz.

Lint completo: 0 errores, 25 advertencias preexistentes; lint final de todos los archivos JavaScript modificados: 0 errores/advertencias. Diff-check: PASS. Un intento PostgreSQL previo fallo por limpieza transitoria EBUSY de un log temporal en Windows; el harness ahora aplica reintentos acotados a esa limpieza y la ejecucion final completa paso. La ejecucion secuencial de archivos no elimina la concurrencia real entre conexiones que verifican los subcasos.

Este PR solo prepara codigo para revision. No autoriza merge, despliegue, cambios de variables, apertura comercial ni operaciones Live.
