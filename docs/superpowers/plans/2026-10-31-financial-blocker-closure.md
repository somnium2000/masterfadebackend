# Financial Blocker Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate clock-invented VIP payment timestamps and prove single activation with real PostgreSQL 17 races.

**Architecture:** Persist and select the earliest verified approval event as an evidence-receipt timestamp, carry it explicitly through all financial rows, and stop automatic activation when it arrives after expiry. A dedicated PostgreSQL 17 fixture runs the real membership service through independent transactional connections and verifies final catalog state after each race.

**Tech Stack:** Node.js 22, Fastify service layer, `pg` 8, PostgreSQL 17, PixelPay SDK 2.5.8.

**Spec:** `docs/superpowers/specs/2026-10-31-financial-blocker-closure.md`

## Global Constraints

- Synthetic local data only.
- No PixelPay Sale, Status, or other provider operation.
- No QA/production writes, flags, merge, or deployment.
- Do not change public or authenticated booking contracts.
- Push only the isolated audit branch after the full verification gate passes.

## Review Focus

- The first durable verified receipt after expiry must remain pending reconciliation and never activate or become rejected.
- Duplicate durable events must select the earliest trustworthy receipt, not a later event that changes expiry classification.
- Competing transactions must serialize on the same intent/order and leave one payment/subscription/benefit set.
- A failure after subscription insertion must roll back order, intent, payment, subscription and accounting state together.
- Existing active membership replacement must cancel only the prior same-branch membership and create exactly one successor.

---

### Task 1: Strict temporal evidence

**Files:**
- Modify: `test/membership-financial-security.test.mjs`
- Modify: `src/services/membershipService.js`

**Interfaces:**
- Consumes: verified PixelPay result, durable `payment_events.recibido_at`, intent/order expiry.
- Produces: explicit `verifiedAt` propagated to all three financial `paid_at` columns or a pending-reconciliation result.

- [x] **Step 1: Add failing contract tests**

Assert no `COALESCE(..., now())`, earliest durable receipt selection, no activation after late receipt, preserved identifiers/evidence, and identical financial timestamps across payment/order/subscription-payment writes.

- [x] **Step 2: Run tests and verify RED**

Run: `node --test test/membership-financial-security.test.mjs`
Expected: FAIL on missing direct-Sale evidence time and current clock fallbacks.

- [x] **Step 3: Implement explicit timestamp propagation**

Return the earliest persisted verified-event receipt from evidence persistence, validate it against both expiries before activation, use it directly in financial inserts/updates, and keep late approvals pending.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/membership-financial-security.test.mjs`
Expected: PASS with Sale/Status call counters unchanged in no-provider cases.

### Task 2: Real PostgreSQL activation races

**Files:**
- Create: `test/fixtures/membership-activation-concurrency.sql`
- Create: `test/membership-activation-concurrency.postgres.test.mjs`
- Modify: `src/services/membershipService.js` only if a real race reveals a defect.

**Interfaces:**
- Consumes: real exported membership confirmation/recovery services and PostgreSQL transactions.
- Produces: repeatable independent-connection race evidence with exact final row counts.

- [x] **Step 1: Add fixture and failing race tests**

Cover two confirmations, two recoveries, confirmation versus polling, duplicate provider transaction, replacement membership, and failure injection. Query final counts and states after every race.

- [x] **Step 2: Run PostgreSQL 17 test and verify RED where behavior is unsafe**

Run: `node --test test/membership-activation-concurrency.postgres.test.mjs`
Expected: at least one assertion exposes current timestamp/concurrency behavior before the minimal fix.

- [x] **Step 3: Implement only concurrency fixes proven necessary**

Preserve the current transaction boundary and lock order; add database constraints or service guards only when the real race demonstrates the need.

- [x] **Step 4: Run PostgreSQL 17 test and verify GREEN**

Expected: one payment, one successor subscription, one accounting row, one benefits snapshot, zero consumptions, consistent states and full rollback.

### Task 3: Migration, branch and release verification

**Files:**
- Modify: `docs/production/2026-10-30-phase1-financial-schema-runbook.md`
- Modify: this plan for completed checkboxes.

**Interfaces:**
- Consumes: phase 1 migrations, `origin/main`, `origin/dev`, focused and complete suites.
- Produces: audited SHA and published work branch without merge/deployment.

- [x] **Step 1: Re-run prepared migration contract and PostgreSQL integrations**

Expected: migrations remain additive and compatible with explicit timestamps.

- [ ] **Step 2: Apply commit without merge to isolated `origin/main` and `origin/dev` checks**

Expected: focused tests and lint pass on both histories.

- [x] **Step 3: Run full regression and inspect diff**

Expected: zero failures, no booking-contract changes, no provider traffic.

- [ ] **Step 4: Commit and push only the audit branch**

Run: `git push -u origin audit/prod-phase1-financial-schema-20261030`
Expected: remote branch points to the verified local SHA; no merge or deployment.
