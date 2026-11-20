# Revisión conjunta previa a integración en main

La rama integrada parte de main `02b96373c5f4deb47910f559dd09c275a8098dc0` e incorpora por cherry-pick los cambios de [PR153](https://github.com/somnium2000/masterfadebackend/pull/153) y [PR154](https://github.com/somnium2000/masterfadebackend/pull/154). No fusiona main ni modifica servicios desplegados.

El único conflicto backend estaba en los helpers de log de `publicPixelPay3ds.js`: se conservan `traceStart` sanitizado y `trace` protegido contra fallos del logger, junto con fases, controles y continuación de ambas modalidades. El frontend compañero incorpora PR132 y PR133, cuyo archivo público se combinó sin conflicto.

## Condiciones auditadas

| Condición | Resultado exigido |
| --- | --- |
| Propiedad data.collection_url realmente ausente y songbird/payload válidos | Modalidad Songbird explícita |
| Propiedad presente con null, cadena vacía, tipo incorrecto o URL rechazada | unsupported; sin fallback a Songbird |
| Colección mal colocada en nivel superior | unsupported |
| Colección CAS válida | Modalidad Direct API; se conserva la URL original |
| Destino Songbird del lookup | HTTPS absoluto con autoridad, sin controles, espacios, credenciales, fragmento ni barra invertida |
| Origen del SDK Live | Origen HTTPS explícito válido; sin ruta, consulta, credenciales ni fragmento |
| authenticationContinue | Solo SuccessResponse nativo, HTTP200, success booleano true y action normalizada null admite el retry |

La revisión detectó que `new URL` sin base aceptaba `https:host` y `https:/host` y descartaba ciertos controles iniciales. Eso podía divergir de la interpretación de los bytes originales por Cardinal. Los validadores ahora exigen `https://` con autoridad y rechazan controles Unicode antes de parsear. La normalización válida de host y puerto443 y la comprobación de rutas/origen CAS se conservan.

Songbird recibe AcsUrl exclusivamente del lookup ejecutado en el worker/backend con el proveedor configurado; el cliente no elige ese destino. Se admite el destino HTTPS del emisor sin inventar una lista fija de bancos. El SDK nativo selecciona el script HTTPS de Cardinal según sandbox/live; la prueba browser verifica ambas fuentes. Los callbacks públicos conservan controles de fase, identificador y duplicados; solo la respuesta financiera verificada del backend puede confirmar la reserva.

La [auditoría de authenticationContinue](pixelpay-authentication-continue-audit.md) distingue la normalización real del SDK de la política conservadora de MasterFade y de una autenticación bancaria positiva, que no se acredita con fixtures.

## Validación de la combinación

Los workflows de diagnóstico y modalidades se ejecutan sobre la misma rama. El workflow de modalidades incluye las matrices nuevas de URLs y respuestas Continue. El workflow general `Release main validation` se habilita explícitamente para la rama integrada y conserva sus suites completas, PostgreSQL17 efímero, comparación histórica, paquetes reproducibles y comprobaciones de identidad. Sus scripts no se ejecutan contra producción.

La integración frontend fija el backend integrado por SHA y repite seis casos del bundle React/Vite contra API real en loopback, applicationWorker intacto y SDK nativo, con DB/ACS/finanzas sintéticas y sockets externos bloqueados. Además de sus resultados funcionales, exige `start_result`, código seguro y tipo de colección correctos del diagnóstico backend, y el diagnóstico browser ante Continue rechazado. Las fixtures quedan inactivas al ser descubiertas por `node --test` sin escenario/worker explícito.

No se cambian archivos de entorno, banderas de apertura, migraciones o despliegues. El submotivo del unsupported Live histórico y el contrato particular de una respuesta bancaria real siguen sin acreditarse.
