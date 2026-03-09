# MASTERFADE - Auth Decision (Fase 0)

> AM: Estado: esta decision fue ejecutada en Fase 1. Ver [auth-phase1-rfc.md](/c:/Users/fpine/Documents/MasterFade/MF1/masterfadebackend/docs/auth-phase1-rfc.md).

## Objetivo de este documento
Dejar una decision tecnica clara y accionable para la siguiente fase de autenticacion, sin ejecutar aun el refactor grande.

## Evidencia actual (codigo real)
1. `POST /v1/auth/login` tiene dos caminos distintos en [src/routes/v1/auth.js](/c:/Users/fpine/Documents/MasterFade/MF1/masterfadebackend/src/routes/v1/auth.js):
- Si el identificador parece email, valida contra Supabase (`app.supabase.auth.signInWithPassword`).
- Si no es email, valida contra PostgreSQL (`public.fn_login_usuario`) y `public.usuarios.password_hash`.
2. `GET /v1/auth/me` usa APP JWT + claims de `public.usuarios` y `public.roles_usuarios` (no usa sesion Supabase directa).
3. Recuperacion de password:
- Backend `POST /v1/auth/forgot-password` dispara `supabase.auth.resetPasswordForEmail`.
- Frontend `/reset-password` ejecuta `supabase.auth.updateUser({ password })`.
4. Estado BD observado en Fase 0:
- `auth.users`: password presente para los usuarios observados.
- `public.usuarios.password_hash`: solo parte de los usuarios tiene hash local.

## Problema real
Hay doble fuente de verdad de contrasena:
- Supabase Auth (`auth.users.encrypted_password`), y
- Hash local (`public.usuarios.password_hash`) usado por `fn_login_usuario`.

Esto permite estados incoherentes: un usuario puede cambiar password en Supabase y seguir desfasado para login local por username.

## Riesgo real
1. Inicios de sesion inconsistentes segun el identificador ingresado (email vs username).
2. Soporte/operacion dificil por errores intermitentes de credenciales.
3. Mayor superficie de seguridad y mantenimiento (dos flujos de password).

## Decision recomendada para Fase 1 (Auth Unification)
Adoptar **Supabase Auth como unica fuente de verdad para password** y conservar el APP JWT para autorizacion interna.

### Lineamientos
1. Mantener APP JWT para roles/claims internos.
2. Retirar dependencia operativa de `public.usuarios.password_hash` para autenticacion interactiva.
3. Conservar `public.usuarios` como identidad de dominio (roles, scopes, relacion con personas/clientes/empleados).
4. Definir estrategia de login por username:
- Opcion A: mapear username -> email y autenticar siempre via Supabase.
- Opcion B: deprecacion gradual de login por username.
5. Mantener recovery/reset centralizado en Supabase.

## Alcance de archivos para la siguiente fase (no ejecutado en Fase 0)
- Backend:
  - [auth.js](/c:/Users/fpine/Documents/MasterFade/MF1/masterfadebackend/src/routes/v1/auth.js)
  - [authClaims.js](/c:/Users/fpine/Documents/MasterFade/MF1/masterfadebackend/src/utils/authClaims.js)
  - potencialmente funciones SQL de login en DB (`fn_login_usuario`) para deprecacion o adaptacion.
- Frontend:
  - [AuthContext.jsx](/c:/Users/fpine/Documents/MasterFade/MF1/masterfadefrontend/src/context/AuthContext.jsx)
  - [LoginPage.jsx](/c:/Users/fpine/Documents/MasterFade/MF1/masterfadefrontend/src/features/auth/pages/LoginPage.jsx)
  - [ResetPasswordPage.jsx](/c:/Users/fpine/Documents/MasterFade/MF1/masterfadefrontend/src/features/auth/pages/ResetPasswordPage.jsx)

## Cambios de Fase 0 relacionados a auth
- No se hizo refactor de autenticacion.
- Solo se dejo este documento de decision para ejecutar una unificacion controlada en la siguiente fase.
