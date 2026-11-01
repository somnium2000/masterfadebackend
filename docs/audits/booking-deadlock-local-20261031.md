# Booking hold deadlock: local PostgreSQL 17.9 evidence

Scope: local laboratory only. No QA/production, PixelPay, SMTP, deployment, or
financial-flow changes were used.

## Before

The original 50-VU run completed 6,750 functional requests with p95 130.3 ms,
but two of 20 same-slot races returned HTTP 500. PostgreSQL logged SQLSTATE
`40P01` twice:

- process 31720 waited for a `ShareLock` on transaction 7297, held by 23072;
  process 23072 waited for the corresponding lock on transaction 7295, held by
  31720;
- the second cycle repeated between transactions 9201 and 9203;
- both sessions executed
  `SELECT app_private.crear_reserva_canonica_v1($1::jsonb) AS resultado`;
- PostgreSQL reported `while checking exclusion constraint ... in relation
  "citas"`, from the `INSERT INTO public.citas` in
  `crear_reserva_canonica_v1_core_20260702`.

The relevant invariant is `ex_citas_solape_barbero`, a GiST exclusion constraint
over `(id_empleado_barbero WITH =, tstzrange(inicio_at, fin_at, '[)') WITH &&)`
for active appointment states. It prevented an overlap, but the symmetric
speculative inserts could form an XID wait cycle before one transaction was
chosen as the deadlock victim.

## Change

`createCanonicalReservation` now derives transaction-scoped advisory lock keys
for every minute in every candidate appointment interval and acquires the union
in lexical order before invoking the canonical RPC. Keys include the barber,
so overlapping intervals for one barber share a lock while disjoint intervals
or different barbers do not. Candidate-assignment keys are deduplicated and
globally ordered, eliminating order inversion for multi-member/multi-candidate
payloads.

The GiST constraint, triggers, canonical RPC, idempotency table, transaction
boundaries, and business-conflict mapping remain unchanged. No deadlock retry
was added: every backend canonical caller is already inside the common
`createBookingHold` transaction, and the demonstrated application cycle is
removed before reaching the conflicting insert. A caller that bypasses this
service remains outside this guarantee; the GiST constraint is still the final
integrity defense.

## Reproduction and verification

```powershell
node --test test/booking-hold-deadlock.postgres.test.mjs
node tests/load/artillery/conflict-probe.mjs tests/load/artillery/reports/conflicts-200-after2.json 200 0
powershell -NoProfile -ExecutionPolicy Bypass -File tests/load/artillery/run-local.ps1 -Stage 25
powershell -NoProfile -ExecutionPolicy Bypass -File tests/load/artillery/run-local.ps1 -Stage 50
npm test
npm run lint
```

PostgreSQL 17.9 results:

- 200 independent same-slot races: one success and one `MF_SLOT_TAKEN` each;
  zero `40P01` and zero deadlock log entries;
- overlapping intervals on one barber: one winner, one business conflict;
- non-overlapping intervals and different barbers: both succeed;
- duplicate idempotency key/payload: one group returned to both callers;
- concurrent hold release/create: at most one active appointment remains;
- induced trigger failure: full rollback, with group and appointment counts
  unchanged;
- final audit: zero active overlaps, zero active holds, zero active groups
  without appointments, and zero idempotency rows without a result.

HTTP and Artillery results:

| Run | Requests/races | Result | Aggregate p95 |
| --- | ---: | --- | ---: |
| Original 50 VU | 6,750 requests; 20 races | 2 HTTP 500 / 2 deadlocks | 130.3 ms |
| Fixed conflict probe | 200 races | 200 x 201; 200 x 409; 0 unexpected | n/a |
| Fixed 25 VU (~5 min) | 3,375 requests | 3,375 assertions; 0 failed VU | 120.3 ms |
| Fixed 50 VU (~5 min) | 6,750 requests | 6,750 assertions; 0 failed VU | 117.9 ms |

The fixed 50-VU p95 is 9.5% lower than the comparable baseline; mean latency is
37.6 ms versus 38.0 ms. The local post-change PostgreSQL log contains no new
deadlock entry.

Full regression: 2,721 passed, 0 failed, 9 skipped. ESLint completed with zero
errors and 25 pre-existing warnings.
