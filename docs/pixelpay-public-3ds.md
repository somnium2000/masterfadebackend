# PixelPay 3DS para reservas y membresías VIP

Este candidato admite la continuación nativa de PixelPay en QA Sandbox por
identidad y en Live con habilitación explícita. Las compras públicas en Live
con `PIXELPAY_PUBLIC_3DS_ENABLED=false` devuelven HTTP 503
`PIXELPAY_PUBLIC_3DS_UNAVAILABLE` antes del claim inicial y antes de llamar a
PixelPay. Con la bandera activa, se habilita únicamente el flujo público cuyo
permiso está activo, para un titular autenticado y con un navegador compatible.
Habilitar el permiso público abre ese flujo a todos los clientes elegibles.
Los accesos del piloto privado se configuran por separado.

## Contrato Direct API

1. El navegador anuncia `supports_public_3ds` tras comprobar que carga el SDK.
   Backend toma el claim durable y ejecuta la Sale con la orden, importe y moneda
   canónicos y el SDK 2.5.8. Una Sale con respuesta financiera final verificable
   usa la conciliación correspondiente. Un 202 compatible se registra antes de
   entregar `public_3ds_handoff`. El contexto cifrado y las credenciales quedan
   en el worker y el handoff permanece en memoria del navegador.
2. El SDK nativo recibe la colección, ejecuta el lookup delegado y copia
   `data.identifier` del lookup a `transaction.authentication_identifier`.
   Si el lookup solicita desafío, el SDK abre StepUp mediante un POST a
   `continue_url` con `continue_payload` en el campo `JWT`. El navegador
   comprueba que `pixelpay_continue` provenga del origen del endpoint de
   PixelPay y de la ventana del iframe de StepUp. El SDK rechaza errores e
   identificadores ausentes. El valor que lee del mensaje queda en el
   gestor del navegador. La continuación financiera usa el identificador
   del lookup original retenido en backend.
3. React delega `retry` con `data: {}`. El backend verifica sesión, titular,
   CSRF, intento, token, fase, vigencia, orden, importe y moneda. Exige un lookup
   aceptado por el worker, con o sin desafío. Antes de llamar al SDK, consume el
   único permiso de continuación en PostgreSQL mediante la restricción única
   existente de `payment_events`. La fila `pixelpay.sale.3ds_continuation_dispatched`
   registra el consumo del permiso con `firma_valida=false`.
4. El método nativo `retryTransaction()` envía un POST de continuación a
   `api/v2/transaction/sale` con el mismo `order_id`, modelo y contexto de
   cifrado. En el recorrido Direct API se omite `authenticationContinue()`.
   La señal del navegador impulsa el protocolo. La respuesta financiera del
   proveedor determina si procede confirmar una reserva o activar VIP.
5. Para conciliar una aprobación, el worker exige respuesta final exitosa
   HTTP 200 del SDK, estado completo y aprobado, importes esperados,
   identificadores válidos y `payment_hash` verificado contra la
   orden canónica. El ejemplo oficial de aprobación omite orden y moneda.
   Se usan los valores canónicos de backend y se rechazan contradicciones
   explícitas cuando el proveedor envía esos campos. El hash vincula la orden
   al comercio y se verifica en conjunto con el resto de la evidencia.
   La confirmación o activación aplica los conciliadores y restricciones locales
   ya existentes.

Los endpoints de continuación son `POST /v1/pagos/reservas/pixelpay/3ds/continuar`
y `POST /v1/cliente/planes/pixelpay/3ds/continuar`. El frontend consume
`pixelpayPublic3ds` y `pixelpayPublic3dsRequired` de la elegibilidad existente.
Una revalidación fallida revoca el permiso. El flujo usa las tablas de intentos
y eventos existentes.

## Soporte y fuentes

- En el ticket #9834, soporte indicó el 16–17 de noviembre que el SDK administra
  la validación interna de Cardinal y el desafío. Confirmó que la continuación
  se ejecuta en backend y conserva el mismo `order_id`. El contrato indicado
  usa la validación nativa del SDK, sin un verificador JWT adicional del comercio.
- El 19 de noviembre, soporte explicó que `pixelpay.dev` no agregó la URL ACS de
  colección en el caso reportado y recomendó Live para completar el ciclo.
  Confirmó que el UUID de un 202 pendiente de 3DS aún no es consultable por
  Status, que `2.5.8-beta.0` es una versión oficial y que `app_url` debe coincidir
  con la URL configurada en la API del comercio Live. Los repositorios fijan el
  paquete npm `@pixelpay/sdk-core@2.5.8`.
- Código instalado del SDK, en particular `CardinalManager.js`,
  `CardinalAuthentication.js`, `PaymentTransaction.js` y `ServiceBehaviour.js`.
  [Peticiones del SDK](https://docs.pixelpay.com/page/sdk/requests?locale=en)
- Campos del resultado financiero y muestra de aprobación.
  [Venta directa oficial](https://docs.pixelpay.com/use-case?case=sandbox-api%2Fpayments%2Fsale-card&lang=api&locale=es)

El claim durable acredita la exclusión de reenvíos de MasterFade. La prueba
del candidato queda pendiente de una operación Live realizada por el titular.

## Configuración de la primera prueba Live

| Servicio | Configuración | Valor |
| --- | --- | --- |
| Backend | `NODE_ENV` / `ENTORNO` | `production` / `production` |
| Backend | `PAYMENT_PROVIDER` / `PIXELPAY_IMPLEMENTATION` / `PIXELPAY_ENV` | `pixelpay` / `sdk` / `live` |
| Backend | `PIXELPAY_ENDPOINT` | Origen HTTPS de la API asignado al comercio Live. |
| Backend | `PIXELPAY_APP_URL` | Origen HTTPS registrado exactamente en la configuración API del comercio. |
| Backend | `PIXELPAY_KEY_ID` / `PIXELPAY_AUTH_HASH` / `PIXELPAY_SECRET_KEY` | Credenciales Live del comercio, exclusivamente en backend. |
| Backend | `PIXELPAY_PUBLIC_3DS_ENABLED` | `false` al desplegar. `true` solo para la ventana autorizada. |
| Backend | `PUBLIC_BOOKING_ENABLED` / `PUBLIC_VIP_PURCHASE_ENABLED` | Ambos `false` al desplegar. Habilitar únicamente el flujo de la prueba. |
| Backend | `PRIVATE_COMMERCE_PILOT_ENABLED` / `PIXELPAY_LIVE_3DS_TEST_ENABLED` | `false` / `false` para esta prueba pública. |
| Backend | QA y simuladores | Mantener apagados `QA_PRIVATE_COMMERCE_BOOKING_ENABLED`, `QA_PRIVATE_COMMERCE_SANDBOX_SALE_ENABLED`, los modos QA 3DS delegados y los simuladores. |
| Frontend | `VITE_APP_URL` / `VITE_API_URL` | Orígenes HTTPS públicos de MasterFade y su backend Live. |
| Frontend | `VITE_PAYMENT_PROVIDER` / `VITE_PIXELPAY_ENV` | `pixelpay` / `live` |
| Frontend | Reservas públicas | `VITE_PUBLIC_BOOKING_ENABLED=true` para mostrar el flujo durante su prueba autorizada. |
| Frontend | VIP | `VITE_VIP_MEMBERSHIPS_ENABLED=true` y `VITE_VIP_MEMBERSHIPS_PURCHASE_ENABLED=true` durante la prueba VIP. |

El flujo se activa desde el backend. Vite compila los permisos de navegación
preexistentes. Para QA conservar `NODE_ENV=development`, `ENTORNO=qa`,
`PIXELPAY_ENV=sandbox`, endpoint y app URL de `https://pixelpay.dev`, y los
permisos Sandbox por identidad y sus credenciales QA separados de Live.

## Despliegue y validación autorizados

1. Revisar los SHA y el CI de [backend #152](https://github.com/somnium2000/masterfadebackend/pull/152)
   y [frontend #131](https://github.com/somnium2000/masterfadefrontend/pull/131).
   Cuando se autorice el despliegue, publicar primero backend con los permisos
   públicos y 3DS apagados, después el frontend compatible. Verificar los SHA
   servidos y la elegibilidad sin iniciar un pago.
2. Configurar **una réplica** y mantenerla estable durante cada intento. Para la
   ventana autorizada abrir solo reservas o solo VIP con los permisos de la tabla.
   Antes de operar comprobar que la sesión del titular ofrece `pixelpayPublic3ds`
   y requiere `pixelpayPublic3dsRequired` en la elegibilidad. Una vez abierto,
   un cliente elegible puede usar ese checkout. La prueba usa una reserva u orden
   nueva y el importe fijado por su servicio o plan activo. El titular realiza
   un único envío y completa el desafío si el emisor lo solicita.
3. En Network observar la Sale inicial y, para la rama 202, la colección,
   el lookup y el documento de StepUp dentro del iframe. La API del navegador
   muestra una operación `lookup` y una `retry`; el POST de continuación a
   PixelPay sale del backend. El caso frictionless puede omitir el iframe.
   Evitar abrir o exportar cuerpos, JWT, cookies, tarjetas, credenciales o URLs
   completas del proveedor.
4. En SSH consultar los logs del servicio backend por `id_intent`; correlacionar
   `paymentAttemptId` en `pixelpay_public_3ds_phase`. Observar
   `start_result` con `continuation_diagnostic`, seguido de `handoff_ready` →
   `challenge_ready` o `frictionless_ready` →
   `continuation_dispatched` → `continuation_result` con estado HTTP seguro.
   Un `start_failed` conserva la etapa fija donde no pudo iniciarse el flujo.
   `unsupported` identifica una admisión rechazada; su submotivo se conoce
   únicamente si está presente el código de diagnóstico. El tamaño de una
   respuesta anterior no permite recuperar ese código retroactivamente.
   Si cae la conexión puede quedar únicamente `continuation_dispatched`: el
   estado financiero sigue pendiente. Los estados del navegador y el marcador
   de despacho son indicadores de progreso. La evidencia final es el estado
   local verificado con un único pago y una confirmación de reserva o una
   activación VIP, según corresponda. Recargar solo para consultar el estado.
5. Tras cerrar la ventana, deshabilitar la admisión pública probada y la bandera
   3DS si ya no se requiere. Conservar claims y eventos. Evaluar el resultado
   antes de reiniciar o cambiar réplicas. Para probar el otro flujo, abrir una
   ventana separada y usar una orden distinta autorizada.

### Filtro SSH de la ventana Live

Ejecutar en el VPS con el nombre del servicio Live ya verificado y el UUID
interno del intento. El filtro imprime únicamente fases y metadatos permitidos,
incluidos los diagnósticos de inicio. Omite valores opacos, URLs y errores libres.

```bash
python3 - 'SERVICIO_BACKEND_LIVE' 'UUID_INTERNO_DEL_INTENTO' <<'PY'
import json
import subprocess
import sys
from uuid import UUID

service = sys.argv[1]
intent = str(UUID(sys.argv[2]))
phases = {
    'start_result', 'start_failed',
    'handoff_ready', 'challenge_ready', 'frictionless_ready',
    'lookup_incomplete', 'continuation_dispatched', 'continuation_result',
    'lookup_failed', 'authentication_continue_ready', 'authentication_continue_incomplete',
    'authentication_continue_failed', 'continuation_failed',
}
diagnostic_codes = {
    'PIXELPAY_3DS_COLLECTION_URL_ABSENT', 'PIXELPAY_3DS_COLLECTION_URL_NULL',
    'PIXELPAY_3DS_COLLECTION_URL_EMPTY', 'PIXELPAY_3DS_COLLECTION_URL_INVALID',
    'PIXELPAY_3DS_CONTINUATION_INVALID', 'PIXELPAY_3DS_COLLECTION_READY',
    'PIXELPAY_3DS_SONGBIRD_READY',
}
field_types = {'absent', 'null', 'empty_string', 'array', 'string', 'object',
               'number', 'boolean', 'undefined'}
fields = ('collection_url', 'payload', 'transaction_type')

def allowed(value, choices):
    return value if type(value) is str and value in choices else None

def status(value):
    return value if type(value) is int and 100 <= value <= 599 else None

def shape(value):
    value = value if type(value) is dict else {}
    present, length = value.get('present'), value.get('length')
    return dict(present=present if type(present) is bool else None,
                type=allowed(value.get('type'), field_types),
                length=length if type(length) is int and 0 <= length <= 9007199254740991 else None)

def diagnostic(value):
    value = value if type(value) is dict else {}
    result = dict(code=allowed(value.get('code'), diagnostic_codes),
                  upstream_http_status=status(value.get('upstream_http_status')),
                  sale_environment=allowed(value.get('sale_environment'), {'sandbox', 'staging', 'live'}),
                  raw_top_level_collection_url=shape(value.get('raw_top_level_collection_url')))
    for boundary in ('raw_data', 'sdk_data'):
        data = value.get(boundary)
        data = data if type(data) is dict else {}
        result[boundary] = {field: shape(data.get(field)) for field in fields}
        result[boundary]['transaction_type_kind'] = allowed(data.get('transaction_type_kind'),
                                                           {'payload', 'songbird', 'router'})
    for boundary in ('raw_to_sdk_equal', 'sdk_to_handoff_equal'):
        data = value.get(boundary)
        result[boundary] = {field: data.get(field) if type(data.get(field)) is bool else None
                            for field in fields} if type(data) is dict else None
    return result

cmd = ['docker', 'service', 'logs', '--raw', '--timestamps', '--since', '15m', service]
with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as logs:
    for line in logs.stdout:
        timestamp, _, content = line.partition(' ')
        try:
            event = json.loads(content)
            if event.get('event') != 'pixelpay_public_3ds_phase' or event.get('id_intent') != intent:
                continue
            phase = event.get('phase')
            if phase not in phases:
                continue
            attempt = str(UUID(event.get('paymentAttemptId', '')))
        except (AttributeError, TypeError, ValueError):
            continue
        result = dict(utc=timestamp, id_intent=intent, paymentAttemptId=attempt,
                      phase=phase, http=status(event.get('upstream_status')))
        if phase == 'start_result':
            result['state'] = allowed(event.get('state'),
                                      {'challenge', 'unsupported', 'completed_without_3ds', 'unknown'})
            if 'continuation_diagnostic' in event:
                result['continuation_diagnostic'] = diagnostic(event['continuation_diagnostic'])
        if phase == 'start_failed':
            result['stage'] = allowed(event.get('stage'),
                                      {'worker_construction', 'worker_start', 'durable_record', 'context_check'})
            result['code'] = allowed(event.get('code'), {'PIXELPAY_PUBLIC_3DS_START_UNCERTAIN'})
        print(json.dumps(result))
    print(json.dumps(dict(docker_exit_code=logs.wait())))
PY
```

## Vencimiento, incertidumbre y réplicas

El contexto vence al menor plazo entre la protección del intento y 120 segundos.
Ante cierre, vencimiento, timeout, otro 202, pérdida del worker, reinicio o
enrutamiento a otra réplica, preservar el intento y el claim. No reconstruir el
contexto, reenviar la Sale ni usar Status con el UUID no verificado de un 202
pendiente. Consultar la evidencia local y reconciliar por los mecanismos
existentes cuando haya una referencia confiable. Si la continuación ya se
consumió, su marcador durable sigue excluyendo otro despacho.

La operación general con varias réplicas requiere probar afinidad con la
réplica dueña durante colección, lookup y desafío, incluyendo recambios y caídas.
La reanudación tras perder el worker requeriría un contrato respaldado por
PixelPay que no dependa de conservar PAN o CVV.

## Evidencia automatizada

- Backend: SDK instalado con HTTP sintético para Sale, lookup y continuación
  nativa, incluidos resultado aprobado con el esquema oficial, rechazo,
  contradicciones, 202 inesperado e incertidumbre. Rutas de reservas y VIP con
  sesión/CSRF, titularidad, elegibilidad y persistencia, y carrera del permiso
  de despacho en PostgreSQL 17 efímero.
- El workflow frontend de PR a `main` ejecuta
  `node scripts/pixelpay-delegated-browser-bundle.mjs` con Vite y JSDOM. Comprueba
  SDK compilado, iframe, origen y ventana, mensajes inválidos o duplicados,
  cancelación y expiración con transporte sintético.
- La prueba opcional React → Fastify loopback de `delegatedPixelPay.test.jsx`
  requiere `PIXELPAY_PROTOTYPE_BACKEND`. Usa workers y SDK reales con transporte
  sintético y cubre el prototipo Songbird. El CI no define esa variable ni
  ejecuta ese caso. La cobertura Direct API pública proviene de las pruebas
  anteriores.
