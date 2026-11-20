# Auditoría del contrato authenticationContinue

Esta revisión compara el SDK Core JavaScript instalado 2.5.8 con el gate público de la aplicación. No ejecuta solicitudes al proveedor y no acredita el cuerpo real de una respuesta Live.

## Comprobado en el SDK

- `lib/services/CardinalAuthentication.js`, método `authenticationContinue`: delega a POST `api/v2/cardinal/authentication/continue` y retorna una respuesta genérica; su firma tipada es `Promise<Response>`.
- `lib/base/ServiceBehaviour.js`, método `parseResponse`: clasifica HTTP200 como `SuccessResponse`, HTTP202 como `PayloadResponse` y los restantes códigos según sus clases. La clase por sí sola no prueba éxito: un HTTP200 con success falso también conserva `SuccessResponse`.
- El mismo parser usa `success = body?.success || false` y `action = body?.action || null`. Por ello action ausente, null, cadena vacía, false y cero quedan indistinguibles como null. La aplicación evalúa el resultado normalizado del SDK. Su comparación `success === true` sí rechaza valores truthy de otros tipos.
- `lib/libraries/CardinalManager.js`, callback `payments.validated`: para Sale obtiene la respuesta de authenticationContinue y después invoca retryTransaction sin evaluar su success o status. También existe una rama nativa de retry con NOACTION. La fachada pública de la aplicación impide esas autorizaciones implícitas.

## Política explícita de la aplicación

Solo una respuesta nativa `SuccessResponse`, HTTP200, success booleano true y action normalizada null admite la fase posterior a authenticationContinue. HTTP202/204 y errores, success ausente/falso/de otro tipo o action no nula bloquean retry. La UI además exige el evento Cardinal SUCCESS y el JWT opaco; el worker conserva el identifier obtenido de su propio lookup. Frictionless sigue su fase separada y no invoca authenticationContinue.

Este predicado acredita la aceptación de transporte de la continuación bajo una política conservadora de MasterFade. No se presenta como prueba de autenticación bancaria positiva. La [estructura oficial de respuestas](https://docs.pixelpay.com/page/sdk/getting-started#response-structure) describe success como éxito de la solicitud; [respuestas y entidades](https://docs.pixelpay.com/page/sdk/responses-entities) asigna la aprobación financiera a TransactionResult. Las páginas revisadas no definen un predicado bancario específico de este endpoint interno ni un envelope Live de authenticationContinue. No se inventan response_approved, CAVV, firma JWT ni identidad financiera para suplir esa evidencia.

El retry conserva la transacción y la identidad de lookup del worker, se despacha una vez con control durable y solo una respuesta financiera posterior verificada por backend puede crear pago y confirmar reserva. La aprobación, hash, importe y contradicciones de identidad se verifican aparte. Una continuación aceptada no autoriza a la UI a confirmar nada.

## Regresión reproducible

`node --test test/pixelpay-authentication-continue-contract.test.mjs` usa respuestas HTTP crudas sintéticas. Primero invoca authenticationContinue nativo y observa la clase y normalización reales; después repite cada caso por el worker de aplicación y comprueba si hubo o no retry financiero sintético. No fabrica instancias de Response para autorizar la continuación. Cubre códigos200/201/202/204/400/401/402/408/412/422/500/503/520, éxito ausente y de distintos tipos, acciones no nulas, normalización nativa y cuerpo vacío. Sockets/fetch externos y Status permanecen bloqueados.

Estas pruebas validan el control de flujo y la política del cliente con el SDK instalado. El contrato particular de Live y el submotivo del unsupported histórico siguen sin acreditarse; producción permanece fuera del alcance de estas pruebas.
