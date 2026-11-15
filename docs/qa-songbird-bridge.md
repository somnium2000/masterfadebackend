# Puente Songbird QA: implementación revisable y contrato pendiente

## Dictamen y alcance

GO para revisar y probar localmente el puente. NO-GO para una continuación 3DS real.
La configuración operativa está apagada por defecto. Ninguna variable habilita el
segundo POST Sale ni acredita el JWT. No se aplicó esta migración fuera del clúster
local descartable; no se ejecutó tráfico de PixelPay, cambios de QA ni despliegues.

Base backend: `cce81154a278438c7a1ffa75efcfc2fcb4cbf205`. El incidente QA ya
caracterizado es HTTP 202 / `songbird` / `PayloadResponse`; no se vuelve a auditar ni
se reutiliza su intent. La primera aprobación básica y el contrato financiero v2
permanecen fuera del nuevo mecanismo de autenticación.

Se trasladan del prototipo offline previo sus claims por fase, contexto canónico,
separación de autenticación y aprobación, y recuperación sin repetir operaciones.
El modelo financiero experimental del prototipo NO se traslada: se conserva v2.

## Fronteras implementadas

1. En el único inicio ya autorizado por la política QA existente, START y la reserva
   de estado Songbird se escriben en la misma transacción, antes del despacho Sale.
   Un fallo de reserva impide el despacho. No se modifica el claim financiero.
2. El adaptador Node recibe transitoriamente el payload de un 202 Songbird mediante
   un callback privado. No lo incorpora al error, respuesta inicial, telemetría ni
   evento financiero. Un fallo al guardarlo conserva la incertidumbre y no reintenta.
3. `songbirdContract.js` se conecta siempre con `browserPayloadAccredited=false`.
   El estado real resultante es `contract_blocked`, sin almacenar el payload.
   El adaptador de autenticación operativo no existe todavía: lookup/validate
   fallan cerrados. La inyección de un contrato verificado es exclusivamente un seam
   de código usado por los tests; no hay selección de contrato por HTTP o variables.
4. Con contrato SINTÉTICO, el JWT se cifra con AES-256-GCM; AAD lo liga al propietario,
   intent, attempt y orden. Un claim transaccional entrega una sola vez un lease y
   el JWT, borrando el ciphertext. Perder esa respuesta NO permite reemitirlo.
5. React usa eventos/UI del `CardinalManager` oficial 2.5.8 y un transporte cerrado
   hacia Fastify. No configura credenciales ni invoca `Transaction.doSale`.
   `retryTransaction` devuelve un fallo local, incluso ante `NOACTION`.
6. Cada lookup/validación sintético exige lease y fase, reclama la fase durable ANTES
   del transporte y no se repite tras timeout, desconexión o reinicio.
   Autenticación completa nunca crea pagos, eventos de aprobación ni confirma citas.

## Contrato HTTP propio

Únicamente `POST /v1/pagos/reservas/pixelpay/3ds/bridge`, con sesión/identidad,
cliente activo, rol, CSRF y propiedad del grupo/intent. No hay ruta pública ni proxy.
La capacidad `pixelpaySongbirdBridge` es independiente de `pixelpaySale` y VIP.
Se requiere QA/development/Sandbox SDK con endpoint y app URL `https://pixelpay.dev`,
además del target único retenido por el diagnóstico existente.

Acciones admitidas: `status`, `claim`, `setup`, `validated`, `interrupt`.
`status`/`interrupt` permiten recuperar/cerrar metadatos aun después de apagar la
capacidad o vencer su ventana. No se recibe dinero, ACS URL, identificador de
autenticación elegido por el cliente, cabeceras ni una acción Sale/finalize.
La respuesta usa `Cache-Control: private, no-store`; JWT/ciphertext no aparecen en
status. Solo claim puede entregar un payload previamente acreditado.

Estados: `awaiting_response` → `handoff_ready` → `browser_leased` →
`setup_in_flight` → `challenge_ready` → `validation_in_flight` →
`authentication_complete`. Salidas cerradas: `contract_blocked`, `interrupted`,
`expired`. Siempre `financial_finalization_enabled=false` y `can_resume=false`.

Recuperar significa consultar el estado, no reproducir un challenge ni emitir otro
JWT. Una respuesta perdida después de un claim conserva su estado ocupado. Una
respuesta tardía no revive una fase interrumpida. El cierre del navegador detiene
la sesión local; el estado durable queda reclamado hasta su cierre explícito o TTL.
No se promete recuperación automática del challenge que el proveedor no acredita.

## Caducidad, esquema y configuración futura (NO activar ahora)

- `QA_PIXELPAY_SONGBIRD_BRIDGE_ENABLED=false`, por defecto.
- Para un futuro uso aprobado: `QA_PIXELPAY_SONGBIRD_BRIDGE_ENABLED=true` y
  `QA_PIXELPAY_SONGBIRD_BRIDGE_KEY` con 32 bytes aleatorios en base64 canónico,
  exclusivamente en backend. No imprimirla, versionarla ni enviarla al frontend.
- Requiere el diagnóstico QA existente habilitado para una sola identidad/intent,
  con su ventana UTC limitada. No habilita VIP ni la Sale Sandbox ordinaria.
- La sesión dura como máximo 120 segundos, acotados por el mínimo de TODOS los holds
  protegidos que devuelve `proteger_reserva_pago_v1`. Esta RPC también acota el intent.
  Antes de cada fase se vuelven a bloquear y validar intent, citas y todos sus holds.
  Vencer/consumir un hold, cambiar propietario, grupo, orden, monto o moneda bloquea.
  No se extienden holds para mantener un desafío abierto.
- Migración pendiente: `20261115190000_pixelpay_songbird_handoff.sql`. Tabla privada,
  RLS, sin permisos para anon/authenticated; liga intent/attempt únicos y limita el
  experimento a L 1.00 HNL. No altera funciones/triggers financieros v2.
  Validar permisos del rol backend y aplicar solo en QA tras autorización separada.
- Aun con bandera, clave y tabla, el contrato congelado seguirá bloqueando JWT,
  lookup, validación y toda finalización. No es una instrucción para probar pagos.

Rollback: apagar la bandera del puente y del diagnóstico conserva los claims y
metadatos para lectura. No borrar filas, tabla, intents ni claims pendientes; no
rotar la clave con handoffs abiertos. Retirar el código posteriormente requiere
conservar primero la evidencia durable y cerrar los estados sin nuevos cobros.

## Garantías restantes que debe acreditar PixelPay

| Garantía | Evidencia necesaria y motivo del bloqueo |
| --- | --- |
| JWT inicial apto para navegador | Confirmar audiencia/emisor, TTL, alcance de sesión/orden/importe e inexistencia de autorización financiera reutilizable. Método de validación del backend y rechazo de replay. El SDK lo pasa a Cardinal; eso no acredita por sí solo estos límites. |
| Lookup y validación en Node | Contrato soportado de `/api/v2/cardinal/authentication/lookup` y `/continue`: campos EMV mínimos obtenidos del navegador, contextos/identificadores ligados a la operación inicial, autenticación/cifrado, necesidad o no de tarjeta/token, validación del JWT final y destinos ACS autorizados. El puente aún no reenvía campos EMV ni llama esos servicios. |
| Segundo POST financiero y recuperación | Explicar si el `retryTransaction` del SDK continúa la misma operación o puede crear otra Sale; qué identidad remota garantiza deduplicación, durante cuánto tiempo, y cómo recuperar pérdida de respuesta sin reenviar PAN ni repetir el cobro. Ejemplos server-side y resultados verificables aprobados/rechazados/inciertos. |

El SDK instalado demuestra que `CardinalAuthentication.retryTransaction` vuelve a
postear `api/v2/transaction/sale` o `auth`; su mutex estático es solo memoria local.
No demuestra idempotencia remota entre reinicios, pestañas o instancias.
No se debe sustituir esa garantía por un `continue_success=true` del navegador.
La aprobación futura deberá pasar por evidencia auténtica correlacionada y el
contrato durable v2 existente, sin confiar en retorno, ActionCode o éxito 3DS.

## Evidencia local reproducible

Dependencias oficiales fijadas y previamente disponibles en caché. Ningún test usa
credenciales reales, `.env`, intent histórico ni transporte del proveedor.

```text
node --test test/songbird-bridge.test.mjs test/pixelpay-sdk-node-runtime.test.mjs test/pixelpay-sale-runtime-diagnostics.test.mjs test/microfase2a2-public-pagos-routes.test.mjs test/private-commerce.test.mjs
node --test test/pixelpay-sdk-provider.test.mjs test/pixelpay-financial-evidence-contract.test.mjs test/pixelpay-callback.test.mjs
```

PostgreSQL 17 real y descartable, con `MASTERFADE_TEST_PG_BIN` apuntando al binario:
activar SOLO en ese proceso local `RUN_PAYMENT_LATE_PG_INTEGRATION=true`,
`RUN_FINANCIAL_CONTRACT_PG=true`, `RUN_PIXELPAY_SINGLE_SALE_CLAIM_PG=true`,
`RUN_PIXELPAY_SONGBIRD_PG=true`, y ejecutar:

```text
node --test test/payment-late-paid-at.postgres.test.mjs test/pixelpay-single-sale-claim.postgres.test.mjs test/songbird-bridge.postgres.test.mjs
```

Las pruebas de bridge PG verifican dos waiters reales, un solo lease, rollback,
reinicio, pérdida de respuesta, contexto/hold inválido, permisos y cero escrituras
financieras. Bloquean conexiones no locales y exigen cero intentos externos.
El runtime SDK bloquea HTTP/TLS/DNS/fetch externos; Axios solo responde fixtures.
Los tests React usan SDK real y Cardinal simulado, no un desafío bancario auténtico.
CI ejecuta también las regresiones y los tres contratos PostgreSQL; su resultado
es evidencia de software, nunca aprobación de PixelPay ni prueba 3DS completa.
