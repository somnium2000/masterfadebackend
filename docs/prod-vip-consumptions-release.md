# Consumos VIP — cierre selectivo QA a PROD

## A. Resumen ejecutivo

Worktree independiente sobre origin/main 32e05f8e0e04e53279099a52d5d9f4eaaa84c9ad.
Se seleccionaron exclusivamente los hunks de consumo de QA origin/dev
9bd3bfacbd83967d55e6cbb0d2f086cd92806feb, procedentes de ad130f4 y 07f3c1d.
No se fusiono dev. No se trasladaron simulacion, compra, checkout, Hosted ni cambios
de evidencia financiera PixelPay. Las protecciones de pagos de main se conservan.

**GO para revision del consumidor y pruebas. NO-GO de activacion operativa aislada:**
el productor de evidencia de cobertura por linea no esta integrado en main. La lectura
PROD de las 16:04 America/Tegucigalpa muestra 12 reservas idempotentes y cero evidencias
version 1; QA tiene 206 y 11 respectivamente. Esto no se corrige rellenando datos.
El codigo de main confirma ademas que aun no construye/persiste membership_consumption.
Sin ese contrato, los consumos incluidos en un plan se rechazan para revision y no se
infiere una cuota desde el catalogo ni desde un descuento. No desplegar solo el consumidor.

## B. Archivos funcionales modificados

- src/services/membershipService.js: capacidades de evidencia, bloqueo por cita,
  elegibilidad, cuotas exactas por servicio/linea y cortesia, idempotencia por detalle,
  preservacion de movimientos legacy/invalidados y seleccion de plan por sucursal.
- src/routes/v1/citas.js: dos lineas para propagar el error de consumo y revertir
  la misma transaccion de confirmacion. No se cambia la creacion ni el calculo de reservas.

El ajuste de sucursal reutiliza el parametro idSucursal que ya tiene main. QA escogía
un solo plan global y su fixture imponia unicidad por cliente; el catalogo actual permite
uno activo por cliente/sucursal. El fixture se ajusta al indice real y una prueba con dos
planes confirma que se consume exclusivamente el plan de la sucursal de la cita.

No hay cambios en rutas Cliente, checkout, bookingCanonicalReservationService,
booking/adminBookingService, proveedores, credenciales ni flags. Las lecturas Cliente
paginadas y agrupadas por cita ya estaban integradas en main y se verifican sin cambiarlas.

## C. Diferencias QA/PROD resueltas y pendientes

Paridad de columnas/tipos requerida e indices de concurrencia: presente en ambos.
Los preflight de lectura dan cero en los seis controles. No se requiere DDL ni migracion.
PROD tiene cero consumos registrados en la observacion; QA tiene 17 unidades/17 movimientos.
Los hashes y conteos son dinamicos y solo evidencia del momento, no condiciones de sellado.

El consumidor seleccionado de QA realiza:

- Bloqueo de cita y suscripcion dentro de la transaccion del llamador.
- Beneficiario titular, pertenencia del cliente, sucursal, vigencia e inicio de plan.
- Identificacion de lineas canonicas y cantidades cubiertas; no consume los extras.
- Cuota por servicio y una cortesia elegible cuando corresponde; fallo revierte el conjunto.
- Reintento sin duplicar ni completar automaticamente un historial parcial/legacy.
- Cancelacion de cita/suscripcion e invalidaciones conservando el historial existente.
- Los roles/autenticacion y contratos seguros de main siguen vigentes.

El trigger diferido adicional de puntos visto en QA corresponde a MasterPuntos #123.
No se migra con este lote. El consumidor VIP no tiene dependencia SQL de ese trigger;
el cierre de MasterPuntos sigue su propio bloqueo financiero. No se modifican sus puntos.

## D. Pruebas y CI

test/membership-consumption-qa01.postgres.test.mjs reconstruye PostgreSQL17 efimero con
cuotas, claves unicas y el indice cliente/sucursal real. Cubre servicios distintos,
repetidos y agrupados, extra del mismo servicio, paquete, cortesia agotada, autor,
reintentos, claves legacy, concurrencia misma/diferente cita, fallo del segundo INSERT,
rollback, vigencia, cliente/sucursal, dos planes, cancelaciones e historial.
Las pruebas Cliente existentes cubren lecturas, paginacion, grupos, autenticacion y acceso
a suscripciones ajenas. La suite completa y CI del SHA del PR se reportan en su descripcion.

Los tests de productor/checkout de QA no se importan: ejercitan archivos del companero
que no se trasladan. La certificacion E2E de esos productores queda SKIP/dependencia,
no PASS. Las pruebas de consumidor usan evidencia sintetica versionada y no son prueba
de generacion real por main. No se ejecutaron pagos ni escrituras en Supabase.

## E. SQL, preflight, postflight y rollback

SQL de escritura requerido: **ninguno**. No hay apply SQL, backfill ni regularizacion.
Los archivos db/manual/vip-release/00-preflight.sql y 20-postflight.sql son SELECT
REPEATABLE READ READ ONLY. El generador offline verifica los catalogos actuales.

Secuencia futura, una vez aprobado el productor y una ventana sin escritores:

1. Verificar main, SHA de ambos candidatos y proyecto PROD pdzsmkjnyazpkoocjbpw.
2. Ejecutar 00-preflight.sql: seis affected=0. Archivar digest/conteos de consumos.
3. Aportar SHA revisado del productor y una prueba de confirmacion+consumo atomica
   con cobertura real por linea. La existencia de columnas o cero datos NO lo certifica.
   Mientras falte esa evidencia, detenerse: NO-GO; no cambiar flags ni rellenar JSON.
4. Coordinar la entrega backend autorizada. No ejecutar SQL de escritura.
5. Antes de abrir trafico, ejecutar 20-postflight.sql: mismos controles y digest de
   consumos sin cambios durante la ventana. Luego certificar los flujos normales en
   el entorno autorizado; esta tarea no autoriza dichos smokes remotos de escritura.

Rollback: detener escritores/confirmaciones del lote y restaurar el artefacto backend
previo revisado. No borrar, invalidar, trasladar ni compensar consumos ya confirmados.
Ejecutar 20-postflight.sql y comparar digest conservado durante la ventana. Un consumo
legitimo posterior cambia el digest y se revisa como actividad, sin forzar el valor previo.
El backend anterior conserva la lectura de source_kind/coverage_status y las claves ya
registradas, pero recupera el defecto antiguo de cuotas: no reabrir nuevas confirmaciones
VIP hasta reconciliar el incidente. No hay rollback de saldos, puntos ni datos.

## F. Dependencias del companero

Contrato requerido, persistido por servidor confiable a partir de lineas canonicas:

```json
{"membership_consumption":{"version":1,"id_suscripcion":"uuid","citas":[{"id_cita":"uuid","servicios":[{"id_servicio":"uuid","line_key":"clave canonica","cantidad":1}]}]}}
```

Origen Cliente: app_private.reserva_idempotencia.response_payload, scope auth:citas:hold.
Origen admin: citas_admin_beneficios_resumen.resumen_beneficios. El consumidor rechaza
fuentes ambiguas, lineas no coincidentes y suscripcion distinta. No aceptar ese objeto
desde el cliente ni fabricar evidencia para reservas historicas.

Productores QA: bookingCanonicalReservationService (construccion/carga/finalizacion),
ruta de hold de citas (persistencia) y booking/adminBookingService (resumen). Esos archivos
y hunks de reservas/checkout quedan fuera de este PR. El unico hunk de citas incluido es
la propagacion financiera del error; no incorpora los productores ni cambia reservas.
No se modifica PR #111/#93/#125, ni se envia mensaje al companero.

## G. Decision y paridad

| Parte | Codigo del candidato | SQL actual PROD | Certificacion |
| --- | --- | --- | --- |
| Consumidor exacto por linea | Preparado selectivamente | Esquema/indices presentes | PG17 y regresiones backend |
| Cuotas, vigencia, sucursal y cliente | Preparado; selector adaptado a main | Sin cambios | PG17 sintetico |
| Cancelaciones e historial | Preservados | Sin saneamiento | PG17 + lecturas Cliente existentes |
| Productor de evidencia canonica | No incluido | Sin evidencia version1 observada | SKIP E2E, dependencia del companero |
| Checkout, Hosted y simulacion | Excluidos | Sin cambios | No certificados por este lote |

PR independiente preparado para revision. NO-GO operativo hasta integrar y certificar
el productor necesario; no existe un paso SQL que pueda sustituir esa dependencia.
