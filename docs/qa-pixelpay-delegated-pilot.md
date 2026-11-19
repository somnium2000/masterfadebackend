# Piloto QA de continuación PixelPay

El checkout autenticado acepta un HTTP 202 `songbird` con `collection_url` de CAS Sandbox y el payload original. El navegador llama a `CardinalManager.init(payload, collection_url)` del SDK 2.5.8. Una URL ausente, nula, vacía o inválida produce un código de continuación distinto y conserva la Sale pendiente. La Sale inicial sigue en Node y envía `authentication_request=false`. El objeto separado de React llama a `withAuthenticationRequest()` después del handoff. La bandera de la petición inicial y la validación remota de 3DS permanecen pendientes.

## Autorización y recuperación

- El backend devuelve el permiso del piloto únicamente en los datos del intento exacto y para la cuenta QA autorizada. La ruta autenticada `/v1/pagos/reservas/pixelpay/3ds/delegated` hereda sesión, autorización, CSRF y allowlist de QA. La capacidad efímera liga worker, grupo, usuario e intento. El backend revalida esos datos y el importe canónico antes de cada operación.
- El claim, el marcador de origen y el ID de intento se guardan antes de que el worker reciba la petición. Tras recarga, caducidad o reinicio, el backend conserva esa reclamación y utiliza el estado existente. Para cualquier otro tipo de 202, se deja pendiente la confirmación y se conserva el UUID observado si está disponible. El worker de aplicación y el servidor de escritorio son entradas separadas.
- El SDK nativo administra los formularios de colección y StepUp. React admite la señal de continuación del iframe asociado y solicita el retry mediante el transporte delegado. El worker Direct API usa el identificador de su propio lookup y la petición Node original. La ruta sigue ligada al intento, usuario y token. La señal del iframe solicita el retry y la respuesta del proveedor determina el resultado financiero. El proveedor debe aplicar la autenticación a la operación al procesar ese retry. Un worker por intento y su memo evitan un despacho duplicado.
- El UUID obtenido de un 202 permanece como candidato para Status. Si el worker se pierde, Status puede observar ese candidato durante la ventana QA. Sólo la evidencia durable de una Sale verificada permite conciliar. Después de que cierra la ventana, la misma cuenta puede recuperar evidencia ya persistida mientras se mantenga configurado el piloto.

## Evidencia financiera y plazos

El backend reutiliza la clasificación de Sale, los controles de UUID, transacción, hash e importes y la conciliación de reserva existente. Para precisar orden y moneda, compara únicamente valores recibidos del proveedor. Un resultado de Sale positivo con identidad incompleta puede corroborarse con Status obtenido por Node, siempre que coincidan orden, UUID, transacción, moneda e importes. Una contradicción conserva la incertidumbre.

En Status anidado, el estado procede de `response.data.status`. Los campos financieros y el resultado de la transacción proceden de `response.data.last_response.data`. Para orden, moneda y UUID se aceptan los campos explícitos en el resultado anidado o el envelope exterior cuando existen y coinciden entre sí y con el intento. Los valores esperados sirven para comparar. La muestra pública de [Status con SDK JavaScript](https://docs.pixelpay.com/use-case?case=sdk%2Fstatus%2Fstatus&lang=javascript&locale=es) no publica un envelope completo del comercio. Las ubicaciones observadas en Sandbox deben poder comprobarse mediante evidencia de forma saneada. Si un dato necesario falta o discrepa, se conserva el intento para conciliación. Status por sí solo no acredita una Sale.

El timeout HTTP por llamada del SDK permanece en 60 s. El servidor de QA utiliza el vencimiento absoluto más temprano entre la protección persistida de la reserva y el cierre del piloto. React usa el mismo vencimiento durante el desafío. Los 15 s, 120 s y 60 s del prototipo siguen limitando el ensamble de escritorio solamente. Los plazos de la aplicación provienen de la reclamación y de la ventana operativa, no del banco. Un proxy puede cortar el HTTP anterior a esos plazos. Si sucede, se recupera el intento pendiente. El estado uncertain no autoriza a repetir la Sale.

## Variables para el ensayo

Configurar los valores de cuenta y credenciales mediante la configuración existente del backend QA.

```dotenv
ENTORNO=qa
NODE_ENV=development
PAYMENT_PROVIDER=pixelpay
PIXELPAY_IMPLEMENTATION=sdk
PIXELPAY_ENV=sandbox
PIXELPAY_ENDPOINT=https://pixelpay.dev
PIXELPAY_APP_URL=https://pixelpay.dev
QA_PRIVATE_COMMERCE_BOOKING_ENABLED=true
QA_PRIVATE_COMMERCE_USER_ID=<uuid del cliente QA autorizado>
QA_PIXELPAY_DELEGATED_ENABLED=true
QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED=true
QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID=<uuid del intento nuevo de HNL 1.00>
QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL=<instantánea UTC hasta diez minutos desde arranque>
```

Las credenciales `PIXELPAY_KEY_ID`, `PIXELPAY_SECRET_KEY` y `PIXELPAY_AUTH_HASH` pertenecen al backend. Los flags de sesión Sandbox multiintento, Sale legada, piloto legado y simuladores deben estar desactivados según los validadores existentes. Frontend utiliza `VITE_ENTORNO=qa`, `VITE_PAYMENT_PROVIDER=pixelpay` y `VITE_PIXELPAY_ENV=sandbox`. La selección exacta del intento llega del backend. El commit del PR #143 aporta las tarjetas oficiales, incluido el caso 2.9.

## Ensayo único después de revisión y despliegue QA

1. Revisar CI y preparar los dos builds QA de `dev`. Desplegar `frontend-qa` y `backend-qa` antes de habilitar la ventana del intento. Confirmar ambos SHA, las variables Sandbox y que el frontend usa la API QA. Preparar un intento nuevo de HNL 1.00 para el cliente permitido.
2. Renovar `QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID` y `QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL` con el UUID nuevo y el vencimiento UTC. Activar **Preserve log** en Network y comenzar a observar los eventos `pixelpay_qa_delegated_phase` por SSH antes de enviar. Conservar sólo fases, estados, tiempos y los indicadores de forma.
3. Ejecutar una sola Sale del caso oficial 2.9. En el camino con desafío, esperar Sale 202, un POST a Collect, un lookup delegado, un POST a StepUp creado por el SDK y, tras el desafío, retry delegado y consulta de estado. Direct API no necesita el `Continue` XHR de Songbird ni una llamada delegada a `authenticationContinue`. Si llega un 200 sin desafío, registrar esa variante por separado. Ante un 202 bloqueado, vencimiento o resultado incierto, conservar el intento para reconciliación.
4. Comprobar que el backend registra una única evidencia verificada, que el pago queda capturado con `paid_at` durable y que sólo entonces se confirma la reserva. Si falta un campo necesario en Status, conservar únicamente qué campos estaban presentes y en qué nivel del envelope. Tras el ensayo cerrar la ventana. Mantener el acceso a recuperación DB del intento hasta resolver pendientes y desactivar el flag cuando concluya la revisión.

Las pruebas focalizadas están en `test/pixelpay-delegated.test.mjs`, `test/microfase2a2-public-pagos-routes.test.mjs`, `test/private-commerce.test.mjs` y `test/pixelpay-sdk-provider.test.mjs`. La prueba HTTP conjunta del frontend usa `PIXELPAY_PROTOTYPE_BACKEND` y el servidor de escritorio. El SDK es real y el desafío y transporte al proveedor son simulados. PostgreSQL se verifica en el workflow existente.

El evento `start` identifica el intento y la Sale propia del backend. Incluye el origen de Sale, su Cf-Ray si existe y el diagnóstico comparativo del cuerpo HTTP, del parser y del handoff. El Cf-Ray de StepUp se recoge por separado en Network.

Para observar la prueba por SSH desde antes del envío, reemplaza el UUID del ejemplo y ejecuta este filtro de solo lectura en el VPS de QA. Interrúmpelo con Ctrl+C al terminar.

```bash
INTENT_NUEVO='<uuid del intento QA autorizado>' python3 - <<'PY'
import json
import os
import subprocess

fields = ('time', 'reqId', 'id_intent', 'paymentAttemptId', 'operation', 'state',
          'upstream_status', 'continuation_mode', 'handoff_sent', 'booking_confirmed',
          'continuation_diagnostic')
with subprocess.Popen(
    ['docker', 'service', 'logs', '--raw', '--follow', '--since', '2m', 'masterfade-qa_backend-qa'],
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8', errors='replace',
) as logs:
    for line in logs.stdout:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if (isinstance(event, dict) and event.get('event') == 'pixelpay_qa_delegated_phase'
                and event.get('id_intent') == os.environ['INTENT_NUEVO']):
            print(json.dumps({key: event[key] for key in fields if key in event}), flush=True)
```
