# QA-MF118-ACOMPANANTES-UX-PUNTOS-01

## Evidencia y alcance

Auditoría con consultas SELECT de metadatos y regla global en el proyecto identificado como QA; sin escrituras en Supabase ni lectura de datos personales. Los escenarios de navegador usan APIs sintéticas y bloquean cualquier escritura salvo validaciones de contacto y operaciones de sesión. No crean holds, reservas, intenciones ni cargos. La integración PostgreSQL crea y elimina un cluster en loopback.

## Acompañantes y presentación

- La fecha ya se hereda del titular. La carga inicial se comprueba después de seleccionar servicios; no se heredan servicios ni beneficios de forma automática.
- El ID solicitado para enfocar se obtenía mutando una variable dentro del actualizador de React y leyéndola inmediatamente después. Su evaluación diferida dejaba la solicitud vacía. Se deriva el bloque antes de actualizar el estado y se activan/focalizan sus datos conjuntamente.
- El efecto de scroll dependía solo de la fecha; una fecha heredada al cambiar de bloque podía competir con el foco de datos. Ahora solo desplaza a horarios por cambios de fecha dentro del mismo bloque, sin solicitud de foco pendiente.
- En el escenario sintético, el horario coincidente con el titular queda correctamente bloqueado. Los horarios consecutivos cargan al primer intento. No se demostró un defecto adicional de consultas/caché y no se modifica `useBookingAvailability`.
- Se oculta el acceso a la pestaña Promociones, conservando los renderizadores y las evaluaciones de promociones históricas. Servicios/Paquetes tienen estado accesible y selección dorada; las acciones secundarias conservan su función con separación táctil.
- MF-118: el resumen previo al hold calculaba el total pendiente, pero decía «Cubierto completamente por tu plan» al usar cero como fallback de extras. Ahora la indicación usa el total neto ya calculado. No cambian precios, cálculos del backend ni acciones de pago.

## Membresía

La proyección frontend marca cobertura únicamente con `index === 0`. Backend `consumeCoverageForServices` exige `isTitular`. Las pruebas comparan titular cubierto por L300 y acompañante de L300/L450: cobertura L300, saldo consolidado L300/L450, sin consumir beneficios del titular por el acompañante. Las pruebas del resumen también cubren retirar todos los acompañantes (saldo cero). Los valores de PostgreSQL provienen de servicios sintéticos.

## MasterPuntos: política observable, sin cambiarla

- `grantEngagementPointsForConfirmedGroup` intenta insertar al confirmar. La guarda `fn_points_tx_guard_acumular_final` descarta inserciones si la cita no alcanzó el estado final. El resultado probado es cero puntos acreditados al confirmar.
- El trigger de cita `fn_trg_otorgar_puntos_por_cita` reconoce `completada`, usa la regla activa por sucursal/global y no exige pago positivo. Una cita completada cubierta por membresía puede acreditar un punto con la regla sintética de 1 punto/cita.
- «Pendiente» describe aquí una expectativa condicionada a completar la cita: no es una transacción acreditada ni un saldo disponible. Perfil lee `vw_points_balance`, basado en transacciones efectivas; no suma expectativas de citas confirmadas.
- Citas en espera, pendientes, canceladas, expiradas, anuladas o no show no acreditan. Un canje del titular queda excluido. El índice único por cita/tipo impide duplicados al repetir la finalización.
- El trigger acredita al `id_cliente` de cada cita. Un acompañante registrado recibe el punto propio; un acompañante sin Cliente vinculado no acredita al titular al completarse. El intento de acreditación al confirmar no garantiza ese resultado, porque la guarda lo descarta antes del estado final. El texto que prometía puntos por acompañantes pagados se sustituye por el aviso compatible con la regla verificada: se acreditan al completar las citas que califican.
- Decisión pendiente: si se desea premiar al titular por acompañantes sin cuenta, o acreditar antes de finalizar, hace falta una decisión comercial explícita y una revisión coordinada de triggers, servicio y textos. No se implementa esa propuesta.

## Procedencia y límites de SQL

`test/sql/mf118-points-fixture.sql` contiene las definiciones leídas por SELECT en QA el 2026-11-12: estado final, guarda, trigger de cita y vista de saldo efectivo. Se confirmó la regla global activa de 1 punto/cita y umbral 10, los triggers habilitados y el índice único por cita/tipo. El trigger de cita se ejecuta AFTER UPDATE; la antigua función para plan confirmado es un no-op y no está enlazada por un trigger activo.

La vista efectiva descuenta de la suma firmada los remanentes positivos de ciclos activos vencidos, sin escribir transacciones al consultar. Se prueba esa lectura en PostgreSQL aislado. Ciclos y resolución de regla usan fixtures simplificados; no se prueba aquí el proceso completo de materialización de vencimientos. No se instalan triggers financieros ni se ejecutan pasarelas.

No se encontró una causa que justifique alterar el momento de acreditación en backend. Queda pendiente reproducir el caso concreto con cuentas y citas reales mediante validación controlada en QA; esta tarea no modifica esas cuentas ni citas.

## Ejecución

Backend, con binarios PostgreSQL instalados fuera del repositorio:

```powershell
$env:MASTERFADE_PHASE02_PG_BIN='C:\ruta\postgresql\bin'
node --test test/mf118-companions-points.postgres.test.mjs
node --test test/client-points-rewards.qa-mp-client-02.test.mjs test/masterpoints-readonly-expiration.qa-mp-01c.test.mjs
```

Frontend: compilar, servir `dist` mediante Vite preview y ejecutar con Playwright externo (Chromium/WebKit instalados):

```powershell
npm run build
$env:MASTERFADE_PLAYWRIGHT_MODULE='C:\ruta\node_modules\playwright'
$env:MASTERFADE_BROWSER_URL='http://127.0.0.1:4189'
node --test test/companionsMf118.browser.mjs
```

Capturas en `%TEMP%\mf118-evidence`. Emulación móvil de navegador, sin validación de teclado o dispositivo físico.
