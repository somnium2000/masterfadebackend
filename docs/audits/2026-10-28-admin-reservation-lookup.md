# Auditoria final de busqueda administrativa — 2026-10-28

Bases revisadas: backend `70ec425a8197927f57359c70fda43d28c8e29655`, frontend `a27fd85514ef9721dd78495477d64fa701997ce9`.

## Resultado

La version original requiere correccion antes del merge: su expansion recursiva genera 37 filas por grupo y el frontend publico acumula referencias de grupo e individuales. Se prepararon dos correcciones minimas, sin migraciones, cambios financieros ni despliegue.

Cierre definitivo de equivalencia: PASS para reservas nuevas con grupo. El UUID de grupo valido define el unico codigo canonico; un codigo_cita divergente ya no lo sustituye. Historicas sin grupo valido conservan la evidencia explicita, y sin evidencia no se genera un codigo. La aprobacion de integracion/merge sigue pendiente y fuera de esta intervencion.

## Metodo reproducible

PostgreSQL 17.9 aislado, Windows, AMD Ryzen 7 7730U (16 procesadores logicos). Una cita por grupo con UUID determinista md5; indice local de sucursal; ANALYZE despues de cargar cada volumen. No replica la distribucion ni el hardware de Supabase QA.

Cada variante usa dos calentamientos, 20 consultas seriales y cinco lotes de cuatro consultas simultaneas mediante conexiones PostgreSQL independientes (pool max=4). Percentiles nearest-rank. Los tiempos p50/p95 son latencias del cliente local; incluyen conexion/pool si corresponde. EXPLAIN ANALYZE BUFFERS TIMING OFF obtiene tiempos SQL, filas y temporales. JIT deshabilitado en todas las conexiones; work_mem 4 MiB; shared_buffers 128 MiB. No se ejecutaron ambos benchmarks simultaneamente. La carga del sistema puede afectar diferencias entre ejecuciones; no son SLO de produccion.

PowerShell, desde backend:

```powershell
$env:RUN_ADMIN_LOOKUP_BENCHMARK='true'
$env:LOOKUP_BENCHMARK_VARIANT='baseline'
node --test test/admin-reservation-benchmark.postgres.test.mjs
$env:LOOKUP_BENCHMARK_VARIANT='optimized'
node --test test/admin-reservation-benchmark.postgres.test.mjs
$env:RUN_ADMIN_RESERVATION_PG='true'
node --test test/admin-reservation-code.postgres.test.mjs test/admin-reservation-code.test.mjs
```

La variante baseline extrae literalmente el SQL del commit auditado mediante git show. Ambas variantes crean y destruyen su propio cluster local; no aceptan una URL externa de base de datos.

## Mediciones finales (ms)

| Grupos | Original serial p50/p95 | Corregido serial p50/p95 | Original concurrencia 4 p50/p95 | Corregido concurrencia 4 p50/p95 | SQL original/corregido |
|---:|---:|---:|---:|---:|---:|
| 1.000 | 44,29 / 69,06 | 7,41 / 8,18 | 44,12 / 94,31 | 7,46 / 51,71 | 41,04 / 6,77 |
| 10.000 | 273,99 / 296,49 | 57,89 / 59,23 | 368,21 / 562,51 | 58,09 / 61,68 | 266,85 / 56,77 |
| 100.000 | 3657,34 / 4609,34 | 597,85 / 671,27 | 4651,54 / 4990,58 | 956,60 / 1195,67 | 3546,14 / 603,29 |

La primera corrida exploratoria original obtuvo p95 3935,40 ms serial y 7141,32 ms concurrente con 100.000 grupos. La tabla usa la repeticion final con configuracion uniforme de conexiones, no el mejor resultado seleccionado.

## Filas, memoria y temporales

| Grupos | Filas recursive union original | Hashes corregidos (sin recursion) | Pico de operador informado original/corregido (KiB) | Bloques temporales escritos original/corregido |
|---:|---:|---:|---:|---:|
| 1.000 | 37.000 | 1.000 | 129 / 321 | 370 / 0 |
| 10.000 | 370.000 | 10.000 | 913 / 1937 | 3703 / 0 |
| 100.000 | 3.700.000 | 100.000 | 7185 / 8241 | 74073 / 3024 |

Bloques de 8 KiB: a 100.000 grupos, escritura temporal 578,70 MiB -> 23,63 MiB; lectura temporal 37037 -> 814 bloques. La correccion elimina las tuplas recursivas, pero no elimina todos los temporales ni reduce necesariamente el pico de cada operador.

Memoria Windows: el benchmark registra WorkingSet64 y PrivateMemorySize64 por backend tras cada volumen. A 100.000 grupos: original RSS 184.717.312–185.782.272 bytes, privados 4.882.432–6.479.872; corregido RSS 185.073.664–187.797.504 bytes, privados 5.394.432–6.737.920. Son instantaneas posteriores, NO picos globales. RSS incluye paginas compartidas: no sumar procesos para estimar RAM total. El pico EXPLAIN corresponde al mayor operador que informa Peak Memory Usage; no incluye todos los tuplestores/CTEs. No se demuestra reduccion de RAM total ni ausencia de picos transitorios.

## Correccion SQL

Expresion polinomica equivalente al hash int32 para UUID de 36 caracteres, con coeficientes constantes calculados modulo 2^32. Dos CTE materializados evitan reevaluacion y expansion de 37 filas. Se conserva conversion signed int32, abs y modulo 36^5. Input del usuario sigue parametrizado. Se mantienen todas las colisiones y los limites de 20 grupos/400 citas; nunca se trunca silenciosamente una reserva mayor. Sigue siendo O(N) sobre grupos autorizados: aceptable para la escala y concurrencia ensayadas, no demostracion de capacidad ilimitada. No se requiere migracion para esta correccion.

## Equivalencia y prioridad

- Publica pagada: el endpoint de estado devuelve id_grupo_cita; el correo calcula buildBookingShortCode(id_grupo_cita,5). El fallback publico y Administracion usan ese mismo grupo.
- Autenticada y membresia: confirmar-sin-pago entrega codigo_cita del grupo y citas_confirmadas con codigos individuales. La interfaz anterior concatenaba ambos tipos: defecto de presentacion verificado con prueba que fallaba antes de corregirlo.
- Correccion definitiva: con UUID de grupo valido, la referencia canonica SIEMPRE es buildBookingShortCode(id_grupo_cita,5), incluso si codigo_cita explicito es diferente. Solo sin grupo valido se conserva el codigo explicito historico antes de considerar listas individuales. No cambiar montos, confirmacion ni navegacion.
- Multiples integrantes: una referencia de grupo, estados y acciones independientes por id_cita.
- Historicas con grupo y contrato estandar: derivacion estable, independiente de fecha y estado. La integracion PostgreSQL devuelve citas completadas y confirmadas juntas.
- Limite historico: no hay evidencia durable del texto mostrado en todas las sesiones antiguas. Sin grupo valido, una referencia explicita antigua o individual se conserva; no se puede prometer que sea localizable por la busqueda de grupos. No se inventa un grupo ni se agregan aliases, persistencia o migraciones. Para reservas nuevas con grupo, el UUID prevalece sobre codigo_cita divergente conforme al contrato canonico aprobado.

### Evidencia del cierre canonico

Caso de regresion: grupo `11111111-2222-4333-8444-555555555555` -> `S64WZ`; API explicita `API01`/`OTRO1` no sustituye ese codigo. Dos pruebas de render fallaron antes del cambio y pasan despues. Render conjunto de confirmacion real y tarjeta administrativa real verifica ambas referencias `S64WZ` y ausencia de codigos individuales de los integrantes.

Los helpers reales de correo pagado y de membresia se ejecutan en VM con transporte/DB de notificaciones simulados: asunto, texto y HTML usan S64WZ para padre e hijo, sin enviar mensajes. Sus funciones se leen directamente del codigo productivo; no se modifican los modulos de pagos. PostgreSQL 17 verifica que el algoritmo optimizado encuentra el grupo a partir de ese mismo codigo del correo. Casos sin grupo valido conservan el codigo historico, sin generar nuevas referencias.

## Seguridad y alcance contractual

Endpoint NUEVO: GET /v1/admin/citas/reservas/buscar?codigo=GOXBD&id_sucursal=<uuid opcional>. Es ampliacion del contrato backend y requiere aprobacion del auditor/release antes de merge, aunque su implementacion ya fue autorizada. Roles existentes admin/super_admin/barbero; sucursal y empleado limitados en ambas consultas. El codigo corto no es unico, secreto, token de acceso ni identificador de escritura.

Prueba real PostgreSQL via app.inject: grupos con colision permanecen separados; filas del mismo grupo en sucursal ajena excluidas; barbero no recibe filas de otro empleado; citas historicas incluidas. El wrapper de DB rechaza cualquier SQL que no empiece por SELECT/WITH; snapshot de citas sin cambios y cero payment_intents antes/despues. Pruebas HTTP 401/403/400, sucursal ajena y barbero sin perfil. Las transiciones siguen por id_cita sin modificaciones en rutas de escritura.

No se realizaron escrituras QA/produccion, Sale/Status, merge ni despliegue. La autorizacion del contrato y la limitacion de referencias historicas deben constar en la decision de merge.
