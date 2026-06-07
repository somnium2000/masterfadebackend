# Booking Business Rules - MasterFade

## 1. Proposito del documento

Este documento congela las reglas funcionales obligatorias del flujo de agendamiento de MasterFade antes de iniciar el refactor incremental del booking.

Debe usarse como contrato operativo para cualquier cambio futuro en el flujo publico `/agendar/*`, el flujo autenticado Home/Clientes, holds, disponibilidad, pagos, membresias, promociones, recompensas, acompanantes, historial y confirmacion.

Cada microfase futura debe indicar que reglas protege y como evita degradar estas invariantes.

## 2. Alcance

Incluye:

- Flujo publico de agendamiento.
- Flujo autenticado desde Home/Clientes.
- Seleccion de sucursal, barbero, servicio, paquete, fecha y horario.
- Acompanantes.
- Holds o reservas temporales.
- Pagos y payment intents.
- Membresias, promociones, recompensas y cortesias.
- Pago pendiente, abandono y recuperacion.
- Confirmacion y visibilidad posterior de la cita.

No incluye:

- Rediseno visual.
- Reescritura completa del flujo.
- Nuevas tablas o endpoints no confirmados.
- Cambios de schema, API o comportamiento por si mismo.
- Conversion a TypeScript o incorporacion de librerias.

## 3. Principios base

- El backend es la fuente de verdad para toda decision de negocio.
- El frontend puede prevalidar para mejorar UX, pero debe tolerar rechazo del backend.
- Todo refactor debe preservar contratos publicos o declarar explicitamente el cambio.
- Los cambios deben ser pequenos, verificables y reversibles.
- Los pagos, holds, membresias, promociones, recompensas y confirmaciones deben ser idempotentes.
- `sessionStorage` puede ayudar a recuperar contexto visual, pero nunca define una verdad de negocio.
- El flujo publico y el flujo autenticado comparten pantallas, pero no comparten el mismo contrato funcional.

## 4. Fuentes de verdad

| Decision | Fuente de verdad | Frontend puede prevalidar | Backend debe validar | Base de datos debe proteger |
|---|---|---|---|---|
| Sucursal valida | Backend/BD | Si, segun catalogo cargado | Si | Existencia, estado activo, no eliminada |
| Barbero/recurso valido | Backend/BD | Si, segun catalogo cargado | Si | Relacion con sucursal, estado activo |
| Servicio/paquete valido | Backend/BD | Si, segun catalogo cargado | Si | Tarifas, disponibilidad, estado activo |
| Duracion real | Backend | Solo estimar | Si | Datos de servicio/paquete |
| Disponibilidad real | Backend/BD | Si, como guia visual | Si | Citas, holds, bloqueos, horarios |
| Total final | Backend | Solo estimar | Si | Precios, descuentos, pagos |
| Membresia aplicable | Backend/BD | Mostrar estado visible | Si | Suscripcion, sucursal, consumo |
| Promocion aplicable | Backend/BD | Mostrar candidatas | Si | Reglas, vigencia, cupos, usos |
| Recompensa/cortesia aplicable | Backend/BD | Mostrar opcion | Si | Puntos, canje, consumo, trazabilidad |
| Requiere pago | Backend | Mostrar segun respuesta backend | Si | Total final, estado del grupo |
| Pago confirmado | Backend/BD/proveedor | No | Si | Payment intent, payment event, payment row |
| Confirmacion sin pago | Backend | No como decision final | Si | Total cero, hold activo, identidad |
| Estado final de cita | Backend/BD | Mostrar respuesta | Si | Transiciones y consistencia |
| Identidad del titular autenticado | Backend/Auth/BD | Mostrar perfil | Si | Usuario, cliente, persona |
| Recuperacion de pago pendiente | Backend/BD | Guardar pistas UX | Si | Grupo, intent, hold, vencimiento |

## 5. Invariantes obligatorios

### R1 - Backend como fuente de verdad

El frontend solo puede prevalidar para UX. El backend decide finalmente:

- Disponibilidad.
- Sucursal valida.
- Barbero o recurso valido.
- Servicio o paquete valido.
- Duracion real.
- Total final.
- Membresia aplicable.
- Promocion aplicable.
- Recompensa o cortesia aplicable.
- Si requiere pago.
- Si puede confirmar sin pago.
- Estado final de la cita.

Ningun refactor puede mover estas decisiones finales al frontend.

### R2 - No confirmar cita sin disponibilidad final

Una cita no puede quedar confirmada si el backend no valido disponibilidad al final.

Debe validarse como minimo:

- Al crear hold.
- Antes de confirmar sin pago.
- Antes de marcar como confirmada despues de pago.

Si durante el flujo el horario fue tomado, el backend debe rechazar y el frontend debe permitir reseleccion segura.

### R3 - No confirmar cita con saldo pendiente sin pago confirmado

Si el total a pagar es mayor que cero, el backend no puede confirmar la cita hasta tener pago valido confirmado.

No se permite confirmar por estado local, URL, `sessionStorage`, bandera visual o respuesta no verificada.

### R4 - Payment intent no reutilizable

Un payment intent pertenece a un unico grupo de cita.

No puede usarse si esta:

- Expirado.
- Fallido.
- Cancelado.
- Consumido.
- Asociado a otro grupo.
- Asociado a otro cliente o titular cuando aplique.

La recuperacion de pago debe consultar backend antes de continuar.

### R5 - Idempotencia obligatoria

Debe protegerse contra:

- Doble clic.
- Doble submit.
- Doble hold.
- Doble payment intent.
- Doble confirmacion.
- Doble consumo de membresia.
- Doble consumo de recompensa.
- Doble registro de pago.

La idempotencia debe existir en backend y, cuando sea posible, estar reforzada por constraints o eventos unicos en base de datos.

### R6 - Holds controlados

Todo horario seleccionado debe protegerse con hold o reserva temporal.

Un hold debe poder:

- Crearse.
- Expirar.
- Liberarse.
- Consumirse.
- Asociarse a grupo de cita.
- Validarse contra usuario, titular o token.
- Bloquear choques contra otros holds o citas.

La ausencia de una ruta o mecanismo de liberacion debe tratarse como deuda funcional critica antes de separar UI.

### R7 - SessionStorage no es fuente de verdad

`sessionStorage` solo puede ayudar a recuperar UX.

Nunca debe definir:

- Cita confirmada.
- Pago confirmado.
- Disponibilidad real.
- Total final.
- Membresia valida.
- Recompensa valida.
- Promocion valida.
- Identidad real del titular.

Toda recuperacion desde `sessionStorage` debe revalidarse contra backend.

### R8 - Publico y autenticado no son el mismo contrato

Flujo publico:

- Usuario no autenticado.
- Visitante nuevo o cliente sin sesion.
- Requiere datos de contacto.
- No usa permisos privados.

Flujo Home/Clientes:

- Usuario autenticado.
- Rol cliente.
- Perfil minimo obligatorio.
- Titular viene de sesion/perfil.
- Identidad no debe editarse libremente.
- Puede tener membresia, puntos, recompensas o pago pendiente.

Un componente puede compartir UI, pero los contratos y validaciones de negocio deben estar separados.

### R9 - Perfil incompleto bloquea Home/Clientes

Desde Home/Clientes no se debe permitir agendar si el perfil minimo esta incompleto.

El backend debe bloquear la creacion de reserva autenticada cuando falten campos obligatorios y responder con codigo y campos faltantes. El frontend debe guiar al cliente a completar perfil.

### R10 - Membresia solo aplica al titular

Por ahora:

- El titular puede usar membresia.
- El acompanante se cobra como cliente normal.
- Extras se cobran si no estan cubiertos.
- Servicios fuera del plan se cobran.

No se puede extender cobertura a acompanantes sin regla explicita de backend.

### R11 - Membresia de otra sucursal no cubre

Si la membresia no aplica a la sucursal seleccionada, no debe cubrir la cita.

El backend debe calcular la sucursal aplicable y devolver motivo de no aplicacion cuando corresponda.

### R12 - Promociones, cortesias y recompensas se validan en backend

La UI puede mostrar opciones, pero backend decide:

- Vigencia.
- Cupo.
- Compatibilidad.
- Sucursal.
- Servicio o paquete aplicable.
- Cliente elegible.
- Acumulacion permitida.
- Prioridad.
- Total final.

La seleccion visual no implica aplicacion final.

### R13 - No mezclar beneficios sin regla explicita

No combinar automaticamente:

- Membresia + promocion.
- Promocion + recompensa.
- Cortesia + recompensa.
- Promocion + cupon.
- Beneficio del titular con acompanante.

Si alguna combinacion se permite en el futuro, debe existir regla explicita en backend y validacion de contrato.

### R14 - Acompanantes con reglas claras

Acompanantes deben cumplir:

- Misma sucursal del titular.
- Misma fecha del titular.
- Pueden tener hora distinta.
- Pueden tener barbero distinto.
- No estan cubiertos por membresia del titular.
- Sus servicios y extras suman al total.
- No deben generar choque de horario.
- Datos validos si se requieren.

La identidad, contacto y seleccion de cada integrante deben tener contrato frontend/backend claro.

### R15 - Disponibilidad real por barbero/recurso

La disponibilidad debe considerar:

- Horario laboral.
- Duracion del servicio.
- Bloqueos manuales.
- Citas existentes.
- Holds vigentes.
- Feriados o cierres.
- Tiempo de preparacion si aplica.
- Capacidad del barbero.
- Capacidad de sucursal si aplica.

Si algun factor no esta implementado, debe registrarse como brecha y no asumirse.

### R16 - Pago pendiente con contrato claro

Si existe pago pendiente:

- No crear nuevo hold conflictivo sin resolver.
- Permitir retomar pago si sigue vigente.
- Permitir descartar si la regla lo permite.
- No duplicar cita.
- No perder trazabilidad.

El frontend puede mostrar modal o navegacion de recuperacion, pero backend decide vigencia y pertenencia.

### R17 - Abandono y errores recuperables

El sistema debe contemplar:

- Abandono antes de hold.
- Abandono despues de hold.
- Abandono despues de intent.
- Error de red.
- Pago fallido.
- Pago pendiente.
- Horario tomado durante el flujo.
- Sesion expirada.
- Backend caido.
- Baja conectividad.

La recuperacion debe ser segura: no duplicar citas, no consumir beneficios dos veces y no confirmar sin verdad backend.

### R18 - Cita confirmada visible en todo el sistema

Despues de confirmar, la cita debe aparecer correctamente en:

- Pantalla de exito.
- Home/Clientes.
- Panel administrativo.
- Agenda del barbero.
- Historial.
- Reportes internos.
- Notificaciones.

La confirmacion no termina en la pantalla de exito; debe quedar trazable en el sistema completo.

## 6. Estados minimos esperados

### 6.1 Estados de cita

Estados actuales encontrados en codigo:

- `en_espera`
- `pendiente_pago`
- `confirmada`
- `en_salon`
- `en_atencion`
- `cancelada`
- `expirada`
- `no_show`
- `completada`
- `cancelada_por_cliente`

Evidencia dirigida:

- `src/services/agendaService.js` define `OCCUPIED_APPOINTMENT_STATES`, `HOLD_EXPIRABLE_APPOINTMENT_STATES` y `APPOINTMENT_STATE_TRANSITIONS`.
- `src/routes/v1/citas.js` usa `cancelada_por_cliente`, `expirada`, `pendiente_pago` y validaciones de historial.
- `src/routes/v1/public/pagos.js` marca citas como `pendiente_pago`, `confirmada` o `expirada`.

Estados ideales propuestos:

- `cancelada_por_sistema`: estado ideal propuesto para distinguir expiracion/cancelacion tecnica de cancelacion del cliente si el negocio lo requiere.
- `requiere_revision`: estado ideal propuesto para conciliaciones manuales de pago o inconsistencias.

Estos estados ideales no deben usarse como existentes hasta confirmarlos o crearlos mediante una microfase aprobada.

### 6.2 Estados de pago

Estados actuales encontrados en codigo para payment intent:

- `creado`
- `link_generado`
- `pendiente_confirmacion`
- `confirmado`
- `fallido`
- `expirado`

Estados actuales encontrados en codigo para payment row:

- `capturado`

Evidencia dirigida:

- `src/routes/v1/public/pagos.js` define estados activos de intent y transiciones de mock/simulador.
- `src/routes/v1/citas.js` usa `ACTIVE_PAYMENT_INTENT_STATES`.
- `src/services/membershipService.js` usa estados equivalentes para intents de membresia.

Estados ideales propuestos:

- `cancelado`: estado ideal propuesto para intent anulado explicitamente, si la pasarela y BD lo soportan.
- `consumido`: estado ideal propuesto si se requiere separar pago confirmado de pago ya aplicado a una cita.
- `requiere_conciliacion`: estado ideal propuesto para pagos pendientes de revision manual.

Estos estados ideales no deben tratarse como actuales sin inspeccion de BD y aprobacion de contrato.

### 6.3 Estados de hold

Estados actuales encontrados en codigo:

- `activo`
- `expirado`
- `consumido`

Evidencia dirigida:

- `src/services/agendaService.js` expira holds `activo` a `expirado`.
- `src/routes/v1/public/pagos.js` consume holds con estado `consumido` despues de pago.
- `src/routes/v1/citas.js` mantiene `consumido` o expira holds al descartar pendiente.

Estados ideales propuestos:

- `liberado`: estado ideal propuesto para liberacion voluntaria antes de expirar, si la BD y contrato lo soportan.
- `cancelado`: estado ideal propuesto si se requiere diferenciar cancelacion operativa de expiracion.

Estos estados ideales no deben usarse como existentes hasta confirmarlos o incorporarlos en una microfase aprobada.

## 7. Fronteras frontend/backend

Frontend puede:

- Mostrar pasos del wizard.
- Cargar catalogos y disponibilidad como guia visual.
- Prevalidar campos requeridos.
- Evitar doble clic local.
- Mostrar errores recuperables.
- Guardar pistas temporales en `sessionStorage`.
- Construir payloads segun contrato documentado.

Frontend no puede:

- Confirmar disponibilidad como verdad final.
- Confirmar pago.
- Decidir total final.
- Aplicar beneficios finales.
- Confirmar cita.
- Definir identidad del titular autenticado.
- Reutilizar intent o hold sin validacion backend.

Backend debe:

- Validar identidad, rol y perfil.
- Validar sucursal, barbero, servicio, paquete y disponibilidad.
- Crear, expirar, liberar y consumir holds.
- Calcular total final.
- Aplicar o rechazar beneficios.
- Crear y validar payment intents.
- Confirmar pago.
- Confirmar o rechazar cita.
- Mantener trazabilidad y estados consistentes.

Base de datos debe:

- Proteger unicidad y relaciones criticas.
- Evitar duplicados de eventos de pago.
- Mantener referencias entre grupo, cita, hold, intent, pago y beneficios.
- Permitir auditoria de estados y transiciones.

## 8. Reglas especificas por flujo

### 8.1 Flujo publico

- No requiere sesion.
- Debe solicitar datos de contacto del titular.
- `POST /v1/public/citas/hold` acepta `integrantes[].rol_integrante_codigo` y `integrantes[].contacto`.
- `POST /v1/public/citas/hold` acepta promociones solicitadas por integrante con `integrantes[].promociones[]`.
- `integrantes[].id_promocion` e `integrantes[].id_promocion_regla` quedan solo como compatibilidad temporal y se normalizan internamente a `promociones[]`.
- Puede validar si un email pertenece a una cuenta activa y guiar a login.
- No debe usar endpoints privados ni permisos de cliente autenticado.
- Debe crear hold antes de pago.
- Debe confirmar solo mediante pago backend o regla backend de total cero, si existe.
- Debe tratar recuperacion de pago como UX, no como verdad.

### 8.2 Flujo Home/Clientes

- Requiere usuario autenticado con rol cliente.
- El titular viene de sesion/perfil.
- El perfil minimo es obligatorio.
- `POST /v1/citas/hold` no acepta `integrantes[].rol_integrante_codigo` ni `integrantes[].contacto` en el contrato actual.
- `POST /v1/citas/hold` no acepta seleccion explicita de promocion dentro de `integrantes` en el contrato actual.
- La identidad del titular no debe editarse libremente desde el booking.
- Puede tener membresia, puntos, recompensa o pago pendiente.
- Si existe pago pendiente vigente, no debe crear un hold conflictivo nuevo.
- Debe permitir retomar o descartar pago pendiente solo si backend lo valida.

## 9. Reglas de acompanantes

- Los acompanantes pertenecen al mismo grupo de cita.
- Deben usar la misma sucursal y fecha que el titular.
- Pueden tener otra hora o barbero si backend valida disponibilidad.
- No reciben cobertura de membresia del titular.
- Sus servicios, paquetes y extras suman al total del grupo.
- Su contacto debe validarse segun el contrato de flujo publico o autenticado.
- No deben solaparse con otro integrante si usan el mismo barbero/recurso.
- La autoasignacion de barbero debe ser decision backend.

## 10. Reglas de beneficios

### 10.1 Membresia

- Solo aplica al titular.
- Solo aplica si esta activa y corresponde a la sucursal seleccionada.
- Solo cubre servicios incluidos y disponibles segun backend.
- Extras, servicios no incluidos y acompanantes se cobran.
- Si falla el calculo de cobertura, el sistema debe responder de forma segura y no regalar cobertura.

### 10.2 Promociones

- La UI puede mostrar promociones candidatas.
- Backend decide vigencia, compatibilidad, cupo, sucursal, barbero, horario, cliente elegible y total final.
- No se debe asumir que una promocion visualmente seleccionada sera aplicada.
- En hold publico, las promociones solicitadas deben revalidarse por backend y rechazarse si alguna no queda aplicada.
- Una misma promocion no puede duplicarse en el mismo integrante.
- Si dos promociones solicitadas no son compatibles, el backend debe rechazar la combinacion de forma segura.
- En hold autenticado, las promociones se calculan por backend; el frontend no debe enviar campos de promocion en `integrantes`.
- La trazabilidad de promociones aplicadas o descartadas debe quedar en backend/BD.

### 10.3 Recompensas/cortesias

- Backend decide si la recompensa o cortesia es valida.
- El canje no debe consumirse dos veces.
- La recompensa/cortesia no debe mezclarse con otros beneficios sin regla explicita.
- Si el saldo de puntos o la transaccion cambia durante el flujo, backend debe rechazar o recalcular.

## 11. Reglas de pago

- Si `total_pagar_hnl > 0`, se requiere pago confirmado por backend.
- El payment intent debe estar asociado a un grupo/cita/hold valido.
- `GET /v1/public/pagos/estado` debe rechazar intents que no pertenezcan al `id_grupo_cita`, cita anchor, hold, titular o monto vigente.
- `mock-completar` y `simulator/event` deben validar grupo, proveedor, estado y monto antes de confirmar.
- La confirmacion post-pago debe revalidar estado confirmable, hold activo/no vencido y conflictos de disponibilidad antes de marcar citas como `confirmada`.
- El intent no debe estar expirado, fallido, cancelado o ya consumido.
- El registro de pago debe ser idempotente.
- Los eventos de proveedor deben tener identificador unico.
- El frontend nunca debe marcar pago confirmado por URL, storage o estado local.
- La confirmacion posterior al pago debe ser transaccional y trazable.

## 12. Reglas de hold/disponibilidad

- Crear hold requiere disponibilidad backend.
- Hold activo bloquea el horario contra otros holds y citas.
- Hold expirado no permite confirmar ni pagar.
- Hold consumido no debe reusarse para nueva reserva.
- Liberacion de hold debe validar titular, usuario o token.
- La disponibilidad debe recalcularse cuando cambia sucursal, barbero, servicio, paquete, fecha, hora o integrantes.
- Si no existe mecanismo de liberacion explicito, debe tratarse como deuda antes de refactors mayores.

### 12.1 Release publico de hold

Estado confirmado por codigo/migraciones:

- `src/routes/v1/public/citas.js` crea grupos y holds publicos.
- `src/routes/v1/public/citas.js` expone `DELETE /v1/public/citas/hold/:id_grupo_cita`, pero solo opera si la BD ya tiene columnas seguras para token.
- `db/migrations/20260607_public_hold_release_token.sql` agrega `release_token_hash` y `release_token_created_at` para release publico seguro.
- `POST /v1/public/citas/hold` devuelve `release_token` solo si existen `citas_grupos.release_token_hash` y `citas_grupos.release_token_created_at`.
- El frontend modela `release_token` como dato operativo temporal y lo envia en el body del release publico.

Contrato final:

```http
DELETE /v1/public/citas/hold/:id_grupo_cita
Content-Type: application/json
```

```json
{
  "release_token": "<token>"
}
```

Reglas del endpoint:

- Requerir `id_grupo_cita` valido.
- Requerir y validar `release_token` contra backend/BD.
- Expirar holds vencidos antes de liberar.
- Rechazar grupos con citas `pendiente_pago`, `confirmada`, `en_salon`, `en_atencion`, `completada` o `no_show`.
- No liberar holds `consumido`.
- Responder idempotente si el grupo ya esta `cancelado`, las citas ya estan `cancelada`/`expirada`, o no quedan citas liberables.
- Usar solo estados existentes: `cancelada` para citas liberables `en_espera` y `expirado` para holds activos si no existe un estado de hold `cancelado` confirmado.
- No exponer titular, contacto, token ni detalles internos en errores publicos.
- Si la BD no tiene columnas de token, el release responde `409 PUBLIC_CITAS_HOLD_RELEASE_NOT_CONFIGURED` y no libera nada.

SQL incluido en `db/migrations/20260607_public_hold_release_token.sql`:

```sql
ALTER TABLE public.citas_grupos
  ADD COLUMN IF NOT EXISTS release_token_hash text,
  ADD COLUMN IF NOT EXISTS release_token_created_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_citas_grupos_release_token_hash
  ON public.citas_grupos (release_token_hash)
  WHERE release_token_hash IS NOT NULL;
```

La aplicacion debe generar un token aleatorio fuerte, guardar solo hash en BD y devolver el token plano una sola vez al crear el hold publico.

## 13. Reglas de abandono y recuperacion

- Abandono antes de hold no debe dejar datos persistidos de reserva.
- Abandono despues de hold debe depender de expiracion o liberacion segura.
- Abandono despues de intent debe permitir retomar o descartar segun backend.
- Error de red no debe duplicar hold, intent, pago o confirmacion.
- Pago fallido o expirado debe dejar el sistema en estado recuperable.
- Sesion expirada debe detener flujo autenticado y no confirmar operaciones pendientes sin reautenticacion.
- Backend caido o baja conectividad debe mostrar error recuperable sin asumir exito.

## 14. Reglas prohibidas

Durante el refactor nunca se debe:

- Reescribir `PublicBookingFlow.jsx` completo en una sola fase.
- Partir UI antes de congelar contratos.
- Modificar pagos sin idempotencia clara.
- Tocar membresia, promociones o recompensas sin aislar sus reglas.
- Asumir tablas.
- Asumir endpoints.
- Confiar en frontend como fuente de verdad.
- Confirmar sin pago si hay saldo pendiente.
- Confirmar sin disponibilidad final.
- Depender de `sessionStorage` como verdad.
- Agregar librerias.
- Convertir a TypeScript.
- Hacer pruebas infinitas.
- Mezclar rediseno visual con refactor funcional.
- Cambiar schemas sin actualizar todos los consumidores.
- Introducir endpoints nuevos sin contrato y validacion.
- Aplicar beneficios a acompanantes por accidente.

## 15. Como usar este documento en microfases futuras

Cada microfase futura debe declarar:

- Reglas protegidas, usando identificadores R1 a R18.
- Archivos tocados.
- Contrato API afectado o confirmacion de que no cambia.
- Datos o tablas involucradas, si aplica.
- Validacion frontend.
- Validacion backend.
- Criterios de aceptacion.
- Riesgo que reduce.
- Forma segura de rollback.

Una microfase no debe aprobarse si no puede explicar que regla protege o que riesgo funcional reduce.
