# Financial Blocker Closure Specification

## Scope

Close only the two phase-one financial blockers: trustworthy membership payment timestamps and real PostgreSQL 17 activation concurrency. Preserve public and authenticated booking contracts, the prepared migrations, provider identifiers, durable evidence, and all no-provider/no-real-database safety boundaries.

## Temporal evidence contract

- A provider transaction timestamp may represent payment time only when the installed PixelPay SDK/result supplies a documented, verified source.
- Otherwise the earliest persisted `payment_events.recibido_at` for a verified approval is an evidence-receipt timestamp, not proof of an earlier transaction time.
- Automatic activation is allowed only when that earliest receipt timestamp is present and no later than both the intent and order expiry.
- A verified approval first received after expiry remains durable and the intent remains `pendiente_confirmacion`; it is not rejected and must not trigger another Sale.
- `payments.paid_at`, `membership_purchase_orders.paid_at`, and `subscription_payments.paid_at` use the accepted financial-evidence timestamp for this flow. Administrative write time remains represented by `created_at`/`updated_at`.
- No SQL expression may substitute `now()` when the financial-evidence timestamp is absent.

## Concurrency contract

Use independent PostgreSQL 17 connections and real transactions to prove serialization and rollback for duplicate confirmation, duplicate recovery, confirmation-versus-polling, repeated provider transaction, replacement of an active membership, and an injected failure after subscription creation. Successful scenarios must leave exactly one payment, one operation-created subscription, one subscription-payment row, one benefits snapshot, zero duplicate consumptions, and consistent confirmed/paid state.

## Safety

- Synthetic local data only.
- No PixelPay Sale, Status, or other provider operation.
- No QA/production writes, flags, merge, or deployment.
- Push only the isolated audit branch after the full verification gate passes.
