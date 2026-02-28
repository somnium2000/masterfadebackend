# Auth Exchange Flow - Dual Authentication Strategy

> **Status:** Draft
> **Last updated:** 2026-02-25
> **Stack:** Fastify 5 / Node.js (ESM) / Supabase Auth / jsonwebtoken

---

## Context

Master Fade is a barbershop appointment scheduling application. It supports two categories of users:

- **Clients** sign in through social login (Google, Facebook, Apple) handled by **Supabase Auth** on the frontend. Supabase manages the identity provider handshake and issues its own JWT (the "Supabase token").
- **Staff and admins** sign in with a traditional username + password form that hits the backend directly.

The backend (Fastify/Node.js) does **not** rely on the Supabase JWT for authorization. Instead, it issues its own **APP JWT** that carries internal roles, branch associations, and user identifiers. This separation exists for three reasons:

1. **Role authority** -- Supabase tokens carry `app_metadata.role` which defaults to `authenticated`. Master Fade needs granular roles (`cliente`, `barbero`, `admin`, `super_admin`) that are managed in its own `public.usuarios` table.
2. **Token collision avoidance** -- Both Supabase and the backend produce JWTs. Without clear boundaries, middleware could misinterpret one token for the other.
3. **Backend autonomy** -- The APP JWT is signed with a secret the backend fully controls (`JWT_SECRET`), independent of Supabase's JWT secret. This means the backend can rotate keys, change expiration policies, and add custom claims without coordinating with Supabase.

The bridge between the two worlds is the **auth exchange endpoint**: the frontend trades a valid Supabase token for an APP JWT.

---

## 1. Auth Exchange Flow (`POST /v1/auth/exchange`)

### Step-by-step

1. The user taps "Sign in with Google" (or Facebook/Apple) in the frontend.
2. Supabase Auth completes the OAuth flow and returns a session containing an `access_token` (the Supabase JWT).
3. The frontend sends a `POST /v1/auth/exchange` request with the Supabase token in the body or Authorization header.
4. The backend calls `supabase.auth.getUser(token)` using the **service-role client** (`app.supabaseAdmin`) to verify the token and retrieve the authenticated identity. This call validates the token signature against Supabase's secret server-side; no local JWKS is needed.
5. The backend looks up the user in `public.usuarios` by matching the `auth_uid` column to the Supabase user's `id`.
6. **First-time flow:** If no matching `auth_uid` is found, the backend creates the required records inside a database transaction:
   - Insert into `public.personas` (name, email, phone from Supabase user metadata).
   - Insert into `public.usuarios` (linking `persona_id` and `auth_uid`, assigning default role `cliente`).
   - Insert into `public.clientes` (linking `usuario_id`, setting default preferences).
7. The backend builds the APP JWT payload with internal claims (see section 2) and signs it with `JWT_SECRET`.
8. The APP JWT is returned to the frontend. If the client is a browser, it is also set as an httpOnly cookie (see section 5).

### Sequence diagram

```
Frontend              Supabase Auth           Backend (Fastify)           Database
   |                       |                        |                        |
   |-- OAuth redirect ---->|                        |                        |
   |                       |-- Provider handshake ->|                        |
   |                       |<- Identity confirmed --|                        |
   |<-- session (access_token) ----|                |                        |
   |                       |                        |                        |
   |-- POST /v1/auth/exchange -------------------->|                        |
   |   { supabase_token }  |                        |                        |
   |                       |                        |                        |
   |                       |<- getUser(token) ------|                        |
   |                       |-- { user.id, email } ->|                        |
   |                       |                        |                        |
   |                       |                        |-- SELECT FROM usuarios |
   |                       |                        |   WHERE auth_uid = ?   |
   |                       |                        |<-- row or NULL --------|
   |                       |                        |                        |
   |                       |                     [if NULL]                   |
   |                       |                        |-- BEGIN               |
   |                       |                        |   INSERT personas     |
   |                       |                        |   INSERT usuarios     |
   |                       |                        |   INSERT clientes     |
   |                       |                        |-- COMMIT ------------>|
   |                       |                        |                        |
   |                       |                        |-- sign APP JWT         |
   |                       |                        |                        |
   |<----------- 200 { token, user } --------------|                        |
   |          + Set-Cookie: mf_token=<APP JWT>      |                        |
```

### Request / response shape

**Request:**

```
POST /v1/auth/exchange
Content-Type: application/json

{
  "supabase_token": "<Supabase access_token>"
}
```

Alternatively, the Supabase token can be sent via header:

```
Authorization: Bearer <Supabase access_token>
```

**Response (200):**

```json
{
  "ok": true,
  "data": {
    "token": "<APP JWT>",
    "user": {
      "id_usuario": "uuid",
      "nombre_usuario": "...",
      "roles": ["cliente"],
      "branch_ids": []
    }
  },
  "requestId": "req-abc123"
}
```

**Error responses:**

| Status | Code | Cause |
|--------|------|-------|
| 400 | `AUTH_MISSING_TOKEN` | No Supabase token provided |
| 401 | `AUTH_SUPABASE_INVALID` | `getUser()` rejected the token |
| 500 | `AUTH_EXCHANGE_ERROR` | Database or signing failure |

---

## 2. APP JWT Claims (Anti-collision with Supabase)

A Supabase JWT contains these standard and custom claims:

| Claim | Supabase usage |
|-------|---------------|
| `sub` | Supabase user UUID |
| `email` | User email |
| `phone` | User phone |
| `role` | Always `"authenticated"` |
| `iss` | `https://<project>.supabase.co/auth/v1` |
| `aud` | `"authenticated"` |
| `app_metadata` | Provider info, Supabase-managed roles |
| `user_metadata` | Profile fields from the OAuth provider |

The APP JWT uses a different issuer, audience, and namespaced claims to avoid any overlap:

### APP JWT structure

```json
{
  "sub": "<id_usuario UUID>",
  "iat": 1740000000,
  "exp": 1740043200,
  "iss": "masterfade-api",
  "aud": "masterfade-app",
  "token_type": "app",

  "mf:user_id": "<id_usuario UUID>",
  "mf:persona_id": "<id_persona UUID>",
  "mf:roles": ["cliente"],
  "mf:branch_ids": ["uuid-branch-1"]
}
```

### Claim details

| Claim | Type | Description |
|-------|------|-------------|
| `sub` | `string (uuid)` | Primary key from `public.usuarios`. Same value as `mf:user_id` for JWT spec compliance. |
| `iss` | `string` | Always `"masterfade-api"`. Distinguishes from Supabase where `iss` contains a supabase.co URL. |
| `aud` | `string` | Always `"masterfade-app"`. Supabase uses `"authenticated"`. |
| `token_type` | `string` | Always `"app"`. Quick discriminator without parsing `iss`. |
| `mf:roles` | `string[]` | Application roles: `cliente`, `barbero`, `admin`, `super_admin`. |
| `mf:user_id` | `string (uuid)` | Explicit reference to `usuarios.id_usuario`. |
| `mf:persona_id` | `string (uuid)` | Reference to `personas.id_persona`. Useful for profile lookups. |
| `mf:branch_ids` | `string[] (uuid[])` | Branches the user is associated with. Empty for clients; populated for barbers and admins. |

### Why the `mf:` prefix

The prefix `mf:` (Master Fade) acts as a namespace. Any claim starting with `mf:` is guaranteed to be application-specific because Supabase never emits claims with that prefix. This makes it safe for middleware to trust the presence of `mf:roles` as proof that the token originated from the backend, and it prevents future Supabase claim additions from colliding with application data.

### Signing configuration

```js
jwt.sign(payload, process.env.JWT_SECRET, {
  expiresIn: process.env.JWT_EXPIRES_IN || "12h",
  issuer:    process.env.APP_JWT_ISSUER  || "masterfade-api",
  audience:  process.env.APP_JWT_AUDIENCE || "masterfade-app",
});
```

The `JWT_SECRET` must be a strong random string (minimum 256 bits). It is completely independent from Supabase's JWT secret.

---

## 3. Middleware: `verifyAppJwt`

This Fastify hook runs before route handlers on protected endpoints. It extracts, verifies, and decodes the APP JWT, then decorates `request.user` with the claims.

### Pseudo-code

```js
import jwt from "jsonwebtoken";

async function verifyAppJwt(request, reply) {
  // 1. Extract token: prefer httpOnly cookie, fall back to Authorization header
  let token = request.cookies?.mf_token || null;

  if (!token) {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }

  if (!token) {
    return reply.code(401).send({
      ok: false,
      error: {
        code: "AUTH_TOKEN_MISSING",
        message: "No authentication token provided",
      },
    });
  }

  // 2. Verify signature, issuer, audience, and expiration
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer:   process.env.APP_JWT_ISSUER  || "masterfade-api",
      audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
    });

    // 3. Extra guard: confirm this is an APP token, not a Supabase token
    if (decoded.token_type !== "app") {
      return reply.code(401).send({
        ok: false,
        error: {
          code: "AUTH_WRONG_TOKEN_TYPE",
          message: "Expected an APP token, received a different token type",
        },
      });
    }

    // 4. Decorate request with decoded claims
    request.user = {
      id:         decoded.sub,
      userId:     decoded["mf:user_id"],
      personaId:  decoded["mf:persona_id"],
      roles:      decoded["mf:roles"]      || [],
      branchIds:  decoded["mf:branch_ids"] || [],
      tokenType:  decoded.token_type,
    };
  } catch (err) {
    const isExpired = err.name === "TokenExpiredError";
    return reply.code(401).send({
      ok: false,
      error: {
        code: isExpired ? "AUTH_TOKEN_EXPIRED" : "AUTH_TOKEN_INVALID",
        message: isExpired
          ? "Token has expired. Please re-authenticate."
          : "Invalid authentication token",
      },
    });
  }
}
```

### Registration pattern

The middleware is registered as a Fastify `preHandler` hook, either globally with exclusions or per-route:

```js
// Option A: Route-level (explicit)
app.get("/v1/appointments", { preHandler: [verifyAppJwt] }, handler);

// Option B: Plugin-level (all routes in a plugin get protection)
app.addHook("preHandler", verifyAppJwt);
```

Routes that require specific roles can chain an additional check:

```js
function requireRole(...allowed) {
  return async (request, reply) => {
    const userRoles = request.user?.roles || [];
    const hasRole = allowed.some((r) => userRoles.includes(r));
    if (!hasRole) {
      return reply.code(403).send({
        ok: false,
        error: {
          code: "AUTH_FORBIDDEN",
          message: `Requires one of: ${allowed.join(", ")}`,
        },
      });
    }
  };
}

// Usage
app.delete(
  "/v1/admin/users/:id",
  { preHandler: [verifyAppJwt, requireRole("admin", "super_admin")] },
  handler
);
```

---

## 4. Token Precedence

When a request carries both a Supabase token and an APP token (for example, the frontend stores both), the backend must apply a clear precedence rule to avoid ambiguity.

### Rule: each endpoint declares which token it expects

| Scenario | Expected token | Behavior |
|----------|---------------|----------|
| `POST /v1/auth/exchange` | **Supabase token** | Backend reads the Supabase token from the body or header. Any APP token present is ignored. The `verifyAppJwt` middleware is **not** registered on this route. |
| `POST /v1/auth/login` | **Neither** (credentials in body) | Username + password are validated against the database. No token middleware runs. Returns an APP JWT. |
| All other `/v1/*` routes | **APP JWT** | The `verifyAppJwt` middleware runs. If a Supabase token is also present, it is ignored entirely. |

### Implementation via route configuration

Each route group opts in to the appropriate auth strategy through Fastify's plugin encapsulation:

```js
// Public routes (no auth middleware)
app.register(authRoutes, { prefix: "/v1/auth" });

// Protected routes (APP JWT required)
app.register(async function protectedRoutes(app) {
  app.addHook("preHandler", verifyAppJwt);

  app.register(appointmentRoutes, { prefix: "/v1/appointments" });
  app.register(userRoutes,        { prefix: "/v1/users" });
  app.register(branchRoutes,      { prefix: "/v1/branches" });
});
```

### Why not inspect both tokens

Allowing the backend to accept either token on the same route would create several problems:

- **Privilege confusion:** A Supabase token carries `role: "authenticated"` but no `mf:roles`. If the backend accepted it on a route expecting `mf:roles`, every user would appear to have no roles, or the middleware would need branching logic that is hard to audit.
- **Signature ambiguity:** The APP JWT is verified with `JWT_SECRET`. The Supabase token is verified by calling Supabase's API. Attempting both on every request doubles the verification cost and adds failure modes.
- **Security surface:** A single clear rule ("this route expects exactly this token type") is easier to reason about and audit than a fallback chain.

---

## 5. Token Storage Decision

### Recommendation: httpOnly cookie for APP JWT

After the exchange or login endpoint returns the APP JWT, the backend sets it as an httpOnly cookie alongside returning it in the JSON body.

### Cookie configuration

```js
reply.setCookie("mf_token", appJwtString, {
  httpOnly: true,
  secure:   process.env.NODE_ENV === "production",
  sameSite: "Lax",
  path:     "/v1",
  maxAge:   60 * 60 * 12,  // 12 hours, matches JWT expiration
});
```

| Property | Value | Reason |
|----------|-------|--------|
| `httpOnly` | `true` | Not accessible via `document.cookie`, eliminating XSS token theft. |
| `secure` | `true` in production | Cookie only sent over HTTPS. Disabled in local dev for convenience. |
| `sameSite` | `Lax` | Cookie sent on same-site requests and top-level navigations. Blocks cross-site POST requests (CSRF mitigation). |
| `path` | `/v1` | Cookie only sent to API routes, not to static assets or other paths. |
| `maxAge` | `43200` (12h) | Matches the JWT's `expiresIn` so the cookie expires at the same time as the token. |

### Pros of httpOnly cookie

- **XSS-safe:** JavaScript cannot read or exfiltrate the token. This is the primary advantage over localStorage or sessionStorage.
- **Automatic attachment:** The browser sends the cookie with every request to `/v1/*` when `credentials: "include"` is set on the frontend fetch call. No manual `Authorization` header management needed.
- **SameSite=Lax:** Provides baseline CSRF protection. Cross-origin POST/PUT/DELETE requests from malicious sites will not include the cookie.

### Cons and mitigations

| Concern | Mitigation |
|---------|------------|
| CSRF on GET endpoints | GET endpoints should never mutate state. All state-changing operations use POST/PUT/DELETE, which `SameSite=Lax` blocks cross-origin. |
| Cookie size limit (~4 KB) | The APP JWT payload is small (under 500 bytes typically). Not a risk. |
| Cookie not sent cross-origin by default | The frontend and backend share the same origin in production, or CORS is configured with `credentials: true`. |

### Fallback for mobile / non-browser clients

Mobile apps (React Native, native iOS/Android) and tools like Postman do not support cookies. For these clients:

- The APP JWT is also returned in the JSON response body (`data.token`).
- The client stores it locally and sends it as `Authorization: Bearer <token>` on subsequent requests.
- The `verifyAppJwt` middleware checks both sources (cookie first, then header), so both flows are supported with the same middleware.

### Frontend integration (browser)

```js
// Exchange call
const res = await fetch("/v1/auth/exchange", {
  method: "POST",
  credentials: "include",     // required for cookies
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ supabase_token: session.access_token }),
});

// Subsequent API calls -- cookie is sent automatically
const appointments = await fetch("/v1/appointments", {
  credentials: "include",
});
```

No need to manually extract or store the token; the browser handles it.

---

## 6. Local Login (Staff / Admin)

The existing `POST /v1/auth/login` endpoint remains for staff members who authenticate with a username and password. This endpoint does not involve Supabase Auth at all.

### Flow

1. Staff member enters username + password on a dedicated login form.
2. Frontend calls `POST /v1/auth/login` with `{ nombre_usuario, contrasena }`.
3. Backend calls the database function `public.fn_login_usuario(username, password)`, which validates credentials (including bcrypt comparison) and returns user data with roles.
4. Backend signs an APP JWT with the same claims structure and signing configuration as the exchange endpoint.
5. The APP JWT is returned in the body and set as an httpOnly cookie.

### Coexistence with social login

Both authentication paths produce the **exact same APP JWT format**. Downstream middleware and route handlers do not need to know or care how the user originally authenticated. The `verifyAppJwt` middleware works identically for both.

| Property | Social Login (Exchange) | Local Login |
|----------|------------------------|-------------|
| Entry point | `POST /v1/auth/exchange` | `POST /v1/auth/login` |
| Identity verification | Supabase `getUser(token)` | `fn_login_usuario(user, pass)` |
| User lookup | `auth_uid` column | `nombre_usuario` column |
| First-time auto-registration | Yes (creates persona + usuario + cliente) | No (staff accounts are pre-created by admins) |
| APP JWT issuer | `masterfade-api` | `masterfade-api` |
| APP JWT claims | Identical structure | Identical structure |
| Token storage | httpOnly cookie + body | httpOnly cookie + body |
| Typical roles | `["cliente"]` | `["barbero"]`, `["admin"]`, `["super_admin"]` |

### Why two endpoints instead of one

- The exchange endpoint requires a valid Supabase token as input, which only exists after a social login. Staff members who do not use social login cannot produce a Supabase token.
- The login endpoint validates credentials against the database directly. Routing social login users through `fn_login_usuario` would require syncing passwords, which defeats the purpose of delegating identity to Supabase.
- Keeping them separate makes each endpoint simple and single-purpose.

---

## Appendix: Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | -- | Signing key for APP JWTs. Must be at least 256 bits. |
| `JWT_EXPIRES_IN` | No | `"12h"` | Token lifetime (ms string or zeit/ms format). |
| `APP_JWT_ISSUER` | No | `"masterfade-api"` | Value for the `iss` claim. |
| `APP_JWT_AUDIENCE` | No | `"masterfade-app"` | Value for the `aud` claim. |
| `SUPABASE_URL` | Yes | -- | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Yes | -- | Supabase anonymous/public key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | -- | Supabase service role key (for `getUser` verification). |
