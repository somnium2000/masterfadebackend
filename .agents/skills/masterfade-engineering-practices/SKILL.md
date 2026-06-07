---
name: masterfade-engineering-practices
description: "Use when writing, modifying, refactoring, testing, or reviewing code in the MasterFade frontend or backend repositories. Applies senior engineering practices to Vite React frontend work, Fastify backend endpoints, booking, payments, auth, memberships, promotions, reports, admin, client, barber, public flows, API integration, validation, error handling, loading and empty states, security checks, QA prep, and production-ready small safe patches."
---

# MasterFade Engineering Practices

## Purpose

Use this skill to work in the MasterFade frontend and backend repositories with consistent engineering discipline. Make small, safe, maintainable, verifiable changes that respect the current architecture.

Target repositories:

- Frontend: `somnium2000/masterfadefrontend`
- Backend: `somnium2000/masterfadebackend`

MasterFade is a web application for barber shop operations, public booking, authenticated client booking, memberships, promotions, payments, reports, security and admin modules, and role-based dashboards.

## Scope Limits

Do not use this skill for non-MasterFade tasks, academic writing, standalone UI mockups, or quick conceptual answers that do not need repository-specific work.

Do not perform a full architectural rewrite unless the user explicitly requests it. Do not refactor unrelated code because it looks imperfect.

## Project Context

Frontend characteristics:

- Vite + React.
- JavaScript and JSX.
- React Router.
- Feature-based organization under `src/features`.
- Shared UI/components under `src/components`.
- Shared contexts under `src/context`.
- API access centralized in `src/services/httpClient.js`.
- Public booking flow under `src/features/public/booking`.
- Routes centralized in `src/App.jsx`.

Backend characteristics:

- Node.js with Fastify.
- JavaScript ES Modules.
- PostgreSQL/Supabase through `pg` and the Supabase client.
- Plugin-based app composition.
- Versioned routes under `src/routes/v1`.
- Business services under `src/services`.
- Shared utilities under `src/utils`.
- Fastify JSON Schema validation.
- Security through CORS, Helmet, rate limits, cookies, CSRF, auth plugins, and environment validation.

## Before Coding

Before editing code:

1. Identify the exact feature, route, component, hook, service, or utility involved.
2. Read the existing files before proposing or applying changes.
3. Identify frontend-backend contract impact.
4. Check whether a similar pattern already exists.
5. Confirm the current language; use JavaScript/JSX unless the touched file already uses TypeScript.
6. Check available scripts in `package.json`.
7. Identify security, permission, data integrity, and regression risks.
8. Prefer a minimal implementation plan.
9. Avoid adding dependencies unless clearly justified.
10. State assumptions when something cannot be inspected.

## Core Principles

Apply these rules:

- Prefer clarity over cleverness.
- Prefer small changes over large rewrites.
- Prefer explicit names over abbreviations.
- Prefer existing patterns over new abstractions.
- Prefer a boring, reliable solution over a complex flexible one.
- Keep backend as the source of truth for permissions, availability, totals, discounts, holds, payments, and final validation.
- Let frontend prevalidate for UX, but make it handle backend rejection safely.
- Avoid duplicating business rules across frontend and backend.
- Leave code easier to understand than it was found.
- Refactor only when it reduces risk or enables the requested change.

## Frontend Rules

Respect these confirmed patterns:

- Use `src/services/httpClient.js` for API requests.
- Use feature API wrappers near the feature, such as `src/features/public/booking/publicBookingApi.js`.
- Keep pages inside `src/features/<feature>/pages`.
- Keep feature-specific flow components inside their feature folder.
- Keep shared UI components inside `src/components`.
- Keep route protection through existing route and auth patterns.
- Keep visible text in Spanish unless the existing module uses another convention.
- Keep design consistent with existing cards, buttons, dialogs, badges, forms, toasts, layouts, and responsive behavior.
- Use existing contexts instead of creating global state unnecessarily.
- Do not use raw `fetch` unless justified by nearby code.
- Keep UI components focused on rendering and user interaction.
- Move reusable domain logic into utility files or hooks.
- Handle loading, error, empty, success, and disabled states when the UI surface needs them.
- Avoid duplicate toasts for the same error.
- Avoid technical error messages in user-facing UI.
- Preserve role-based visibility.
- Use `AbortController` or existing abort patterns for requests that can outlive the screen.
- Keep public booking flows especially stable.

## Backend Rules

The backend currently uses Fastify. Do not introduce Express patterns unless the touched area already contains Express code.

Respect these confirmed patterns:

- Build the app through `src/app.js` using Fastify plugins.
- Register API routes through `src/routes/v1/index.js`.
- Use route prefixes such as `/v1/auth`, `/v1/public`, `/v1/citas`, `/v1/pagos`, and `/v1/admin`.
- Use `fastify-plugin` for plugins.
- Use `app.db` for database access.
- Use `AppError`, `sendOk`, and `sendError` where nearby code uses them.
- Use JSON Schema for request and response validation in routes.
- Keep sensitive logic in services when practical.
- Keep public and private routes clearly separated.
- Use transactions for multi-step writes.
- Always release database clients in `finally`.
- Prefer parameterized SQL.
- Do not concatenate untrusted values into SQL.
- Keep route handlers thin when practical.
- Keep mappers and normalizers near the route only if small; move them out when they grow.
- For public routes, sanitize error details aggressively.
- For payment routes, require idempotency, provider event uniqueness, and explicit environment guards.
- Never let mock payment helpers run in production, staging, QA, or public HTTPS contexts unless explicitly authorized by secure configuration.

Use status codes intentionally:

- `400`: invalid input.
- `401`: unauthenticated.
- `403`: authenticated but forbidden.
- `404`: not found.
- `409`: business conflict.
- `422`: semantically invalid operation, when already used nearby.
- `429`: rate limit.
- `500`: unexpected server error only.

Avoid leaking raw SQL errors, stack traces, internal configuration, secrets, or provider details.

## API Contract Rules

Check both frontend and backend when changing an API.

- Keep backend response shapes compatible with frontend expectations.
- Consume `ok`, `data`, `error.code`, `error.message`, and `requestId` consistently when that contract is present.
- Do not rename response fields without updating all consumers.
- Do not add required backend fields without updating frontend payload builders.
- Do not change endpoint method, path, or auth requirement without tracing usage.
- Use `/v1/...` paths consistently.
- Add or update the frontend API wrapper when adding an endpoint.
- Verify that `httpClient` supports any wrapper method you use.
- Do not duplicate complex price, promotion, hold, availability, membership, reward, payment, or permission logic in the frontend as final truth.

## Refactoring Rules

Refactor only when it is needed to implement the requested change safely, reduce duplication in touched code, lower complexity in a critical area, improve testability or verification, or remove a proven bug or risk.

Constraints:

- Keep changes small.
- Do not combine unrelated refactors with feature work.
- Preserve behavior unless the user requested a behavior change.
- Prefer extracting a function over rewriting a file.
- Prefer an adapter or wrapper over changing many call sites.
- In large files, extract one responsibility at a time.
- Keep public contracts stable.
- Explain the risk reduced by the refactor.

## Legacy Code Rules

When working with risky or legacy code:

- Read the code first.
- Identify current behavior before changing it.
- Add characterization checks when feasible.
- Avoid broad rewrites.
- Change one responsibility at a time.
- Wrap unsafe logic before replacing it.
- Preserve compatibility with old payloads if the route already supports them.
- Keep fallbacks only when still needed.
- Mark risky assumptions in the final response.

## Code Review Checklist

When reviewing code, check:

- Scope: Does the change do only what was requested?
- Correctness: Does it satisfy the business rule?
- Architecture: Does it respect current structure?
- Contracts: Are frontend and backend aligned?
- Security: Are auth, roles, CSRF, CORS, input validation, and secrets handled?
- Errors: Are errors explicit and safe?
- Data integrity: Are transactions used where needed?
- Idempotency: Are payment, webhook, and confirmation flows safe to retry?
- UX: Are loading, error, empty, success, and disabled states handled?
- Maintainability: Are names clear and responsibilities separated?
- Complexity: Is there unnecessary abstraction?
- Regression risk: What could break?
- Verification: What commands or manual checks are appropriate?

## Testing And Verification

Use only commands that exist in the repo unless proposing a new script. Check `package.json` before running validation.

Common frontend commands:

- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run preview`

Common backend commands:

- `npm start`
- `npm run dev`
- `npm run lint`

If `npm test` is a placeholder or fails by design, do not claim automated tests passed unless actual tests are added or the script is changed.

Verification expectations:

- Run or recommend `npm run lint` for touched repositories when practical.
- Run or recommend `npm run build` for frontend changes.
- For backend changes without a real test suite, recommend targeted manual or API checks.
- For auth, booking, payment, and admin permissions, include manual verification steps.
- Do not run repetitive or irrelevant tests.
- Prefer one focused verification pass per risk area.

## Definition Of Done

A task is done when:

- The requested behavior is implemented.
- The change is minimal and scoped.
- Existing architecture is respected.
- API contracts remain aligned.
- Errors are handled explicitly.
- Security and permissions are not weakened.
- Loading, error, empty, success, and disabled states are handled when UI is touched.
- Verification commands are identified or run.
- Risks and trade-offs are documented.
- No unrelated files were changed.
- No new dependency was added without justification.

## Response Formats

For substantial implementation tasks, report:

1. Scope understood.
2. Files inspected.
3. Files changed.
4. Summary of changes.
5. Backend impact.
6. Frontend impact.
7. Verification performed or recommended.
8. Risks and trade-offs.
9. Next small step, if needed.

For code review tasks, lead with findings ordered by severity, then include:

1. Review result: approved, approved with comments, or changes requested.
2. Critical findings.
3. Important findings.
4. Optional improvements.
5. Contract/API risks.
6. Security risks.
7. Verification gaps.
8. Suggested patch or prompt for Codex.

Do not nitpick style unless it affects clarity, maintainability, correctness, or consistency.
