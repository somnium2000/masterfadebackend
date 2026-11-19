# Hotfix: identificación durable de intentos QA

La selección en memoria de isQa3dsIntent desaparecía al apagar la sesión. Ahora
START inserta qa_test_origin en app_private.pixelpay_sale_attempts dentro de la misma
transacción del claim, antes de COMMIT/despacho. Valores: sandbox_session o
3ds_diagnostic; ordinarios e históricos conservan NULL. No hay backfill.

La migración 20261115233000_pixelpay_qa_test_origin.sql agrega la columna y un trigger
que impide cambiar la marca o borrar una fila marcada. FINAL y finanzas no modifican
la columna. No cambia privilegios, v2, RPC de claim, flags predeterminados ni #124.
No requiere migración frontend ni un registro de UUID por operación.

Las dos rutas /pixelpay/status comparten handler y consultan la marca después de
validar propiedad. Un intento QA sin aprobación durable devuelve
QA_3DS_EXTERNAL_STATUS_DISABLED sin construir/despachar Status. Con referencias
canónicas y prueba v2 auténtica, se usa la recuperación DB-only existente. /estado
devuelve las marcas y pending_confirmation desde DB, aunque no haya configuración
QA ni contexto del navegador. Sale también rechaza un START QA ya marcado.

El frontend incorpora las marcas al contexto permitido. Si una pestaña nueva llama
Status sin haber recuperado su contexto, el rechazo backend provoca únicamente la
consulta local /estado. Las siguientes verificaciones permanecen locales, sin otra
Sale. Nunca guarda payloads, JWT, datos de tarjeta ni información adicional.

Callbacks conservan su contrato: sin evento aprobado auténtico correlacionado ya
retornan pendiente sin Status; con contabilidad v2 cerrada #124 termina localmente.
La recuperación/cierre aprobados siguen funcionando con una fila QA marcada. Las
consultas de membresías requieren su orden VIP propia y no aceptan intents de cita.
No se habilitan rutas o permisos nuevos ni se cambia otro proveedor.

Compatibilidad: las lecturas usan una proyección JSON de la fila, de modo que un
esquema antiguo sin columna devuelve ausencia de marca. Una tabla histórica ausente
tampoco puede contener un START marcado. Un START QA nuevo exige la columna: si
falta, falla la transacción sin envío. Cualquier otro fallo de lectura se cierra con
503. Aplicar la migración QA antes de habilitar nuevas pruebas, tras autorización
separada. No se aplicó remotamente. No retirar columna/trigger ni restaurar un
runtime que ignore las marcas al apagar la sesión; conservar claims y evidencia.

Pruebas: dos intents nuevos, 202 sintético, política apagada y nueva instancia
Fastify; bloqueos de Status privado y alias público, /estado y rechazo de repetición.
PG17 usa RPC/store/migración reales, rollback, nueva conexión, independencia de filas,
inmutabilidad y ausencia de marcación histórica. La recuperación v2 y el cierre de
callbacks aprobados se verifican también con marca QA y PostgreSQL real. Los
contadores de proveedor en las pruebas deben permanecer en cero en las verificaciones
posteriores al inicio; las Sales iniciales de las fixtures son inertes, sin HTTP.
