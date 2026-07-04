# Security hardening - MasterFade backend

## Mandatory env variables
- `JWT_SECRET` (>= 24 chars)
- `COOKIE_SECRET` (>= 24 chars)
- `CSRF_SECRET` (>= 24 chars)
- `FRONTEND_URL`

The app fails at startup if any of these are missing.

## Production constraints
- `PAYMENT_PROVIDER=mock` is blocked in production.
- `FRONTEND_URL` must use HTTPS in production.
- `AUTH_COOKIE_SECURE` must be enabled in production.

## Session model
- Auth now uses HttpOnly cookie: `mf_session`.
- CSRF token cookie: `mf_csrf` (non-HttpOnly) + `X-CSRF-Token` header.
- Frontend sends requests with `credentials: include`.

## Local development origin alignment
- Preferred local frontend origin: `http://localhost:5173`.
- Local backend API origin: `http://localhost:3002`.
- Keep `CORS_ORIGENES` explicit (comma-separated), never use `*`.
- Optional compatibility for local tooling: include `http://127.0.0.1:5173` in development.

## Health endpoints
- Public: `GET /v1/health` and `GET /v1/health/live`.
- Internal: `GET /v1/health/ready` requires `X-Internal-Health-Token`.

## Database TLS
- Default is TLS enabled with `rejectUnauthorized=true`.
- If your infrastructure uses a private CA, set `DB_SSL_CA_BASE64`.
- For local/non-production troubleshooting only, you may override `DB_SSL_REJECT_UNAUTHORIZED=false`.

## Produccion HTTPS / Pooler Supabase
- Build the frontend with `VITE_API_URL=https://api.masterfadeapp.com` and `VITE_APP_URL=https://masterfadeapp.com`.
- Configure backend `FRONTEND_URL=https://masterfadeapp.com`.
- Keep `CORS_ORIGENES` restricted to the public frontend origin; do not use `*`.
- Use secure cookies in staging/production: `AUTH_COOKIE_SECURE=true`.
- Route PostgreSQL traffic through Supabase Pooler: `DB_HOST=aws-1-us-east-1.pooler.supabase.com`, `DB_PORT=5432`, `DB_USER=postgres.pdzsmkjnyazpkoocjbpw`, `DB_POOL_MAX=5`.
- Keep database TLS verified: `DB_SSL=true` and `DB_SSL_REJECT_UNAUTHORIZED=true`.
- `DB_SSL_REJECT_UNAUTHORIZED=false` is prohibited in staging/production.

## Proxy and client IP
- Configure `TRUST_PROXY=true` behind load balancer/CDN.
- Rate limit keys use `request.ip` and route path.

## Webhooks
- Webhook requires `X-Webhook-Timestamp` and enforces replay window (`WEBHOOK_REPLAY_WINDOW_SECONDS`).
- Mock webhook can validate `X-Signature` via `MOCK_WEBHOOK_SECRET`.

## Deployment hygiene
- Use `.dockerignore` and `.gitignore` to exclude logs, zips, `.env`, build artifacts, and VCS metadata.
