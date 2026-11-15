# Revision estatica: migraciones Hosted y coexistencia QA

Fecha: 14 de noviembre de 2026. Alcance: revision independiente del SQL candidato y de la seleccion de proveedores. No se aplicaron migraciones, ni siquiera a una base temporal, durante esta revision. No se realizaron consultas financieras, despliegues ni cambios de configuracion. La matriz usa objetos sinteticos y las funciones puras de configuracion; no acredita el entorno efectivo desplegado.

## Resultado

El candidato apagado puede convivir con TodoPago QA simulado. **Hosted activo y TodoPago QA simulado activo no coexisten con el contrato actual.** Se requiere una seleccion por operacion o un entorno privado separado; cambiar solamente variables sustituye el proveedor global o impide arrancar.

La revision identifico un hueco en la prohibicion de ordenes duplicadas cuando el grupo se completa mediante un trigger del sistema. Se corrigio el orden en el SQL candidato. La prohibicion de Sale SDK para un grupo Hosted permanecia, pero ese control no equivalia a impedir la nueva orden canonica. La correccion tiene validacion estatica y regresion PostgreSQL preparada; no se ejecuto esa regresion ni se aplico SQL en esta continuacion.

## Migraciones, orden y datos existentes

1. `db/migrations/pixel/20261114010000_pixelpay_hosted_qa.sql` agrega `payment_channel text NOT NULL DEFAULT 'sdk' CHECK (...)`, la tabla privada de sesiones y los triggers de exclusion de canales.
2. `db/migrations/pixel/20261114120000_pixelpay_hosted_financial_guard.sql` agrega los bloqueos de confirmacion y `paid_at` de Hosted en `payment_intents` y `payments`.

El orden 1 -> 2 es obligatorio y ambas deben estar presentes antes de permitir inicios Hosted. La segunda funcion presupone la columna de la primera; instalarla antes puede dejar escrituras existentes fallando al evaluar `NEW.payment_channel`.

El SQL no ejecuta un `UPDATE` de datos existentes ni cambia estados, importes, identificadores de proveedor, `paid_at` o los intentos inciertos previos. Los registros anteriores, incluidos mock y TodoPago, pasan a leerse con el valor por defecto `sdk`; aqui `sdk` representa el canal anterior a Hosted, no demuestra una operacion SDK real. PostgreSQL implementa los defaults constantes sin actualizar individualmente cada fila al agregar la columna. Las restricciones y los bloqueos DDL siguen requiriendo un preflight y una ventana apropiada. [Referencia PostgreSQL](https://www.postgresql.org/docs/current/ddl-alter.html).

La primera migracion no es repetible: no usa `IF NOT EXISTS` al crear columna, tabla, funciones o triggers. Debe aplicarse una sola vez mediante el historial establecido y despues de comparar el esquema. Sus dependencias incluyen `app_private`, `payment_intents`, `payment_providers`, `citas_grupos`, `pixelpay_sale_attempts` y los roles referidos en los `REVOKE`.

## Hallazgo: orden de triggers y grupo derivado

La version anterior de la migracion 1 solo validaba `NEW.id_grupo_cita` en un INSERT cuando ese valor ya venia informado. Su trigger se llamaba `tr_guard_pixelpay_payment_channel`.

El esquema existente tiene `tr_payment_intents_set_group`, definido en `20260701_microfase_2a2_reconciliacion_transaccional.sql:750`; su funcion rellena `NEW.id_grupo_cita` desde `NEW.id_cita` cuando falta el grupo. Ambos son triggers `BEFORE INSERT FOR EACH ROW`. PostgreSQL los ejecuta por orden alfabetico: `tr_guard_...` precede a `tr_payment_...`. [Referencia CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html).

Por tanto, antes de la correccion un INSERT que omitiera el grupo pasaba por el guard sin lock ni consulta de sesiones; el normalizador lo asignaba despues. Existe un consumidor real con esa forma: `src/routes/v1/pagos.js:860` inserta un intento con `id_cita` sin `id_grupo_cita`. El flujo publico nuevo si envia el grupo explicitamente. Una cita de otro integrante del mismo grupo podia no encontrar el intento Hosted en la busqueda legacy por `id_cita` y alcanzar la insercion.

Impacto: puede existir otra orden canonica para un grupo que ya tiene Hosted. El trigger posterior sobre `pixelpay_sale_attempts` todavia impide emitir una Sale SDK para ese grupo; no se afirma que este hueco permita un segundo cargo SDK.

Correccion candidata realizada: renombrar el guard a `tr_payment_intents_zz_guard_hosted_channel`, que corre despues de `tr_payment_intents_set_group`, conservando la comprobacion en INSERT y UPDATE. `pixelpay-hosted-migration-order.test.mjs` contrasta los nombres con el normalizador versionado sin aplicar SQL. El fixture PostgreSQL ahora carga la funcion normalizadora real y prepara el INSERT legacy sin grupo para otra cita del mismo grupo. Esa regresion de base queda pendiente de ejecucion autorizada; no se cuentan como nuevas pruebas aprobadas los resultados PostgreSQL de la version anterior.

## Inmutabilidad, permisos e impacto SDK

- Sesion: `id_intent`, grupo, orden, importe, moneda y vencimiento son inmutables. Tras abandonar `creating`, tampoco cambian `creation_state` ni `checkout_url`. Las referencias de callback se conservan como no autenticadas y no autorizan una escritura financiera.
- Intent Hosted: el trigger impide volver a SDK y cambiar proveedor, grupo, cita, hold, propietario, orden, importe o moneda. El cambio inicial SDK -> Hosted exige una sesion; la ruta implementada crea la sesion y cambia el canal dentro de la misma transaccion.
- Exclusion SDK: la tabla de sesiones tiene unicidad por intento, grupo y orden. Los inserts de `pixelpay_sale_attempts` obtienen el lock del grupo y rechazan cualquier grupo con sesion Hosted. Los intentos SDK antiguos sin sesion conservan el camino normal; las funciones financieras nuevas solo bloquean `payment_channel = 'hosted'`.
- Finanzas: la segunda migracion no reemplaza los triggers SDK existentes. Hosted no puede establecer `paid_at`, confirmar el intent ni insertar/actualizar pagos como `capturado`, `conciliado` o `manual_pagado`. Expirar un intent sin `paid_at` sigue permitido.
- Privacidad: la tabla vive en `app_private`, activa RLS sin politicas y revoca permisos a `PUBLIC`, `anon`, `authenticated` y `service_role`. Los triggers no elevan privilegios mediante `SECURITY DEFINER`.
- Prerrequisito de despliegue: verificar el rol SQL efectivo del backend. La concesion explicita es a `postgres`; los guards invoker leen la tabla privada incluso para INSERT SDK de citas con grupo. Un escritor REST `service_role` o un rol custom sin acceso a esa tabla puede fallar despues de instalar la migracion aun con Hosted apagado. El codigo normal usa `app.db`/`pg`, pero la configuracion admite usuarios DB distintos; esta revision no comprobo el rol desplegado. No se propone ampliar permisos publicos ni usar `SECURITY DEFINER` para ocultar esa diferencia.

## Matriz de configuracion, comprobada sin red

Se llamaron `resolvePixelPayHostedConfig`, `resolveQaPaymentSimulationConfig` y `resolveQaVipPurchaseSimulationConfig` con fixtures sinteticos. Ninguna prueba cargo credenciales del entorno ni construyo un proveedor.

| Configuracion | Hosted | Simulacion QA/VIP | Resultado de arranque esperado |
| --- | --- | --- | --- |
| TodoPago `preprod_simulated`, flags QA completos, Hosted off sin claves | Deshabilitado | Habilitada | Compatible |
| Mismos valores y Hosted on | Rechaza `PAYMENT_PROVIDER=todopago` | Habilitada | Incompatible |
| Cambiar proveedor a PixelPay, conservar flags QA/VIP true | Habilitado con Sandbox dedicado | Rechaza porque exige TodoPago | Incompatible |
| PixelPay y apagar flags QA/VIP | Habilitado | Deshabilitada | Sustituye simulador global |
| TodoPago, Hosted off, claves/callback dedicados retenidos y `PIXELPAY_ENV=sandbox` | Solo receptor | Habilitada | Compatible para recuperar sesiones existentes |
| Hosted off pero claves retenidas sin `PIXELPAY_ENV=sandbox` | Rechaza configuracion | Habilitada | Incompatible hasta corregir entorno dedicado |

Fuentes: `src/services/payments/pixelPayHosted.js:14`, `src/config/qaPaymentSimulation.js:16`, `src/config/qaPaymentSimulation.js:60`, `src/plugins/env.js:129`.

## Por que no basta con habilitar la bandera

1. Hosted activo requiere `PAYMENT_PROVIDER=pixelpay` en su resolver. TodoPago QA y VIP simulados requieren globalmente `PAYMENT_PROVIDER=todopago`.
2. `/crear-intent` elige el proveedor canonico desde `app.config.paymentProvider` y construye el adaptador global. Con TodoPago no crea una orden PixelPay.
3. `/pixelpay/hosted/start` exige que el intento ya sea `provider_code = 'pixelpay'`; no convierte intentos TodoPago/mock ni debe hacerlo.
4. El frontend muestra el selector Hosted solo cuando `resolvePaymentSimulationAction` identifica PixelPay por `VITE_PAYMENT_PROVIDER` y el backend devuelve `hosted_available`. Con el build QA TodoPago, ese selector permanece oculto.

Fuentes backend: `src/routes/v1/public/pagos.js:1953`, `src/routes/v1/public/pagos.js:2095`, `src/routes/v1/public/pixelPayHosted.js:60`. Fuentes frontend: `PublicBookingPaymentStep.jsx:268`, `PublicBookingPaymentStep.jsx:384`, `PublicBookingPaymentStep.jsx:697`.

## Cambio minimo posible para coexistencia real, no implementado

Mantener el proveedor global TodoPago/mock y sus banderas actuales. Usar la capacidad Hosted dedicada de QA/Sandbox para una eleccion explicita antes de crear el intento: el backend genera una orden PixelPay nueva para esa eleccion, con identidad, pricing y hold canonicos, sin invocar ni cambiar la fabrica global. Puede ser un contrato opcional en `/crear-intent` o una preparacion Hosted separada que comparta los helpers actuales.

Esto requiere tres ajustes coordinados: desacoplar la admision Hosted del proveedor global conservando QA/Sandbox y los guards comerciales; seleccionar el proveedor al crear la orden canonica; y permitir que el frontend use la capacidad del backend antes del bootstrap automatico del intento, independientemente de `VITE_PAYMENT_PROVIDER`. El endpoint `GET /pixelpay/hosted/capabilities` ya existe para esa capacidad. Ningun intento creado con TodoPago, mock o SDK debe cambiar de proveedor/canal; cualquier intento anterior enviado o incierto bloquea una nueva eleccion para el mismo grupo. Conservar los guards de unicidad y corregir primero el hueco del grupo derivado.

Esta propuesta no habilita la confirmacion financiera: Hosted sigue pendiente hasta demostrar un contrato autentico suficiente. No hay una combinacion de variables del candidato que permita la coexistencia activa solicitada sin esos cambios o sin un stack privado separado.

## Rollback previsto

Si aun no existen sesiones Hosted, mantener la bandera apagada conserva el comportamiento anterior; el codigo SDK tolera la ausencia de la columna mediante su fallback explicito. Una vez que existan sesiones, el rollback seguro suspende nuevas creaciones y conserva esquema, evidencias, callback y una version de aplicacion que conozca Hosted.

No hay una migracion down candidata ni se recomienda eliminar tabla/columna o revertir a `sdk` las sesiones existentes: destruiria la referencia durable y la exclusion de doble cobro. La retirada fisica, si alguna vez procede, requiere otra autorizacion, demostrar ausencia de sesiones pendientes y una revision de dependencias. Ninguna accion de rollback se ejecuto en esta revision.
