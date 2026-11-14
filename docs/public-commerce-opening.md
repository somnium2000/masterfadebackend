# Apertura publica controlada: reservas y VIP

Base backend: `9279962c6011485061740f114dbd369a76368942`. Base frontend: `8a245bb0255f2f91fc5ce696050e17fbcbc7ad34`. Cambio preparado para revision: no se fusiona, despliega ni cambia configuracion real en esta entrega.

## Controles del backend

| Variable | Por defecto | Funcion |
| --- | --- | --- |
| `PUBLIC_BOOKING_ENABLED` | `false` | Admite el flujo de reservas para clientes autenticados |
| `PUBLIC_VIP_PURCHASE_ENABLED` | `false` | Admite compras VIP independientemente de reservas |

Son booleanos estrictos (`true`/`false`). La disponibilidad efectiva exige `PAYMENT_PROVIDER=pixelpay` y `ADMIN_DATA_ENTRY_MODE=false`. No habilitan mocks, TodoPago o simuladores. Se mantienen los controles financieros y de entorno existentes de PixelPay.

La admision publica no usa allowlists, IP ni Traefik, ni exige habilitar el piloto. Se conserva el modo piloto anterior como recorrido separado; para esta apertura se mantiene `PRIVATE_COMMERCE_PILOT_ENABLED=false`.

`GET /v1/commerce/eligibility` devuelve:
- `publicBooking` y `publicVipPurchase`: disponibilidad de cada opcion, tambien para visitantes.
- `booking` y `vipPurchase`: permiso personal confirmado para la sesion actual.

Un flag de descubrimiento no autoriza crear un hold ni cobrar. Cada operacion exige cookie de sesion real, rol cliente, claims coherentes con usuario/persona/cliente activo y CSRF. Las rutas conservan propiedad, snapshots, montos, identidad financiera, idempotencia y proteccion contra doble cargo.

La lista de admision es exacta: reservas usa `/v1/citas/hold`, confirmacion y retomar propios, validacion auxiliar de contactos y los endpoints existentes de `/v1/pagos/reservas`. VIP tiene su lista separada. No abre rutas administrativas, prefijos genericos, simuladores ni las antiguas rutas publicas de hold/pago basadas solo en correo. Un visitante debe iniciar sesion antes de reservar; el cliente usa el adaptador autenticado.

## Frontend

No hay nuevas variables VITE de apertura. Mantener `VITE_PAYMENT_PROVIDER=pixelpay` y la `VITE_API_URL` productiva ya configurada, sin cambiar dominios o credenciales. La decision de apertura procede del backend; una bandera antigua de compilacion no lo sustituye.

La landing muestra Agendar al anunciarlo el backend. El visitante va a login con retorno local seguro y despues accede como cliente. La hidratacion y la elegibilidad inicial muestran espera; una renovacion de la misma identidad no desmonta el flujo mientras esta en curso. Una denegacion o fallo confirmado revoca el acceso; logout/cambio de usuario invalida la decision anterior. No se omiten rechazos reales del servidor.

El wrapper de liberacion de hold autenticado se alinea con el POST protegido existente `/v1/citas/pendiente/:id/descartar`; el DELETE anterior no existe en main. No se crean rutas ni se cambia la semantica financiera del descarte.

## Activacion futura, solo por el propietario tras autorizarla

1. Revisar y autorizar por separado ambos PR. Desplegar primero el backend con las dos variables nuevas en `false`, despues el frontend configurado con PixelPay. Esta secuencia no abre compras durante el cambio.
2. Verificar la version realmente servida y la elegibilidad: ambas disponibilidades publicas en false; revisar con sesion propia la API de conciliacion existente. Health por si solo no prueba la version o los permisos.
3. Para abrir inicialmente SOLO reservas, configurar:

```dotenv
PUBLIC_BOOKING_ENABLED=true
PUBLIC_VIP_PURCHASE_ENABLED=false
PRIVATE_COMMERCE_PILOT_ENABLED=false
PAYMENT_PROVIDER=pixelpay
PIXELPAY_ENV=live
ADMIN_DATA_ENTRY_MODE=false
```

Los dos primeros valores son los nuevos controles. Los demas describen la configuracion existente que se conserva; no se modifican claves, credenciales, dominios ni proxies. Las variables se cargan al arrancar el proceso: aplicar el cambio mediante el procedimiento manual autorizado del propietario y completar el reemplazo de todas las instancias.

4. Verificar que un visitante vea Agendar y vuelva del login al flujo autenticado. Cliente activo: `booking=true`; `vipPurchase=false`. Intentos sin sesion/rol/CSRF o de otros titulares deben rechazarse. Comprobar que las rutas administrativas, publicas antiguas y de simulacion no se abrieron.
5. No ejecutar una Sale Live automaticamente como parte de la activacion. La primera prueba Live requiere autorizacion y procedimiento propios. Ante timeout o resultado incierto no volver a cobrar.

## Reversion segura

Restaurar `PUBLIC_BOOKING_ENABLED=false` y `PUBLIC_VIP_PURCHASE_ENABLED=false`, manteniendo el piloto false y PixelPay configurado. Aplicar la configuracion a todas las instancias de backend por el procedimiento manual autorizado; no hace falta revertir codigo ni reconstruir el frontend para cerrar la admision.

La UI recogera la decision al cargar o renovar elegibilidad; el backend es quien rechaza nuevas operaciones. No borrar contexto, pagos, intents ni evidencia historica. Dejar finalizar las solicitudes financieras ya admitidas mediante el procedimiento de apagado gradual; no repetir una Sale al cambiar de version.

Webhooks y `GET /v1/cliente/pagos/:id_intent` / `POST /v1/cliente/pagos/:id_intent/conciliar` del #101 conservan sus controles independientes. La conciliacion exige sesion/titularidad/CSRF y evidencia durable; no utiliza Sale, Status o Void. Sin evidencia suficiente se mantiene el caso manual.

Limite explicito: la UI antigua de checkout/estado vuelve a quedar cerrada al apagar compras. La disponibilidad de la API #101 no significa que el frontend haya integrado un fallback automatico de conciliacion. El operador/titular autorizado utiliza el canal de recuperacion existente; no reabrir compras solo para conciliar. `ADMIN_DATA_ENTRY_MODE` conserva su bloqueo independiente y no se usa como interruptor de apertura.

## Evidencia de esta entrega

- Backend: 343 pruebas focalizadas PASS, incluyendo gate publico, JWT/CSRF/rol/propiedad, intento+Sale simulada de reserva autenticada, reenvio sin segundo cargo, ajenos rechazados, callbacks y recuperacion. 60 PASS PostgreSQL 17 con triggers v2 reales intactos y reservas publicas habilitadas en el proceso de prueba.
- Frontend: 233 PASS en 17 suites, incluyendo entrada publica, login, hidratacion, renovacion, revocacion, VIP, recuperacion/recarga, un solo cargo y contrato de liberacion de hold.
- Navegador local 390x844: cierre, apertura del CTA, login sintetico y retorno, renovacion sin desmontaje, revocacion y sin desbordamiento horizontal. Se interceptaron las APIs y se bloquearon todos los recursos externos; cero requests financieros. No acredita catalogos ni runtime productivos.
- Build frontend con `VITE_PAYMENT_PROVIDER=pixelpay`: PASS; advertencia de chunks grandes preexistente. Lint frontend: 0 errores/advertencias. Lint backend: 0 errores y 25 advertencias preexistentes. Diff-check: PASS.
- La primera ejecucion paralela frontend tuvo un timeout de una prueba de catalogo sin cambios; paso aislada y la matriz completa final paso con un worker, sin relajar aserciones ni omitir casos.

Estas pruebas no son una venta Live ni acreditacion bancaria. No se modificaron Supabase, triggers, datos financieros historicos, EasyPanel, secretos ni configuracion servida.
