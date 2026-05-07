# Personas Phase 1 RFC

Date: 2026-03-08  
Scope: Super admin operational module for domain Personas.

## Current state

- The backend had only `GET /v1/admin/empleados` for people-related admin data.
- `clientes` and `usuarios` pages in frontend were placeholders.
- Auth is already unified: password source of truth is Supabase Auth.

## Target state

- Operational personas module for SUPER_ADMIN:
  - list base personas,
  - list internal users,
  - list clients,
  - catalogs (roles and branches),
  - create internal user with domain provisioning.

## Modeling decisions

- `public.personas`: base identity entity.
- `auth.users`: credential identity.
- `public.usuarios`: internal authz profile linked 1:1 to `auth.users.id`.
- `public.roles_usuarios`: role/scope assignments.
- `public.empleados` and `public.clientes`: optional specializations of a persona.
- `public.correos`: principal contact email for persona.

## Explicit out of scope

- No local password.
- No fine-grained permission system.
- No changes to payments/agenda/points/memberships.
- No module implementation for Servicios/Configuracion.

## Migrations

- Mandatory: none.
- Existing schema supports the Phase 1 personas workflow.

## Risks and mitigation

- Partial failure after creating `auth.users` and before DB commit.
  - Mitigation: compensating delete in Supabase admin API.
- Inconsistent role/scope payloads.
  - Mitigation: strict backend validations and role/sucursal checks.

## Rollback

1. Revert route registration in `src/routes/v1/admin/index.js`.
2. Revert `src/routes/v1/admin/personas.js`.
3. Revert frontend personas pages/API wiring.
