# MasterFade production phase 1: financial schema runbook

Status: **NO-GO / scripts prepared but not authorized for QA or production**.

## Verified environment differences

| Area | QA | Production | Classification |
|---|---|---|---|
| `membership_purchase_orders.idempotency_key` | nullable `text` present | absent | incompatible; additive migration required |
| `ux_membership_purchase_orders_cliente_idempotency` | unique partial `(id_cliente,idempotency_key) WHERE idempotency_key IS NOT NULL` | absent | incompatible; concurrent build required |
| `fn_trg_validar_pago_monto_tiempo()` | compares with `COALESCE(NEW.paid_at,now())` | relevant comparisons use `now()` | incompatible; proposed version requires explicit `paid_at` for financial states |
| `fn_payment_intents_capture_paid_at()` | derives from explicit intent/payment evidence and fails closed after expiry | can use `clock_timestamp()` fallback | critical incompatibility; clock fallback must be removed |
| canonical `hold_duracion_min` | 6 | 5 | incompatible configuration; decision required, no phase-one change |
| compatibility aliases for hold TTL | 6 | 6 | production is internally inconsistent |
| payment intent protection | QA lacks some production objects | production includes blank guards, nonnegative verification attempts, provider/order uniqueness and verification-queue indexes | intentional protection; preserve production definitions |
| migration history | includes account deletion, PixelPay, VIP idempotency and QA-only changes through `20261030211140` | lacks those entries and contains three production admin-prep entries `20261028160036..160141` | divergent; do not rewrite history or mark versions as applied |

Production-only objects explicitly protected by the PostgreSQL contract include:

- `ck_payment_intents_provider_session_not_blank`
- `ck_payment_intents_orden_compra_not_blank`
- `ck_payment_intents_verification_attempts_nonnegative`
- `uq_payment_intents_provider_orden_compra`
- `idx_payment_intents_verification_queue`

## Proposed migration dependency graph

1. `db/migrations/pixel/20261031010000_production_financial_schema_alignment_v1.sql`
   - requires the existing payment tables, functions and enabled triggers;
   - adds only the nullable VIP idempotency column;
   - replaces the two functions without recreating triggers;
   - does not modify TTL, data, constraints or indexes.
2. `db/migrations/20261031011000_membership_order_idempotency_index_v1.sql`
   - requires migration 1 and zero duplicate non-null `(id_cliente,idempotency_key)` pairs;
   - must be executed by `psql` outside an explicit transaction;
   - creates the partial unique index with `CONCURRENTLY`.

These new versions intentionally do not claim or repair any historical Supabase migration version. A release record must register only the newly executed files after their post-checks succeed.

## Read-only preflight

Run all checks in the target immediately before a maintenance window. Any returned duplicate, disabled trigger, missing function, unexpected definition, invalid index, or long-running transaction is a stop condition.

```sql
SELECT id_cliente, idempotency_key, count(*)
FROM public.membership_purchase_orders
WHERE idempotency_key IS NOT NULL
GROUP BY id_cliente, idempotency_key
HAVING count(*) > 1;

SELECT tgname, tgenabled, pg_get_triggerdef(oid, true)
FROM pg_trigger
WHERE tgrelid IN ('public.payment_intents'::regclass, 'public.payments'::regclass)
  AND NOT tgisinternal
ORDER BY tgrelid::regclass::text, tgname;

SELECT c.conname, pg_get_constraintdef(c.oid, true)
FROM pg_constraint c
WHERE c.conrelid = 'public.payment_intents'::regclass
ORDER BY c.conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('payment_intents', 'membership_purchase_orders')
ORDER BY tablename, indexname;

SELECT pid, xact_start, state, wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()
ORDER BY xact_start;
```

Also capture `pg_get_functiondef`, owner, ACL, volatility, security mode and `proconfig` for both target functions. Compare them with the reviewed artifacts by hash before execution.

## Controlled execution

1. Keep VIP purchase disabled and pause application instances that can cache schema capabilities. Do not send PixelPay traffic.
2. Take a recoverable database backup/PITR marker and record the target revision and catalog fingerprints.
3. Execute migration 1 with `psql -v ON_ERROR_STOP=1 -f ...`. It is transactional and has bounded lock/statement timeouts.
4. Run the function, trigger and protected-catalog post-checks. Stop on any difference outside the reviewed functions/new column.
5. Execute migration 2 using `psql -v ON_ERROR_STOP=1 -f ...` **without** `BEGIN`, a migration wrapper, or a pooled API that groups statements into one transaction.
6. Verify `indisvalid`, `indisready`, uniqueness, predicate and column order from `pg_index`/`pg_get_indexdef`.
7. Only after a separately approved backend correction proves that direct VIP approval never supplies clock-invented `paid_at`, restart instances and clear the capability cache by process restart.
8. Run read-only health checks. Enabling VIP purchases, deployment, Sale or Status belongs to a later approved phase.

## Rollback / forward-fix

- Before commit of migration 1, PostgreSQL rolls it back atomically.
- If migration 1 commits, do **not** drop the nullable column or restore the unsafe clock fallback. Keep the additive schema and deploy a reviewed forward-fix function definition.
- If concurrent index creation fails, inspect `pg_index.indisvalid`. A same-name invalid index is a stop condition; during an approved window, an operator may drop only that exact invalid index and rerun migration 2. This destructive recovery is not included or authorized here.
- If application compatibility fails after schema execution, keep VIP purchase disabled, roll back application instances, and retain the additive column/index. Do not rewrite migration history.
- Restoring the production `clock_timestamp()` fallback is not an acceptable financial rollback because it recreates the critical defect.

## TTL recommendation

Recommend **6 minutes**, because QA and both compatibility aliases already use 6 while only production's canonical key uses 5. The extra minute reduces expiry races during provider handoff/reconciliation. This is not a technical-only decision: product must approve the inventory-capacity tradeoff and operations must confirm that frontend countdowns, backend expiry, cleanup jobs, intent expiry and monitoring all consume the same canonical value. No TTL change is included in either migration.

## Risks and stop conditions

- **Critical:** `insertCapturedPaymentForMembershipIntent()` in current backend `main` and `dev` still uses `COALESCE(provider_paid_at, now())`; a direct approved Sale does not pass `verifiedAt`. PostgreSQL cannot distinguish that invented non-null value from provider evidence. Production migration is blocked until code persists and reuses a defined trustworthy timestamp (recommended: durable verified-event `recibido_at`) and tests it.
- **High:** applying the function migration before compatible backend code can either preserve invented timestamps or fail financial inserts, depending on caller behavior.
- **High:** migration-history divergence makes automatic repair/synchronization unsafe; only new versions may be registered.
- **Medium:** `ALTER TABLE ... ADD COLUMN` takes a brief table lock; the 5-second lock timeout prevents indefinite waiting but may abort the migration.
- **Medium:** concurrent index construction consumes I/O and can leave an invalid index after interruption.
- **Medium:** changing canonical TTL affects availability and conversion; keep it separate from financial schema alignment.
- **Low:** existing historical rows remain `NULL`; the partial index intentionally does not rewrite them.

## Phase-one evidence

- PostgreSQL 17 isolated contract: catalog preservation, repeatable application, exact-expiry validity, post-expiry rejection, missing-evidence rejection, late reconciliation by persisted time, and two-session VIP idempotency race.
- Existing PostgreSQL 17 payment regression: 15 real-trigger/recovery cases plus startup/cleanup checks, all executed with the integration flag enabled.
- Existing PostgreSQL 17 membership identity regression: provider identity separation and reuse protection executed with the integration flag enabled.
- Focused backend suite: 87/87 passing, including one-time activation/accounting and concurrent idempotency behavior.
- Full backend `main` suite: 2645 passed, 0 failed, 6 skipped; lint returned 0 errors and 25 pre-existing warnings.
- Backend `dev` compatibility (`a119c91755ef6b11b738a927062752fbc4444a2d`): patch applied without conflict; 88/88 focused tests passed; lint returned 0 errors and the same 25 warnings.
- Frontend `main` (`636297ad531bbfcecc5313b02722e323eff40107`): 102/102 focused booking/payment/VIP tests passed and production build completed.
- Frontend `dev` (`276a81f6125ddb2f4e674cd9de2f86fa98059262`): 105/105 focused booking/payment/VIP tests passed and production build completed.
- Dependency audit observation only: backend install reported 13 known vulnerabilities; each frontend install reported 27. No dependency changes were authorized in this phase.
- Provider calls: Sale `0`; Status `0`; other PixelPay operations `0`.
- Real database writes: QA `0`; production `0`.

## Pending decisions

1. Define the authoritative `paid_at` source when PixelPay Sale has no provider transaction timestamp. Recommended: the durable verified-event `recibido_at`, never a later processing `now()` fallback.
2. Approve a backend patch and regression proving direct Sale, durable recovery and simulator paths supply explicit evidence consistently.
3. Approve 6 minutes as the single TTL and a separate configuration migration/release.
4. Select the production migration runner and prove it does not wrap migration 2 in a transaction.
5. Decide how the new versions are recorded without backfilling or altering divergent historical versions.
6. Schedule the maintenance window, backup/PITR marker, monitoring owner and abort thresholds.
7. Triage dependency-audit findings separately; do not mix dependency upgrades into this migration release.

## Phase 1.1 blocker closure (2026-10-31)

The backend correction removes the application fallback that manufactured a capture time with
`COALESCE(provider_paid_at, now())`. PixelPay SDK Core 2.5.8 exposes
`transaction_date` and `transaction_time`, but the installed SDK verifies `payment_hash` from the
order identifier and secret; this integration has no reviewed guarantee that authenticates those
two timestamp fields. They therefore remain provider evidence, not the authoritative financial
clock for automatic activation.

The accepted source is the earliest persisted `payment_events.recibido_at` for an approval whose
hash, payment UUID, transaction ID, amount, currency, order and intent were verified. This timestamp
means **receipt of verified financial evidence**, not the provider's original transaction instant.
The same explicit value is written to `payments.paid_at`,
`membership_purchase_orders.paid_at` and `subscription_payments.paid_at`; `created_at` and
`updated_at` retain their administrative/audit meaning. A receipt after either the order or intent
expiry is retained durably and stays `pendiente_confirmacion` for reconciliation: it cannot activate
automatically, trigger a second Sale, or be reclassified as a rejection.

The phase-one migrations are unchanged. Their nullable timestamp contract remains compatible with
the stricter caller and the existing production-only protective constraints/indexes remain intact.
The PostgreSQL 17 activation test uses independent connections and synthetic rows for all six races:
two confirmations, two recoveries, confirmation versus polling, duplicate transaction evidence,
replacement of an active membership, and injected transactional failure. Every successful scenario
ends with one payment, one newly-created subscription, one subscription-payment row, one benefits
snapshot and zero consumptions; the failure scenario rolls all activation rows and states back while
retaining the durable approval event. PixelPay Sale and Status are explicitly blocked in the test.

This closes only the two phase 1.1 financial blockers. It does not authorize production execution,
VIP enablement, merge or deployment; security/configuration, branch convergence and production
migration approval remain separate gates.
