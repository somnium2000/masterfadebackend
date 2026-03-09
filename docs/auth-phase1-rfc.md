# AUTH Phase 1 RFC - Single Password Source of Truth

Date: 2026-03-08  
Scope: MasterFade backend + frontend auth flow (no new business modules)

## 1) Problem statement

The auth flow had two credential paths in `POST /v1/auth/login`:

1. Email path -> `supabase.auth.signInWithPassword`
2. Non-email path -> `public.fn_login_usuario` using `public.usuarios.password_hash`

This created a dual source of truth for passwords and an unstable identifier path (`personas.nombres`), which is not production-safe.

## 2) Current evidence (audited)

Read-only SQL checks on the active database showed:

- `public.usuarios` columns: `id_usuario`, `id_persona`, `estado`, `created_at`, `updated_at`, `deleted_at`, `password_hash`.
- There is no formal `nombre_usuario` column in `public.usuarios`.
- `public.fn_login_usuario(p_username text, p_password text)` exists and uses:
  - `public.usuarios.password_hash`
  - `lower(trim(p.nombres))` as login fallback
- Active users: 4
- Active users with local `password_hash`: 1
- Active users linked to `auth.users`: 4
- `auth.users` rows with email + encrypted password: 4

Conclusion: Supabase already has complete credentials, while local password hash coverage is partial.

## 3) Target state (Phase 1)

- Password verification source of truth: **Supabase Auth only**.
- `public.usuarios`: profile/authorization/audit metadata only.
- Login identifier for this phase: **email**.
- Backend APP JWT remains operational token for API authz (`/v1/auth/me`, role guards).

## 4) Decisions

1. `POST /v1/auth/login` authenticates only against Supabase credentials.
2. Backend validates internal profile existence (`public.usuarios` active via claims query) before issuing APP JWT.
3. Temporary input compatibility:
   - API accepts `identifier`, `email`, `nombre_usuario`, `username` fields.
   - All map to one value, but Phase 1 requires that value to be a valid email.
4. No destructive DB changes in this phase.

## 5) Alternatives considered

### A) Keep dual path (`fn_login_usuario` + Supabase)
Rejected: keeps contradictory password stores and unstable login semantics.

### B) Add username column now and support email+username in Phase 1
Deferred: requires migration, backfill, uniqueness conflict handling, and UX updates not required for current operational phase (SUPER_ADMIN-first).

## 6) Risks

- Users still typing non-email identifiers will fail login.
  - Mitigation: frontend login now explicitly requests email and validates before submit.
- Supabase-authenticated user without active internal profile.
  - Mitigation: backend blocks APP JWT issuance with explicit `AUTH_USER_NOT_ONBOARDED`.

## 7) Files changed in this phase

- `src/routes/v1/auth.js`
- `masterfadefrontend/src/context/AuthContext.jsx`
- `masterfadefrontend/src/features/auth/pages/LoginPage.jsx`

## 8) DB changes and migration

- Mandatory migration: none.
- Optional future migration (Phase 2 only, if business requires username login):
  - Add `public.usuarios.login_identifier` unique, lowercase normalized.
  - Backfill from approved source.
  - Add backend resolver `identifier -> auth.users.email`.

## 9) Rollback

1. Revert `src/routes/v1/auth.js` to previous login logic.
2. Revert frontend `AuthContext` and `LoginPage` identifier behavior.
3. No DB rollback needed (no schema/data mutations in Phase 1).
