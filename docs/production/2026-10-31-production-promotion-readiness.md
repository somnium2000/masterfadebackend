# Production promotion readiness — 2026-10-31

## Scope and invariants

- No QA or production mutations were performed.
- Production's five-minute reservation TTL remains unchanged. The backend and frontend consume database `expires_at`; they do not assume a longer client-side TTL.
- Financial confirmation requires a persisted `paid_at`. The database never substitutes deployment, reconciliation, or wall-clock time.
- Existing `payment_intents` protections are preserved; migrations never drop their three constraints.

## Migration order

1. Freeze manual financial reconciliation and record the application revision and migration ledger.
2. Confirm a fresh scheduled backup is visible and complete. Do not proceed until an isolated restore has been executed and integrity checks pass.
3. Run read-only preflight counts: final payments, confirmed appointment intents, paid membership orders, and paid subscription payments with null `paid_at` must all be zero.
4. Apply `db/migrations/pixel/20261101025900_financial_paid_at_contract_v2.sql`.
5. Apply `db/migrations/20261101025903_production_structural_alignment_v1.sql`.
6. Apply `db/migrations/20261101025905_security_definer_trigger_lockdown_v1.sql`.
7. Verify triggers enabled, function ACL/search paths, the three protected constraints, the membership unique index, and `ck_sub_motivo_fin`.
8. Run database financial/membership/reservation smoke tests without provider traffic.
9. Integrate the already validated backend commit before the frontend commit. Push/merge only after approval.
10. EasyPanel currently targets `main`, but automatic deployment is disabled for both production services. Perform an explicit backend deployment, verify health/schema preflight, then explicitly deploy the frontend and verify served assets.

If any migration fails, stop. PostgreSQL rolls back that migration transaction. Do not retry after manually changing data; capture the error, restore the pre-migration application revision, and use the verified isolated-restoration procedure if integrity was affected.

## Backup and recovery evidence

The Supabase production dashboard showed seven physical daily backups dated 25–31 October 2026; the newest was `2026-10-31 06:04:50 UTC`. PITR is not enabled. Database backups exclude Storage objects and cannot recover database changes after the selected daily snapshot.

Required approval gate:

1. Restore the newest physical backup to an isolated project.
2. Record source backup timestamp, restored project reference, start/end time, and restore status.
3. Compare schema fingerprints, migration ledger, row counts for financial tables, null-evidence counts, FK violations, and the three protected `payment_intents` constraints.
4. Exercise synthetic read-only financial, membership, and reservation queries in the restored project.
5. Delete the isolated project only under separately authorized operational procedure.

No isolated restoration was started because Supabase's restore-to-new-project operation can create billable resources and no cost authorization was provided. Therefore promotion remains blocked.

The zero-cost local logical-backup attempt also remains blocked: the official CLI has no local Supabase access token or database password, and no production credential exists in local environment files. No token was created and no remote password was reset. A logical dump cannot substitute for the managed physical-restore test.

## Financial evidence trust boundary

`paid_at` is an evidence-receipt timestamp, not evidence by itself. The database contract rejects missing timestamps and clock fallbacks, while the backend must establish authenticity before persisting it: PixelPay appointment recovery requires a fully verified approved Sale attempt, and membership activation requires a verified `payment_events` record. A privileged database writer could still forge both the timestamp and its supporting row; production uses the `postgres` database role for these tables, so authenticity ultimately depends on the backend verification path and credential integrity. This residual trust boundary must be accepted or replaced with a narrower writer role plus a database-enforced evidence reference before GO.

## Security disposition

- Critical and corrected: direct `anon`/`authenticated` execution of two `SECURITY DEFINER` trigger functions. Their triggers remain enabled; direct client execution is revoked.
- Critical and corrected in touched financial functions: mutable `search_path`.
- Preserved intentionally: authenticated execution of `fn_es_admin_de_sucursal` and `fn_is_super_admin`, because production RLS policies depend on them.
- Defense in depth, not exposed by current grants: eight RLS-enabled tables without policies are readable only by `postgres` and `mf_audit_readonly`; no speculative policies were added.
- Manual dashboard control: leaked-password protection must be enabled and verified separately.
- Performance follow-up: unindexed foreign keys and duplicate indexes require workload evidence and are not part of this financial security migration.
