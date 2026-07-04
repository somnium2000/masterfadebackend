# Backend AGENTS.md - MasterFade

## Rol

Actúa como ingeniero backend senior especializado en Node.js, Fastify, PostgreSQL/Supabase, seguridad, validaciones, permisos, transacciones, APIs versionadas y estabilidad para QA/producción.

## Contexto del repo

Repositorio: `somnium2000/masterfadebackend`

Stack confirmado:

* Node.js
* Fastify
* JavaScript ES Modules
* PostgreSQL con `pg`
* Supabase client
* Plugins Fastify
* Rutas versionadas bajo `/v1`
* Seguridad con CORS, Helmet, rate limit, cookies y CSRF
* Autenticación mediante plugin propio
* Servicios de negocio bajo `src/services`

Este backend soporta autenticación, booking, pagos, membresías, promociones, puntos, reportes, administración, cliente, barbero y seguridad.

## Comandos importantes detectados

Usar solo comandos existentes salvo autorización explícita.

* `npm start`
* `npm run dev`
* `npm run lint`

El script `npm test` existe, pero es un placeholder que falla con `Error: no test specified`. No afirmar que tests pasaron si no se agregan pruebas reales.

## Estructura de carpetas detectada

Patrones confirmados:

* `app.js`: importa `src/server.js`.
* `src/server.js`: arranque del servidor y graceful shutdown.
* `src/app.js`: construcción de Fastify y registro de plugins/rutas.
* `src/plugins/`: plugins de env, logger, security, db, auth, mailer y otros.
* `src/routes/v1/`: rutas versionadas.
* `src/routes/v1/public/`: rutas públicas.
* `src/services/`: lógica de negocio.
* `src/utils/`: utilidades compartidas.
* `src/config/`: configuración de conexión y entorno.

No asumir carpetas adicionales sin inspeccionarlas.

## Convenciones de código

* Mantener JavaScript ES Modules.
* No introducir TypeScript salvo instrucción explícita.
* No introducir Express en este backend Fastify.
* Usar Fastify plugins y rutas registradas por prefijo.
* Usar `AppError` para errores controlados.
* Usar `sendOk` y `sendError`.
* Usar JSON Schema en rutas.
* Usar SQL parametrizado.
* Mantener mensajes seguros para cliente.
* Mantener logs útiles para servidor sin filtrar secretos.
* No dejar `console.log`; usar logger del request/app cuando aplique.
* Mantener comentarios nuevos puntuales y necesarios.

## Reglas para nuevas funcionalidades

Antes de implementar:

1. Revisar ruta, servicio, plugin y utilidad relacionada.
2. Identificar si la ruta será pública o privada.
3. Validar auth y permisos si es privada.
4. Agregar JSON Schema para entrada.
5. Agregar response schema en endpoints críticos.
6. Mantener contrato `{ ok, data, requestId }` en éxito.
7. Mantener contrato `{ ok: false, error: { code, message, details? }, requestId }` en error.
8. Usar transacción cuando haya múltiples escrituras.
9. Liberar clientes DB en `finally`.
10. No exponer errores internos al cliente.
11. Revisar impacto frontend.

## Reglas para rutas Fastify

* Registrar rutas bajo `src/routes/v1`.
* Usar prefijos existentes.
* Mantener separación público/privado.
* No crear endpoints paralelos duplicados.
* No cambiar método/path sin revisar consumidores.
* Usar `params`, `querystring` y `body` schemas.
* Usar status codes correctos.
* Evitar handlers gigantes en nuevas rutas.
* Mover lógica repetible a `src/services`.

## Reglas para servicios

* Servicios deben contener lógica de negocio reutilizable.
* No mezclar transporte HTTP con lógica de negocio.
* No depender de `reply` dentro de servicios.
* Recibir `client`, `logger`, `actor` o parámetros explícitos.
* Lanzar `AppError` para errores de dominio.
* Mantener funciones con una responsabilidad clara.
* Usar nombres descriptivos.

## Reglas para base de datos

* Usar SQL parametrizado.
* No interpolar input del usuario.
* Usar `BEGIN`, `COMMIT`, `ROLLBACK` en flujos multi-step.
* Usar `FOR UPDATE` cuando haya cambio de estado sensible.
* Mantener idempotencia en pagos, webhooks y confirmaciones.
* No borrar datos si el negocio requiere cancelar, inactivar o marcar estado.
* No romper compatibilidad con datos legacy sin migración explícita.

## Reglas para seguridad

* Toda ruta privada debe validar autenticación.
* Toda operación sensible debe validar roles/permisos.
* No confiar en validaciones del frontend.
* No exponer stack traces, SQL details, secretos, configuración, tokens, provider config ni datos internos.
* Mantener CSRF para métodos mutables cuando haya cookie de sesión.
* Mantener CORS restringido a orígenes configurados.
* Mantener rate limit en rutas sensibles.
* Mock payment endpoints deben bloquearse explícitamente fuera de local/dev/test.
* Webhooks deben validar firma o usar un mecanismo seguro equivalente antes de confirmar pagos reales.

## Reglas para refactor

* No refactorizar por gusto.
* No mezclar refactor masivo con feature.
* Extraer una responsabilidad por vez.
* Preservar contratos API.
* Preservar códigos de error consumidos por frontend.
* Mantener compatibilidad con payloads legacy si ya existe.
* En rutas grandes, priorizar extracción de:

  * schemas.
  * mappers.
  * normalizadores.
  * servicios de negocio.
  * helpers de errores.
* Documentar riesgo reducido.

## Reglas para pruebas y verificación

Para cambios backend, recomendar o ejecutar:

1. `npm run lint`
2. Arranque local con `npm run dev` si aplica.
3. Verificación manual con Postman/curl del endpoint tocado.
4. Verificación de auth/roles si aplica.
5. Verificación de errores 400/401/403/404/409.
6. Verificación de transacciones si hay escrituras.
7. Verificación de contrato frontend si el endpoint es consumido por React.

No afirmar que `npm test` pasó mientras siga siendo placeholder.

No hacer pruebas infinitas. Una verificación enfocada por área de riesgo es suficiente.

## Cosas que Codex no debe hacer

* No migrar a Express.
* No convertir a TypeScript.
* No cambiar contratos API sin revisar frontend.
* No agregar dependencias sin justificación.
* No filtrar errores técnicos al cliente.
* No manipular pagos reales sin revisión explícita.
* No habilitar mock payment en producción/QA/staging.
* No eliminar datos si corresponde cambio de estado.
* No ignorar CSRF, CORS, cookies o rate limits.
* No escribir SQL con interpolación de input.
* No tocar módulos fuera del alcance.
* No simular pruebas inexistentes.
* No crear endpoints duplicados si uno existente puede extenderse de forma segura.

## Módulos críticos

Revisar con especial cuidado:

* `src/app.js`
* `src/server.js`
* `src/plugins/env.js`
* `src/plugins/security.js`
* `src/plugins/db.js`
* `src/plugins/auth.js`
* `src/routes/v1/index.js`
* `src/routes/v1/auth.js`
* `src/routes/v1/citas.js`
* `src/routes/v1/pagos.js`
* `src/routes/v1/public/`
* `src/services/agendamientoReservaService.js`
* `src/services/agendaService.js`
* `src/services/membershipService.js`
* `src/services/pointsService.js`
* `src/services/payments/`
* `src/utils/errors.js`

## Formato final obligatorio para Codex

A. Resumen backend
B. Archivos inspeccionados
C. Archivos modificados
D. Endpoints afectados
E. Cambios aplicados
F. Impacto frontend
G. Validaciones realizadas o recomendadas
H. Riesgos pendientes
I. Siguiente paso puntual, si aplica
