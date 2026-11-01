# Artillery local booking load

Prueba exclusivamente `http://127.0.0.1:3102`. Cada VU consulta catálogo,
barberos y disponibilidad, crea un hold sintético y lo libera. Health no forma
parte de las métricas funcionales. El perfil objetivo crea exactamente 50 VU,
los limita a 50 y mantiene cada sesión al menos 300 segundos.

```powershell
npm run load:local:1
npm run load:local:25
npm run load:local:50
```

La protección del mismo horario se comprueba aparte para conservar los 409
esperados fuera de los percentiles funcionales:

```powershell
node tests/load/artillery/conflict-probe.mjs tests/load/artillery/reports/conflicts-50.json 20
node tests/load/artillery/rate-limit-probe.mjs tests/load/artillery/reports/rate-limit-original.json 210
```

El backend local debe usar PostgreSQL 17 aislado, SMTP/Supabase remotos
deshabilitados, `PAYMENT_PROVIDER=mock`, y límites locales suficientes para que
el ensayo mida la aplicación en vez del rate limiter. El probe del límite debe
ejecutarse con la configuración original (200 solicitudes/minuto); los perfiles
de capacidad usan únicamente el ajuste local elevado. No usar contra QA o
producción.
