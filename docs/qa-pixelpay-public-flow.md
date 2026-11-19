# PixelPay 3DS: contrato público y retiro del puente QA

## Corrección de tarjetas QA y revisión del 18 de noviembre de 2026

La política Sandbox ordinaria reutiliza ahora `OFFICIAL_QA_CARD_HASHES`. Se contrastó
el catálogo con [Instalación Sandbox](https://docs.pixelpay.com/page/sandbox/installation?locale=es)
mediante el MCP de documentación. Coinciden las 26 huellas, dos casos básicos y
Visa/Mastercard de cada escenario 2.1–2.12, incluido 2.9. Se admiten únicamente esas
tarjetas de prueba. El catálogo controla qué datos pueden usarse en los ensayos.
PixelPay decide la autenticación, autorización y resultado de cada operación.
La política Live conserva su conjunto original independiente.

El evento `PIXELPAY_SALE_PREFLIGHT_REJECTED` del intent
`6d66fc84-8ea3-481d-b6e3-45167829497b` acredita, según la evidencia aportada para esta
corrección, un rechazo local anterior al envío. Ese intento se excluye de la futura
prueba. La nueva prueba todavía requiere completar el contrato SDK descrito abajo.

`pixelPaySaleRuntime.js` intercepta el HTTP 202 después de `super.parseResponse()`
y lanza `PixelPayContinuationRequiredError`. Se revisó si se podía retirar esa
intervención. En SDK 2.5.8, `Transaction.doSale()` conserva el mismo contexto y
ejecuta los gestores de navegador ante `PayloadResponse`. Además, rechaza
`authentication_request` en Node antes del envío. Quitar el interceptor en este
backend conduce a ese código de navegador y no establece el recorrido React/Node.
La excepción y el tratamiento incierto se conservan mientras se obtiene el método
público que los sustituya.

**Único bloqueo técnico pendiente:** acreditar el ejemplo soportado que indique
dónde ejecutar `Transaction.doSale(sale)` con `withAuthenticationRequest()`, qué
configuración segura recibe React y, si el flujo está dividido, el método público
y parámetros que conectan las dos partes y devuelven el resultado de la misma
orden. Secret Key y el `auth_hash` reutilizable deben permanecer en backend.
Se revisaron de nuevo [instalación JavaScript](https://docs.pixelpay.com/page/sdk/installation/javascript?locale=es),
[peticiones](https://docs.pixelpay.com/page/sdk/requests?locale=es) y
[modelos](https://docs.pixelpay.com/page/sdk/models?locale=es).
El ticket #9834 encarga la orquestación al SDK. Los materiales revisados todavía
no precisan ese contrato entre contextos. No se implementa una continuación
manual de Cardinal, JWT, CAS, `authenticationLookup()` o `authenticationContinue()`.

### Prueba preparada para cuando el contrato esté implementado

1. Verificar SHA servido, configuración de cuenta QA, endpoint Sandbox y recorrido
   público SDK implementado y aprobado por CI.
2. Obtener autorización operativa para una única Sale Sandbox sobre una cuenta QA
   y un grupo, intento y orden nuevos, de su titular, con importe canónico HNL 1.00.
   Comprobar ausencia de intentos previos y vigencia de la reserva.
3. Usar el escenario 2.9 desde el checkout con los datos de prueba oficiales. El
   SDK debe presentar y completar el desafío dentro del recorrido público.
4. Verificar en backend orden, importe, aprobación, hash y unicidad de evento/pago
   antes de confirmar la reserva. Un 200 aislado no acredita desafío ni pago.
5. Ante resultado incierto, conservar claim y recuperación. Detener nuevos envíos
   y observar únicamente los identificadores y campos diagnósticos permitidos.

Esta corrección se valida localmente y en CI con fixtures. La ejecución de esta
prueba remota queda pendiente de completar el contrato y de su autorización.

## Decisión

Se aplica el caso C de la revisión solicitada: falta un contrato público que permita completar 3DS con la cuenta configurada manteniendo sus credenciales privadas en backend. Este cambio retira la iniciación del puente experimental; no implementa todavía una ruta de pago 3DS completa ni acredita una solución del desafío remoto.

Bases revisadas: backend `1ec6ae9`, frontend `4cc362a`, ambos desde `origin/dev`. Ambos `package.json` y `package-lock.json` fijan `@pixelpay/sdk-core@2.5.8`; el paquete instalado examinado también es 2.5.8. No se actualiza ni modifica el SDK.

El ticket #9834 del 17 de noviembre de 2026, 19:35 Honduras, indica que el SDK debe conservar la orquestación y validación 3DS. Ese mensaje define la integración solicitada, pero no acredita la causa raíz del documento vacío anterior.

## Recorrido público comprobado y punto pendiente

| Paso | Responsable | Método público | Datos de entrada/salida | Fuente |
| --- | --- | --- | --- | --- |
| Preparar petición | Cliente | `SaleTransaction.setOrder/setCard/setBilling`, `withAuthenticationRequest()` | Modelos de orden, tarjeta y facturación; bandera `authentication_request=true` | [Peticiones](https://docs.pixelpay.com/page/sdk/requests?locale=es), [venta JavaScript](https://docs.pixelpay.com/use-case?case=sdk%2Fpayments%2Fwithout-tokenization&lang=javascript&locale=es) |
| Autorizar y firmar | Backend | HMAC SHA3-512; `Settings.setupHeaders()` | Orden autoritativa; `app_key|order_id|app_url` → `x-client-signature` | [Firma](https://docs.pixelpay.com/page/secure-signature?locale=es) |
| Iniciar operación 3DS | Navegador según código 2.5.8 | `Transaction.doSale(sale)` | Petición → resultado final; el SDK conserva el contexto durante el mismo `await` | [Transaction.js 2.5.8](https://unpkg.com/@pixelpay/sdk-core@2.5.8/lib/services/Transaction.js), [instalación JS](https://docs.pixelpay.com/page/sdk/installation/javascript?locale=es) |
| Configurar servicio cliente | Pendiente para cuenta actual | `Settings.setupCredentials(key, hash)` | El SDK exige `auth_key` y `auth_hash`; no se acreditó una credencial limitada a la operación que los sustituya | [Modelos](https://docs.pixelpay.com/page/sdk/models?locale=es), [ServiceBehaviour.js 2.5.8](https://unpkg.com/@pixelpay/sdk-core@2.5.8/lib/base/ServiceBehaviour.js) |
| Verificar resultado financiero | Backend | `TransactionResult`, `verifyPaymentHash()`; consulta documentada si hay identificador suficiente | Resultado financiero e identidad de la orden → decisión idempotente de persistencia | [Servicios](https://docs.pixelpay.com/page/sdk/services?locale=es), [entidades](https://docs.pixelpay.com/page/sdk/responses-entities?locale=es) |

Discrepancia exacta: la documentación de peticiones asigna `doSale/doAuth` al backend y `withAuthenticationRequest()` al cliente. En 2.5.8, `PaymentTransaction.withAuthenticationRequest()` sólo establece una bandera; `Transaction.doSale()` rechaza esa bandera fuera del navegador antes de enviar la venta. En navegador, el mismo método procesa la respuesta intermedia y espera al SDK hasta terminar. No hay un canal React/Node creado por la bandera.

El servicio exige `auth_key/auth_hash` antes de construir la solicitud y los envía como cabeceras de autenticación. Una firma específica, una llave pública de cifrado y `payment_hash` tienen funciones distintas; ninguno está documentado como sustituto de esas credenciales. No se considera publicable el hash reutilizable de la cuenta por estar transformado.

Se consultaron por MCP los casos JavaScript, peticiones, servicios, modelos, extracción de llaves, instalación y guía inicial, incluyendo referencias equivalentes en inglés y actualización v2. La lectura web directa no recuperó algunas páginas; el MCP proporcionó el contenido. Se revisaron también el hilo de soporte y fotogramas de los dos videos: muestran el ejemplo y el diagrama general, sin un método público adicional que conecte Node y React. Esta revisión acotada no demuestra que PixelPay carezca de otra integración; identifica el ejemplo concreto que falta acreditar.

`Settings.setupSandbox()` sí utiliza credenciales públicas de ejemplo. Sería otra cuenta de pruebas: el adaptador actual las reemplaza por la cuenta configurada y verifica con su secreto. No se cambia la cuenta ni se presenta un laboratorio público como validación del checkout de MasterFade.

## Cambio de comportamiento

- El backend deja de crear el contrato de gestores internos; no anuncia capacidad 3DS/puente y deniega una nueva venta QA 3DS antes de reclamar el intento o enviar tráfico financiero.
- La ruta histórica de Songbird conserva la consulta del estado y la interrupción local por el titular, sin iniciar ni continuar autenticación. Una interrupción local no prueba cancelación financiera.
- El frontend deja de montar el panel que instala `Proxy` sobre Cardinal, sustituye servicios y fabrica respuestas. Una capacidad antigua o cacheada no debe iniciar el diagnóstico retirado.
- El rechazo específico `503 / PIXELPAY_3DS_INTEGRATION_UNAVAILABLE` acredita que el cierre ocurrió antes del despacho. El frontend restaura el intento no enviado; los demás errores 5xx siguen representando incertidumbre. El indicador de diagnóstico por sí solo no prueba envío ni pago pendiente.
- Los intentos ya pendientes conservan su estado y la consulta existente. No se confirma, rechaza ni repite un cobro debido a esta desactivación.
- Se conservan autorización, titularidad, prevención de doble envío, orden/importe/moneda, idempotencia y verificación financiera de ventas normales. No se cambian producción, esquema, CSP ni algoritmos de firma/verificación.

Los archivos históricos del puente quedan para revisión, pero no existe una ruta habilitable de inicio desde el checkout modificado. No se elimina la protección Node ante una respuesta intermedia: aún no hay una ruta oficial nueva acreditada a la cual transferir esa operación.

## Despliegue QA y recuperación

Este PR debe revisarse junto al cambio frontend de la rama `codex/pixelpay-public-flow-20261118`. No agrega variables, migraciones ni ventanas de autorización. Los flags antiguos pueden permanecer configurados para desplegar el cierre; no reactivan el puente en este código. No habilitar credenciales en `VITE_*`.

1. Registrar los SHA e imágenes QA actuales y los SHA aprobados de ambos PR.
2. Desplegar backend primero: debe retirar las capacidades y rechazar nuevas operaciones QA 3DS incluso desde un frontend anterior. Los estados pendientes siguen consultables.
3. Desplegar frontend: ya no monta el panel ni inicia el diagnóstico con una capacidad antigua. No habilita otra ruta de cobro.
4. Verificar SHA/imagen desde EasyPanel, elegibilidad de la cuenta autorizada y ausencia del panel. Una lectura SSH del wrapper `masterfade-qa-audit status` sólo prueba tareas en ejecución; no prueba SHA servido ni variables.
5. Comprobar la denegación previa al despacho con pruebas locales/CI y consultar un intento QA pendiente ya conocido por su titular, sin repetir la venta ni crear otra intención para eludirlo.

Recuperación: conservar backend con este cierre de 3DS. Si falla frontend, restaurar su imagen anterior manteniendo backend cerrado. Si falla backend, detener el acceso a nuevas pruebas QA 3DS antes de restaurar la imagen y dejar desactivados los flags diagnósticos/puente/Sale correspondientes; verificar capacidades cerradas. Restaurar el puente experimental no es una recuperación autorizada del flujo nuevo. No modificar producción ni reejecutar intentos inciertos.

El acceso SSH autorizado es de lectura mediante wrapper; no proporciona despliegue EasyPanel. Esta entrega prepara PR, sin fusionar ni desplegar. La prueba remota 3DS exige primero resolver el contrato, implementar el recorrido completo, CI aprobado, despliegue comprobado y autorización operativa vigente con cuenta, escenario, monto e intento nuevos. No reutilizar ventanas vencidas.

## Única aclaración necesaria

Para React y Node con `@pixelpay/sdk-core@2.5.8`, necesitamos el ejemplo mínimo soportado que indique dónde ejecutar `Transaction.doSale(sale)` con `sale.withAuthenticationRequest()` y qué configuración exacta recibe el navegador manteniendo la Secret Key y el hash reutilizable de autenticación del comercio en backend. La documentación asigna `doSale` al backend, pero esa versión rechaza 3DS en Node. Si el recorrido es dividido, indicar el método público y los parámetros que conectan ambas partes; si debe ejecutarse en navegador, indicar la credencial o configuración admitida para esa llamada.

Esta consulta queda preparada, sin envío a soporte. No requiere investigar JWT interno, `OrderNumber` ni CAS.

## Evidencia y límites

Las pruebas focalizadas protegen que no haya despacho nuevo, que una capacidad antigua no abra el puente y que los resultados inciertos sigan pendientes/consultables. Lint, build y CI se reportan con su resultado real en los PR y la entrega. Los mocks no acreditan desafío remoto, verificación financiera ni confirmación de reserva en QA.

No se ejecutó ninguna operación financiera, no hay una correlación de prueba nueva ni un pago/reserva nuevos que reportar. El estado es: retiro seguro del recorrido experimental preparado; integración 3DS completa pendiente del contrato público indicado.
