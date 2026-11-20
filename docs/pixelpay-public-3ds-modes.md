# Continuación pública PixelPay 3DS

La sesión pública distingue dos contratos del SDK 2.5.8 después del HTTP 202 interceptado en Node. Ambos conservan un único intento y la confirmación financiera del backend.

| Respuesta 202 admitida | Modalidad | Navegador | Continuación Node |
| --- | --- | --- | --- |
| `transaction_type=songbird`, payload opaco y `data.collection_url` CAS válida | `direct_api` | `manager.init(payload, collection_url)`, Collect, lookup, StepUp si procede | retry nativo con identificador del lookup |
| `transaction_type=songbird`, payload opaco y propiedad `collection_url` ausente | `songbird` | `manager.init(payload)`, Cardinal.setup init, lookup, Cardinal.continue si procede | authenticationContinue aceptado, luego retry nativo |

Las propiedades presentes con null, cadena vacía, tipo incorrecto o URL rechazada no pasan a Songbird. Una colección mal colocada en el nivel superior también se rechaza. La normalización de URL admite host sin distinción de mayúsculas y puerto HTTPS predeterminado, conservando origen y ruta CAS permitidos y el valor original para el SDK. No admite credenciales, fragmentos, espacios ni barras invertidas.

Songbird acepta lookup nativo 200 o 202 con success y action=continue, identificador, URL HTTPS de desafío, payload y transaction_id válidos. La modalidad frictionless 200 no necesita authenticationContinue. El desafío Songbird sí exige respuesta nativa 200/success/action=null de authenticationContinue antes del retry. Ese resultado no constituye aprobación financiera.

Los endpoints de booking y membresías admiten `continue` con un payload opaco limitado a 32768 caracteres; no admiten que el cliente cambie orden, monto o identificador del proveedor. Se conservan sesión, titular, grupo, token efímero, CSRF, plazo, fases, worker aislado, marcador durable 202 y despacho único antes del retry. Los duplicados de continue con el mismo hash comparten promesa; un payload distinto se rechaza. La aprobación final sigue pasando por las comprobaciones financieras y conciliación backend existentes.

## Evidencia y límites

El historial anterior a backend PR146 (`0d0513d^`) admitía el contrato Songbird sin colección. PR146 exigió colección y el checkout público heredó esa restricción. El SDK instalado conserva las dos ramas de `CardinalManager.init`. Las regresiones cubren Songbird con lookup200/202, Direct API, frictionless, respuestas inválidas, caducidad y duplicados. El frontend conserva el arreglo de namespaces window de PR123.

El informe del 20 de noviembre reproduce `unsupported` sin handoff. Sus señales del intento Live apoyan ese punto de corte; no demuestran si la colección faltaba, era null/vacía/rechazada o si el tipo/payload era inválido. Estos PRs no recuperan ese submotivo retroactivamente ni acreditan un resultado bancario real. Los logs de inicio y el filtro SSH pertenecen al PR independiente de observabilidad.

## Validación sin proveedor

El workflow `Public PixelPay 3DS modes` ejecuta contratos nativos, rutas reales y un arbitraje concurrente en PostgreSQL 17 efímero. Las fixtures compartidas se extraen de la suite existente para que la prueba integrada use las mismas rutas y DB sintética.

`test/fixtures/publicPixelPayApi.mjs` escucha exclusivamente en loopback, compone autenticación/CSRF reales y las rutas de pagos con una DB sintética. El worker de fixture instala únicamente el transporte sintético y luego importa `applicationWorker.js` intacto, incluida la eliminación de copias transitorias de tarjeta y cliente. Bloquea sockets y fetch externos y expone solo contadores de prueba. El frontend compañero compila React y el SDK browser con Vite y comprueba los dos recorridos completos, un doble clic, ausencia de secretos en almacenamiento y rechazo financiero.

No se modifican banderas de apertura, archivos de entorno, despliegues ni migraciones.
