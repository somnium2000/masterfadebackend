# QA: interrupción durante lookup y origen ACS

## Causa reproducible

`usePrivateCommerce` refresca elegibilidad al recibir `window.focus`. Antes,
`checking=true` retiraba provisionalmente `pixelpaySongbirdBridge`; el panel
recibía `enabled=false` y su cleanup abortaba la sesión y enviaba `interrupt`.
Ahora se conserva la última capacidad confirmada para la misma identidad mientras
se revalida, pero el CTA no permite nuevos claims durante esa espera. Una
revocación, error, logout o cambio de identidad sigue cerrando la sesión.

El incidente mostró una consulta de elegibilidad seguida de `interrupt` antes
de terminar lookup. La causa anterior es reproducible en código y compatible
con esa secuencia; el incidente no registró el motivo, por lo que no se puede
atribuir retrospectivamente con certeza absoluta. No hay timeout fijo de 15 s
en el panel, la sesión o su cliente HTTP.

## Diagnósticos

`pixelpay_songbird_phase` añade `interrupt_reason` para interrupt, correlacionado
por `id_intent`: PANEL_CLEANUP, CONTEXT_CHANGED, SIGNAL_ABORT, HANDOFF_EXPIRED,
UI_CLOSED, SDK_HANDLER_ERROR, SDK_RUN_ERROR, SESSION_INIT_ERROR,
CHALLENGE_INVALID o USER_CANCEL. Clientes anteriores producen UNSPECIFIED.
Son motivos declarados por el navegador, no evidencia financiera ni permisos.
No se registra el objeto de error. Cleanup, cierre y cancelación siguen cerrando
la lease; las respuestas tardías no la reabren.

`PIXELPAY_SONGBIRD_LOOKUP_DIAGNOSTIC` añade `acs_origin`, exclusivamente
`URL.origin` para HTTPS, o null. No contiene usuario, contraseña, ruta, query,
fragmento, JWT ni payload. No cambia la aceptación del desafío ni la allowlist.

## Comparación con SDK 2.5.8 y pendiente ACS

`CardinalManager.init` selecciona songbirdstag para cargar el script Sandbox.
`validationLookupResponse` pasa `response.data.continue_url` como `AcsUrl` a
`Cardinal.continue('cca', ...)`; no restringe el ACS a los hosts del script.
El SDK por sí solo no acredita el host desconocido de este incidente. La
telemetría previa solo conservó `acs_origin_allowed=false`: no permite recuperar
el origen. Se necesita identificarlo y contrastarlo con documentación/soporte
oficial PixelPay antes de proponer una política para ACS de emisor o simulador.
No se añaden hosts, comodines ni una aceptación general de HTTPS.

## Despliegue y observación

Fusionar los PR backend/frontend hacia dev tras CI. Desplegar primero backend
QA y luego reconstruir frontend QA con su configuración existente; registrar
ambos SHA. Sin migraciones ni cambios de flags financieros o producción.

Antes de la única prueba real que realizará el operador, preparar un filtro SSH
que conserve `acs_origin` en el diagnóstico de lookup e `interrupt_reason` en
los eventos de fase, junto con intent, paymentAttemptId, hora, estado y los
booleanos existentes. No imprimir logs sin filtrar ni payloads.

Esperado al volver a enfocar el navegador con lookup pendiente: se revalida
elegibilidad sin interrupt si sigue autorizada. Si el ACS sigue fuera de la
lista, setup debe quedar contract_blocked, y acs_origin permitirá investigar
ese destino. Este parche no promete challenge_ready para un ACS aún no admitido.
No repetir Sale para el mismo intento ni confirmar una cita por Cardinal.
