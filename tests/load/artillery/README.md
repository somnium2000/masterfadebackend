# Artillery local booking load

Prueba exclusivamente `http://127.0.0.1:3102`. Cada VU crea un hold con datos
sintéticos y después mantiene actividad con health/contexto. El perfil de 25 VU
dura cinco minutos; 1, 5 y 10 VU duran 30 segundos.

```powershell
npm run load:local:1
npm run load:local:5
npm run load:local:10
npm run load:local:25
```

El backend local debe usar PostgreSQL 17 aislado, SMTP/Supabase remotos
deshabilitados, `PAYMENT_PROVIDER=mock`, y límites locales suficientes para que
el ensayo mida la aplicación en vez del rate limiter. No usar contra QA o producción.
