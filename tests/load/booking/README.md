# Fase 4 booking load harness

Harness local para auditar carga, resiliencia y contratos de agendamiento contra QA sin agregar dependencias productivas.

## Perfiles

- `SMOKE`: una pasada corta.
- `BASELINE`: concurrencia baja para línea base.
- `LOAD`: carga sostenida moderada.
- `TARGET`: objetivo de capacidad.
- `SPIKE`: ráfaga de estrés.

## Ejecución

```powershell
$env:MF_LOAD_PROFILE="SMOKE"
$env:MF_LOAD_API_URL="https://api-qa.masterfadeapp.com"
node tests/load/booking/booking-load.mjs
```

Para `BASELINE`:

```powershell
$env:MF_LOAD_PROFILE="BASELINE"
node tests/load/booking/booking-load.mjs
```

## Variables principales

- `MF_LOAD_API_URL`: API objetivo. Default: `https://api-qa.masterfadeapp.com`.
- `MF_LOAD_PROFILE`: `SMOKE`, `BASELINE`, `LOAD`, `TARGET` o `SPIKE`.
- `MF_LOAD_BRANCH_ID`: sucursal fija. Si falta, usa la primera sucursal pública activa.
- `MF_LOAD_SERVICE_ID`: servicio fijo. Si falta, intenta descubrirlo desde catálogo público.
- `MF_LOAD_BARBER_ID`: barbero fijo opcional.
- `MF_LOAD_DATE_FROM`, `MF_LOAD_DATE_TO`, `MF_LOAD_SLOT_DATE`: rango operativo.
- `MF_LOAD_SCENARIOS`: lista separada por coma para ejecutar subconjunto.
- `MF_LOAD_ENABLE_WRITES`: debe ser `true` para crear/liberar holds.
- `MF_LOAD_CLIENT_COOKIE` o `MF_LOAD_CLIENT_BEARER`: credenciales QA cliente para escenarios autenticados.
- `MF_LOAD_ADMIN_COOKIE` o `MF_LOAD_ADMIN_BEARER`: credenciales QA admin para escenarios administrativos.

## Escenarios cubiertos

- Disponibilidad pública.
- Disponibilidad autenticada cuando hay credenciales cliente.
- Crear/liberar hold público, autenticado y admin cuando `MF_LOAD_ENABLE_WRITES=true`.
- Doble submit con mismo `x-idempotency-key`.
- Concurrencia sobre el mismo slot.
- SSE concurrente.
- Reconexión SSE con `last_event_id`.
- Fallback polling mediante disponibilidad y horarios.
- Búsqueda admin de clientes cuando hay credenciales admin.
- Confirmación admin con efectivo pendiente queda marcada como escenario que requiere credenciales/slot descartable explícito.

Por defecto el harness es no destructivo: los escenarios de escritura se saltan si `MF_LOAD_ENABLE_WRITES` no está habilitado.
