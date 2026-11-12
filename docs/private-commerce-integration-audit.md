# Private Commerce Pilot: revision para integracion controlada

Auditoria 2026-11-12. No autoriza fusion, despliegue, activacion, trafico financiero,
DDL, cambios de credenciales ni cambios de datos. Complementa private-commerce-pilot.md.

## Snapshot de ramas y preservacion de main

| Repo | main actualizado | dev actualizado | Exclusivos main / dev |
| --- | --- | --- | --- |
| Backend | 866706d3f9c3c3e1b841c4e2a3b7e60193c7f6aa | 6c6b8ae2f00c9bbfc00d73622605e3b41aba082b | 14 / 7 |
| Frontend | 15cd0521de455e4c93be297d7fd1bc28fa5947e9 | 280ce91a5995ed7b53e9d98c2f250aa2a53e4afa | 21 / 14 |

Los numeros incluyen merges; no representan cambios todos diferentes. El RBAC frontend
e309e3f / 73c111e tiene patch equivalente. git merge-tree verifica sin mover ramas que
los PR iniciales no entran en conflicto con los nuevos cambios de agenda de dev.

main backend contiene autorizaciones ausentes en dev para register/confirm/resend,
social/confirm, catalogos publicos, perfil Cliente, cancelaciones y operacion administrativa.
Tambien elimina la comprobacion administrativa adicional de exchange que impedia altas.
No restaurar adminDataEntry.js desde dev al preparar la promocion. No incorporar sus
cambios de agenda, puntos, consumos o membresias al PR de produccion por arrastre.

La copia local de main con el piloto conserva intactos auth.js, authClaims.js,
routes/v1/auth.js, guestRegistrationService.js y la migracion de registro historico.
Su delta de adminDataEntry.js son solo la consulta de elegibilidad y la excepcion del
callback PixelPay a la pausa; no elimina ninguna autorizacion de main. Se probaron las
rutas de registro, login, exchange y catalogos con ADMIN_DATA_ENTRY_MODE=true,
PAYMENT_PROVIDER=disabled y piloto apagado usando handlers inertes. Esto prueba admision
por los guards, no crea usuarios reales ni certifica el servicio Auth productivo.
El harness administrativo existente y los guards del piloto pasaron juntos: 64/64.

## Excepcion CI: registro historico

Evidencia anterior al piloto, dev 68051c7:
https://github.com/somnium2000/masterfadebackend/actions/runs/43268116705/job/131357067358

Evidencia del PR #91, 5a1efed:
https://github.com/somnium2000/masterfadebackend/actions/runs/43276845033/job/131387404380

Ambos fallan en guest-registration-qa02g.postgres.test.mjs:124: la asercion exige 42P07
al reaplicar la migracion. La migracion detecta deliberadamente que la tabla ya existe
y lanza MF_GUEST_REGISTRATION_REQUESTS_ALREADY_EXISTS_REQUIRES_MANUAL_COMPARISON,
SQLSTATE P0001, antes de CREATE TABLE. La primera aplicacion y los otros nueve subtests
de permisos/servicio pasan; los dos FAIL contabilizados son ese subtest y su contenedor.
No se cambia ni se omite la asercion en este parche.

El fallo de reaplicacion no se ejecuta por una peticion de registro: npm start no aplica
migraciones. Registro normal y servicio de registro historico no tienen diff respecto a
main. Los 33 tests unitarios de registro historico pasan. No es evidencia de una averia
del registro productivo. Siguen sin verificarse aqui tabla/permisos/SMTP/Auth reales:
si faltan, el registro historico puede responder AUTH_REGISTER_TEMPORARY; no se afirma
salud productiva sin consultar el entorno con autorizacion separada.

El job postgres-17 del PR anterior paso suite, preflight, integracion y recuperacion.
El workflow completo sigue ROJO por guest-registration. La excepcion es para revision;
no es una aprobacion ni se modifica la proteccion de ramas.

## Contrato de elegibilidad e identidad

Se reprodujeron dos huecos del SHA auditado antes de corregirlos: invitado recibia 401
en la consulta y el propietario sin cliente podia recibir true. La consulta ahora da
HTTP 200 y {booking:false,vipPurchase:false} al invitado sin cookie y a otra cuenta valida.
El usuario autorizado necesita firma/sesion vigente, sub y usuario interno coincidentes,
rol cliente activo y cliente_id UUID obtenido de AUTH_CLAIMS_SQL. Ese SQL solo enlaza
clientes activos, no borrados y pertenecientes al usuario. El rol administrativo solo
no concede acceso. Cookies invalidas o errores internos mantienen sus errores; no se ocultan.

Pruebas del guard: 24/24, incluyendo API directa, cuenta diferente, cliente ausente/invalido,
rol solo administrativo, piloto/configuracion ausente, IP, CSRF y proxy. La sonda GET
de elegibilidad verifica cero consultas de negocio y cero instanciaciones del proveedor.
Cuatro pruebas positivas adicionales usan cookie firmada/autenticacion real y rutas
de reserva, orden, intent y activacion VIP sobre SQL en memoria y proveedor simulado.
No equivalen a un recorrido desplegado ni prueban la cuenta o PC real del propietario.

Cancelaciones y mantenimiento quedan fuera del guard comercial, conservando los guards
originales de sesion, rol, propiedad y sucursal. Admin hold/confirmar/payment-link nuevos
siguen dentro. El callback es independiente de IP/cookie/piloto y conserva las verificaciones
financieras y deduplicacion existentes. No se habilita el webhook ni se cambia su contrato.
La prueba HTTP del callback confirma recepcion y duplicate, no una nueva aprobacion Live.

## Proxy: requisitos y sonda sin pagos

Antes de activar se debe comprobar mediante inspeccion autorizada de red/configuracion:

1. Socket inmediato real del backend pertenece al Traefik de ese servicio, en su red
   interna. Registrar solo esa IP exacta en PRIVATE_COMMERCE_PROXY_IPS, nunca el host
   publico, un rango completo ni un valor obtenido de X-Forwarded-For.
2. TRUST_PROXY=true utiliza buildTrustProxy: solo un salto interno inmediato. El guard
   exige ademas peer exacto y request.ips.length === 2. Un CDN o segundo proxy requiere
   otra auditoria; no ampliar saltos para hacer pasar una prueba.
3. Traefik debe quitar valores externos no confiables y producir/agregar la IP real del
   cliente como ultimo elemento de X-Forwarded-For. forwardedHeaders.insecure no debe
   estar habilitado; cualquier upstream confiable exige allowlist explicita y revision.
4. El puerto backend no debe aceptar entrada publica directa. La red debe impedir que
   un cliente elija el peer permitido. Una cabecera por si sola nunca prueba la IP real.
5. Obtener la IP de salida observada desde la PC a traves de ese recorrido de red; contemplar
   IPv4/IPv6 y cambios de NAT. PRIVATE_COMMERCE_IPS solo contiene IPs exactas verificadas.

Sonda futura: solo GET /v1/commerce/eligibility, HTTPS, cache desactivada y cookie de la
sesion actual. No enviar contrasenas ni registrar cookies/UUID/IP en la respuesta publica.
No hacer POST a holds/intents/pagos para verificar acceso en un entorno desplegado.

| Contexto sintetico probado | Resultado |
| --- | --- |
| Piloto apagado / configuracion ausente | false / false |
| Invitado desde peer y salida permitidos | 200, false / false |
| Otra cuenta con sesion valida | 200, false / false |
| Propietario sin cliente activo/rol cliente | 200, false / false |
| Propietario, cliente, peer y salida autorizados | 200, true / true |
| Peer no permitido o XFF falsificado con IP real distinta al final | 200, false / false |

No se ha medido el peer ni la salida actuales de produccion. La futura sonda real con
piloto apagado solo puede confirmar false; el caso positivo se limita a configuracion
sintetica local hasta que se autorice activacion. Cuenta+IP no certifica hardware:
otra PC con la misma sesion y salida NAT comparte esas condiciones.

## Orden de revision y promocion

1. Revisar PR backend #91 y frontend #79 hacia dev. Resolver o aceptar explicitamente
   las excepciones CI; no declarar verdes los workflows rojos ni saltar protecciones.
2. Integrar primero en dev solo tras aprobacion. Revalidar refs si dev cambia. No integrar
   toda la historia de dev en main para publicar el piloto.
3. Crear despues ramas nuevas desde main actualizado. Aplicar solo los deltas del piloto
   ya revisados; resolver cada conflicto conservando las autorizaciones y hotfixes de main.
   La copia local backend demuestra aplicacion sin conflicto y preservacion de preventa.
4. La promocion frontend necesita adaptacion propia: mantener su pausa publica de VIP,
   permitir catalogo privado solo con elegibilidad, esperar elegibilidad antes de consumir
   el enlace de recompensa y no importar tests de paginacion que no existen en main.
   Ademas revisar por separado el arreglo UI abf1c4a de dev para la recuperacion de pantalla
   (restauracion de contexto antes de reclamar el efecto). No arrastrar agenda/branding ni
   modificar contratos financieros para resolver ese riesgo de React.
5. PRs minimos a main requieren su propia revision y pruebas afectadas. No se abren,
   fusionan ni despliegan en esta auditoria. Inicialmente todo queda apagado por defecto.
   Activacion y reversion independientes usan solo PRIVATE_COMMERCE_PILOT_ENABLED;
   no desactivar proveedor ni activar modo administrativo al conciliar pagos previos.

Los ajustes de esta auditoria se publican con [skip ci] para cumplir la instruccion de no
repetir suites completas. Sus pruebas focalizadas, lint y diff-check son locales. El CI
anterior se conserva como evidencia de sus SHA exactos; no certifica los nuevos HEAD.
Esta excepcion debe revisarse antes de integrar; no se modifica ningun workflow ni assert
financiero para ocultar los fallos.
