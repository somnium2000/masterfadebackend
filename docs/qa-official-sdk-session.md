# Ejemplo oficial y sesión QA Sandbox — 2026-11-15

## Resultado

GO de revisión para una sesión QA con varias operaciones iniciales independientes.
NO-GO para completar 3DS real con la separación React/Node actualmente documentada.
No se ejecutaron Sale, Status, DDC, Cardinal ni verificaciones financieras externas.
Las llamadas MCP solo leyeron documentación. No se modificó QA, producción ni sus
parámetros/variables/datos. Se parte de dev con #128 incorporado.

## Fuentes oficiales consultadas de nuevo mediante MCP

- https://docs.pixelpay.com/use-case?case=sdk%2Fpayments%2Fwithout-tokenization&lang=javascript&locale=es
- https://docs.pixelpay.com/page/sdk/requests#3ds
- https://docs.pixelpay.com/page/sdk/installation/javascript
- https://docs.pixelpay.com/page/sandbox/installation#test-cases-3ds
- Chunk MCP `es/sandbox/use-cases-sdk/payments/sale-card/javascript`.

También se leyeron los dos videos locales mediante seis capturas temporales de
cada grabación, sin controlar Chrome del usuario ni cargar páginas remotas. El
primero muestra Hosted/firma; el segundo Peticiones 3DS y venta sin tokenización.
Las muestras del segundo coinciden con el texto actual del MCP: cliente marca
withAuthenticationRequest, backend firma y ejecuta doSale. No se usa el video ni
el diagrama como prueba de que haya ocurrido una autenticación real.

## Reproducción literal, sin sustituir métodos del SDK

`test/fixtures/officialPixelPaySale.mjs` conserva Settings, Order, Item, Card,
Billing, SaleTransaction, withAuthenticationRequest y Transaction.doSale del
ejemplo. Solo sustituye endpoint, credenciales e identidad por valores sintéticos,
y precio por L 1 (caso oficial Sandbox #1). Vencimiento 07/2028 procede del ejemplo
SDK; no se inventa otro. Usa namespace público del SDK para que Node ESM resuelva
los imports: las rutas individuales sin extensión del snippet no son portables a
Node ESM sin adaptación del import. Se ejecuta una alternativa async/await; no se
ejecuta además el ejemplo callback, que sería una segunda invocación comercial.

El único reemplazo de red es Axios.defaults.adapter, frontera de transporte que el
SDK real hereda al construir sus clientes. No se parchean doSale, post, get,
buildRequest, Helpers, CardinalManager ni retryTransaction. Se comprueba que los
métodos originales conservan su identidad. En navegador se simula SOLO el script
externo y los eventos de Cardinal. Eso no acredita un DDC/challenge bancario real.
Los guardas de socket/fetch/XHR exigen cero salidas reales.

| Prueba con SDK oficial 2.5.8 intacto | Observación |
| --- | --- |
| Node, venta básica, HTTP 200 sintético | Construye modelos, obtiene public key y cifra de forma nativa; devuelve TransactionResult. |
| Node, authentication_request=true | Lanza `This platform not support 3DS transactions` antes del POST Sale. El traslado JSON reconstruido del request no cambia esa comprobación. |
| Node, sin flag, HTTP 202/songbird sintético | Tras un POST inicial, falla por `document is not defined`. No es una nueva reproducción financiera del incidente. |
| Browser, ejemplo completo con credenciales sintéticas | doSale nativo inicia script Songbird, setup, lookup, challenge y continue. Las peticiones llevan x-auth-key/x-auth-hash configurados. |
| Browser, sin credenciales | No inicia su petición HTTP: firma por orden sola no sustituye la configuración de autenticación del servicio. |
| setupSandbox | El propio SDK configura credenciales públicas de prueba; son distintas de credenciales privadas del comercio. No se afirma que necesite Secret Key real para todo Sandbox. |
| Continue success=true o false | En ambos casos el SDK nativo intenta otro POST Sale. La prueba observa y bloquea ese intento en transporte; no lo despacha. Mantiene orden/monto/moneda y agrega authentication_identifier. |
| TransactionResult.validateResponse | También acepta PaymentDeclinedResponse y TimeoutResponse. No equivale a aprobación ni verificación financiera. |
| verifyPaymentHash en browser | El SDK lo rechaza; la acreditación financiera debe seguir en backend. |

No se usa el adaptador interno del puente #128 para obtener estos resultados. Su
contrato permanece cerrado y la continuación financiera continúa inaccesible.

## Separación mínima que falta

El SDK crea CardinalManager con las mismas Settings y la transacción; lookup y
continue heredan autenticación, y retryTransaction vuelve a postear Sale. El
diagrama de Peticiones no proporciona una API pública para entregar la respuesta
202 del Node a ese doSale del navegador sin iniciar otra Sale, ni un transporte
server-side soportado de lookup/continue/retry con contexto ligado al primer envío.
No se envían credenciales privadas/hash reutilizable del comercio a React y no se
crea proxy genérico. Tampoco se modifica el SDK para saltar sus comprobaciones.

Solicitar a PixelPay un ejemplo React + Node ejecutable para la versión instalada:
entrada pública para continuar el 202 existente, datos y autenticación del
lookup/continue, validación de JWT/ACS y mecanismo remoto que identifique/deduplique
el segundo POST incluso tras reinicios/pérdida de respuesta. Además debe explicar
por qué se reintenta Sale después de continue.success=false y la versión/forma
soportada de detener ese caso. Mismo order_id y mutex en memoria no prueban
idempotencia remota. No se habilita ese segundo POST a ciegas.

## Modo QA de activación única (solo preparar; NO activar ahora)

Conserva la cuenta interna ya autorizada por QA_PRIVATE_COMMERCE_USER_ID, sesión
activa, cliente activo, rol cliente, CSRF, dueño del grupo/intent y negocio canónico.
Las IP/cabeceras de origen no conceden permiso. No habilita VIP, simuladores ni Live.

Después de revisión, autorización y despliegue separados, el operador configura UNA
vez por sesión:

```text
QA_PIXELPAY_SANDBOX_SESSION_ENABLED=true
QA_PIXELPAY_SANDBOX_SESSION_UNTIL=<UTC ISO de cierre, máximo cuatro horas desde activación>
QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED=false
QA_PRIVATE_COMMERCE_SANDBOX_SALE_ENABLED=false
QA_PRIVATE_COMMERCE_SALE_ENABLED=false
PRIVATE_COMMERCE_PILOT_ENABLED=false
QA_PIXELPAY_SONGBIRD_BRIDGE_ENABLED=false
```

Requiere las condiciones QA existentes: NODE_ENV=development, ENTORNO=qa,
PixelPay SDK Sandbox, endpoint/app URL pixelpay.dev y booking por identidad activo.
No requiere QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID, cambios por reserva ni nueva
bandera pública. Un restart conserva la caducidad fija; no renueva la sesión.
Solo se aceptan intents creados desde el arranque que activó el modo, nuevos, sin
attempt previo, sin sesión Hosted/referencia externa, con orden canónica y L 1 HNL.
No se reutilizan operaciones históricas. Claims/START y evidencia v2 permanecen.
Un 202 o timeout conserva pending_confirmation y no vuelve a enviar Sale.

Cada reserva nueva permite una única operación inicial. Los estados pueden leerse
localmente y el operador puede ejecutar otro caso en OTRO intent sin editar UUID.
Los hashes del set oficial de 26 tarjetas (básicas y casos 2.1–2.12) solo se aceptan
en este modo. La política Live y el set Sandbox ordinario no cambian. El primer
caso recomendado continúa siendo 2.9, con L 1 canónico.

La tabla Sandbox general publica vencimiento 2512 (ya pasado en esta fecha),
mientras el ejemplo SDK usa julio de 2028. No se traslada 2512 al checkout actual
como fecha vigente. Las tarjetas 3DS se consultan en la documentación, no en logs
ni informes. Los escenarios por montos 2–14 requerirían reservas con esos montos
canónicos: este PR no permite falsear el precio ni alterar datos para simularlos.

Los holds QA se conservan en sus 30 minutos existentes; no se modifica el parámetro
hold_duracion_min ni se reduce/renueva por sesión. La prueba PG real verifica que
proteger_reserva_pago_v1 conserva un hold de 30 minutos. La caducidad de la sesión
de pruebas no extiende hold/intent. El TTL corto del puente cerrado tampoco cambia.

## Verificación, interpretación y rollback

Backend: oficial-pixelpay-example, qa-pixelpay-3ds-diagnostic, private-commerce y
microfase2a2-public-pagos-routes. Dos intents distintos producen dos despachos
SINTÉTICOS, uno cada uno; las repeticiones de ambos producen cero despachos extra.
PostgreSQL 17 descartable: financial v2, single-sale claim y Songbird; incluye
concurrencia real y el hold de 30 minutos. No hay migración nueva en este PR.

El frontend incluye la reproducción completa nativa de control de flujo y el
checkout/reload. CI prueba las mismas rutas, lint y build QA. El endpoint inicial
conserva telemetría sanitizada de HTTP/etapa/resultado/correlación; no agrega PAN,
CVV, JWT, payload ni configuración secreta a registros.

Para cerrar una sesión: desactivar QA_PIXELPAY_SANDBOX_SESSION_ENABLED o dejar vencer
UNTIL; no borrar intents/claims/eventos. Tras 202, consultar estado local y mantener
el intent incierto. No reenviar ni cambiar de canal. El contrato financiero v2 es
la única vía de captura/confirmación; no se confirma una cita por ActionCode,
TransactionResult o retorno del navegador. CI/mocks no acreditan 3DS real.
