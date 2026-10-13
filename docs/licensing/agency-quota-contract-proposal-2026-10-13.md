# Agency Quota Contract Proposal

**Status:** Proposal for review; no quota contract is currently implemented. **No code or database changes are included.**

## 1. Decision requested

Approve or amend the proposed contract in §4–§8 before implementation. The repository currently contains conflicting phase documents and no authenticated quota synchronization path. The proposal preserves the License Server’s separate database and introduces an agency-level quota record. It does not use `licenses.device_limit` or the per-license `allocated` field as an agency quota.

## 2. Audit findings (current source vs. specification)

### Mother Company and quota source

- The Phase-1 architecture assigns authority to Mother Company and describes `license_quota` on the CRM `agencies` row, but explicitly allows a future migration to add the column: `docs/licensing/phase-1-architecture-2026-10-11.md:279-295` and `:60-64`.
- Current migration `server/database/migrations/085_mother_company_agencies.sql:95-130` creates `agencies` with `id`, `company_id`, and `provider_company_id`; it has no `license_quota` column. `id` is the agency entity key. `company_id` is the agency’s own CRM tenant; `provider_company_id` is the managing Mother Company.
- `server/services/agency.service.js:54-58` allowlists writable profile fields and exclude `license_quota`. The service header at `:7-11` says licensing/central License Server are not implemented. `getLicenseOverview()` at `:315-330` returns `implemented: false` and null counts.
- `server/routes/motherCompany.js:32-35,57-80,95-105` uses authenticated Mother Company routes and named permissions for viewing/editing agencies. No quota write/publish endpoint is present in the inspected route file.
- Phase-2 implementation plan conflicts with Phase 1: `docs/licensing/phase-2-implementation-plan-2026-10-11.md:44-46` says no `license_quota` column is added to CRM and describes License Server as a separate DB with read-only CRM behavior.

**Finding:** Mother Company is the documented authority, but the current code does not persist `license_quota`; no current value can be treated as authoritative. This proposal recommends an additive CRM agency field, subject to resolving the Phase-1/Phase-2 contradiction.

### License Server, allocation, and identity

- `license-server/src/db/schema.ts:70-99` defines `licenses` and `activations`; `:101-146` defines bindings, policy cache, audit logs, and idempotency. There is no agency quota table/counter.
- `license-server/src/routes/licenses.ts:14-21` mounts `POST /api/licenses/allocate` behind service-token authentication. `src/middleware/quota.ts:33-54` accepts `agency_id`, `product_id`, and positive integer `count`.
- The present check in `src/middleware/quota.ts:110-130` sums `device_limit - allocated` over active license rows. The middleware’s own note at `:4-9,113-120` identifies this as legacy behavior unresolved against the agency `license_quota` model. New licenses are inserted with `device_limit=1` and `allocated=0` at `:132-155`; the commented-out block at `:157-171` does not increment `allocated`.
- The token middleware at `license-server/src/middleware/auth.ts:10-37` validates a License Server bearer token and maps its `sub` claim to `req.locals.user.companyId`. `src/auth/tokens.ts:58-80` verifies issuer/audience/HS256 and rejects wildcard scope. The allocation route as inspected does not enforce a named allocation scope or compare the requested `agency_id` with the token subject. This must be corrected in implementation; do not weaken or bypass existing checks.
- The CRM-side agency has three identities with different meanings: `agencies.id`, `agencies.company_id`, and `agencies.provider_company_id` (`085_mother_company_agencies.sql:95-104`; explanatory comments in `agency.service.js:60-78`). The License Server’s allocation body uses `agency_id`; no source mapping/sync code was found. The proposed stable cross-system key is **the exact CRM `agencies.id` copied unchanged into License Server quota and license rows**. Do not substitute `company_id`, `provider_company_id`, `agency_code`, or a generated License Server ID.

### Allocation count vs. device activation count

- Phase 1 distinguishes agency licenses from devices: `phase-1-architecture-2026-10-11.md:62-64` says Mother Company sets licenses-per-agency `license_quota` while `license.device_limit` controls devices per license.
- Phase 2 lists `licenses.device_limit` and `licenses.allocated` separately from `activations` rows (`phase-2-implementation-plan-2026-10-11.md:169-183`). Current middleware uses `device_limit - allocated` as available allocation capacity, which conflates those concerns with agency issuance. The current meaning and update lifecycle of `licenses.allocated` require specification confirmation. This proposal leaves the field untouched and introduces `allocated_licenses` at agency level.

### Synchronization and test/log evidence

- No CRM-to-License-Server quota API, event, outbox, polling client, or authenticated synchronization mechanism was found in the inspected routes, middleware, services, schemas, tests, and licensing docs.
- The repository’s only top-level License Server `.log` file found was `license-server/server_manual.log` (timestamp shown by filesystem: 2026-10-12 23:18). It records an earlier ESM startup error: `computeFingerprint` was missing from the `idempotency.js` exports. Current `src/idempotency.ts:34,48` does export the table creator and fingerprint function, so that log is historical and does not prove current startup status.
- The current integration test source `license-server/tests/integration/idempotency-persistence.test.ts:247-275` still has the 5.4 distinct-key concurrency case; its fixture/comment derives capacity from a seeded license’s device fields rather than a persisted agency quota. A recent executed suite in the prior task reported 28 passing and 1 failing (5.4, three 201 responses where two were expected). This is prior run output, not a test run performed for this audit. No current run is evidenced here; tests were not run for this proposal.

## 3. Data flow (proposed)

```text
Mother Company operator
  -> authenticated CRM route + explicit agency quota permission
  -> CRM transaction: update agencies.license_quota, bump per-agency revision,
     append durable quota-outbox event
  -> outbox dispatcher (at-least-once retry)
  -> HTTPS License Server internal quota endpoint, service identity + quota-write scope
  -> License Server transaction: validate revision, upsert agency quota snapshot
  -> allocation transaction reads that snapshot and increments allocated_licenses
```

The CRM is authoritative. License Server stores a projection needed for low-latency, local, atomic enforcement; it is not a second authority. CRM writes must not report successful synchronization merely because the local quota changed. The UI/API should surface the synchronization state and operational retry mechanism.

## 4. Proposed contract (draft; approval required)

### Source and CRM persistence

Add `license_quota INTEGER` to the CRM `agencies` entity in an additive migration; validate as an integer `>= 0`. Store a per-agency monotonic `license_quota_revision INTEGER NOT NULL DEFAULT 0` (or equivalent revision source) that is incremented transactionally on every accepted quota change. Mother Company is the sole role allowed to change this value. It is not writable through generic agency profile updates. Record actor and old/new values in CRM audit history.

The same CRM transaction writes an outbox row containing the full latest snapshot. Suggested columns: `event_id` (unique), `agency_id`, `revision`, `license_quota`, `agency_status`, `occurred_at`, `delivery_attempts`, `next_attempt_at`, `delivered_at`, `last_error`. Unique constraint: `(agency_id, revision)`. Never derive revisions from wall-clock timestamps.

### Quota synchronization API

Recommended endpoint: `PUT /internal/v1/agencies/{agency_id}/quota` over HTTPS. This is a new proposed endpoint, not an existing route. Request body:

```json
{
  "license_quota": 25,
  "revision": 14,
  "agency_status": "ACTIVE",
  "event_id": "<stable-outbox-event-id>"
}
```

`agency_id` in the URL and body event must be the canonical CRM `agencies.id`; the revision is scoped to that agency. Require a non-negative integer quota, positive integer revision, supported lifecycle status, and a bounded event ID. Do not accept caller-supplied usage counts. Successful response returns `{agency_id, revision, applied: true}`. Repeating the same revision and same values returns success as a no-op; same revision with different values is a conflict and alarms; lower revision is acknowledged as stale/no-op (or a documented `409 STALE_REVISION`, provided the outbox treats it as terminal and reconciles). Prefer `200` for idempotent acceptance and include the stored revision in every response.

### Authentication and authorization

Use a dedicated CRM-to-License-Server service credential, separate from user/browser tokens, with short-lived signed credentials or mutually authenticated TLS. The service token must have an explicit scope such as `agency-quota:write`; reject wildcard scope. Bind issuer/audience, expiry, key rotation, and audit identity. The endpoint authorizes only this service identity/scope and validates the route’s canonical agency ID. Allocation tokens must retain their separate allocation scope and agency binding. Current `serviceTokenMiddleware` authenticates but the inspected allocation route has no explicit scope gate; implementation must add a least-privilege scope check and ensure a caller cannot allocate for an agency outside its token’s allowed agency context. Do not reuse CRM’s wildcard `*` permission.

## 5. License Server persistence and transaction rules

Add an `agency_quotas` table (name proposed):

| Field | Meaning |
|---|---|
| `agency_id TEXT PRIMARY KEY` | Canonical CRM agency ID, no cross-database FK |
| `license_quota INTEGER NOT NULL CHECK (license_quota >= 0)` | Latest authoritative limit |
| `allocated_licenses INTEGER NOT NULL DEFAULT 0 CHECK (allocated_licenses >= 0)` | Agency-level count of licenses issued and still counted by the agreed lifecycle rule |
| `revision INTEGER NOT NULL` | Highest accepted CRM revision |
| `agency_status TEXT NOT NULL` | Lifecycle snapshot used to block suspended/terminated agency allocation |
| `updated_at TEXT NOT NULL` | Local update timestamp for operations/debug only, not ordering |

Optionally persist `last_event_id` and a checksum/value hash for conflict diagnostics. Preserve `licenses.device_limit`, `licenses.allocated`, and `activations` as distinct per-license/device concepts until their exact semantics are approved.

Allocation contract, in one SQLite write transaction (use `BEGIN IMMEDIATE` or equivalent):

1. Validate authenticated allocation scope and agency binding; normalize `agency_id`, `product_id`, `count`.
2. Check idempotency key **before** quota mutation. Key namespace must include service/agency or table uniqueness must include `(agency_id, key)`. Same key + same canonical payload returns stored original HTTP status/body/license IDs without inserts or counter increments. Same key + different payload returns `409 IDEMPOTENCY_KEY_REUSED` without side effects.
3. Read current `agency_quotas` row. If missing, reject closed with a retryable “quota not synchronized” response; do not infer quota from license/device rows. Reject inactive agency per agreed status rule.
4. Atomically require `allocated_licenses + count <= license_quota`; otherwise return `409 QUOTA_EXCEEDED` with limit/current/needed details. No row insert and no idempotency success record on this failure.
5. Insert `count` license rows and increment `allocated_licenses` by exactly `count`; store stable created license IDs and response body in idempotency row. Commit all three effects together.
6. Any error rolls back license rows, counter change, and idempotency write together. Do not use per-license `allocated` or device activation rows for the agency counter.

For concurrency, serialization must happen on a single agency quota row in the same transaction. Concurrent requests with distinct keys may succeed only up to the remaining agency quota. Concurrent same-key requests must produce one allocation and identical replay responses.

## 6. Synchronization, retries, migration, and lifecycle

- **Initial sync:** after License Server migration, CRM emits a full snapshot for every agency. The dispatcher retries until acknowledged; a reconciliation job periodically compares CRM agency ID/revision/quota/status against License Server snapshots. Allocation fails closed while no quota row exists.
- **Retry behavior:** at-least-once delivery with exponential backoff and jitter, bounded attempt metadata, dead-letter/alert after threshold, operator-visible replay. Network/5xx/timeouts retry. Validation/auth errors alert and remain undelivered until corrected. Stale events are terminal no-ops; latest revision remains authoritative.
- **Concurrent updates:** License Server applies only `revision > stored_revision`; same revision/same content is an idempotent retry, same revision/different content is a contract violation, lower revision cannot overwrite newer state. Out-of-order arrival is therefore safe.
- **Quota reduction:** recommended behavior is to accept a lower revisioned limit even when `allocated_licenses > license_quota`, mark the agency over-quota, and block new allocations until the count falls below the limit. Do not silently revoke issued licenses. Whether to reject the reduction instead is a business decision; choose one before implementation.
- **Release/revocation:** define which license lifecycle transition releases one agency allocation. Recommended default: an issued license consumes one unit until an explicit audited revoke/cancel operation; expiry alone does not release capacity unless policy explicitly says so. A decrement must be tied to a single idempotent state transition and be guarded against double decrement. Device deactivation does not release an agency license allocation.
- **Suspension/termination/deletion:** recommended snapshot lifecycle blocks new allocation for `SUSPENDED` and `TERMINATED`; existing licenses remain queryable and governed by separate license-revocation policy. Keep a quota tombstone; do not hard-delete projection/counter history. Whether suspension or termination also revokes active licenses, and whether terminated agencies may be reinstated, are unresolved business decisions.
- **CRM migration:** add nullable quota first or choose an explicit default only after a business decision; backfill every active agency before enabling enforcement. Do not infer the quota from device limits or existing allocation rows. Existing licenses need a one-time reconciliation/mapping into `allocated_licenses` based on an agreed definition of “issued and counted”; compare against CRM IDs, audit exceptions, then enable allocation enforcement. Roll out a License Server additive migration, CRM source/outbox, initial sync, monitoring, then switch the allocation transaction. Remove legacy row-sum enforcement only after quota snapshots are complete and verified. Preserve all existing records.
- **Backward compatibility:** keep allocation request and response fields stable (`agency_id`, `product_id`, `count`; license response shape). Existing clients without idempotency keys remain supported if that is current intended behavior, but still pass the authoritative quota transaction. Do not silently fallback to legacy row sums if quota data is absent.

## 7. Acceptance tests to add after approval

1. CRM quota is editable only by explicit Mother Company permission; wildcard-only tenant admin cannot write it. Invalid negative/fractional values reject and audit/outbox do not partially commit.
2. Correct CRM `agencies.id` is synchronized unchanged; `company_id`, `provider_company_id`, and `agency_code` are not substituted.
3. Quota update accepts first revision; identical duplicate is a no-op; lower revision cannot overwrite; same revision with conflicting payload is rejected and observable.
4. Missing quota snapshot fails allocation closed; no legacy device-row fallback.
5. With quota `N`, allocations totaling exactly `N` succeed; next unit returns `409 QUOTA_EXCEEDED`; counter equals successful issued-license count.
6. Concurrent distinct-key requests at boundary never exceed quota; verify exactly `N` successful licenses and `allocated_licenses=N`.
7. Concurrent same-key/same-payload requests create one set of licenses, increment once, and return same status/body/IDs; same key with altered agency/product/count returns 409 and no side effects.
8. Inject failure after license insertion/counter update/idempotency write; verify all effects roll back.
9. Quota reduction below current usage follows approved policy and never silently deletes/revokes licenses; new allocation is blocked until available.
10. Revocation/release decrements once only if that release policy is approved; repeated revoke cannot underflow or decrement twice.
11. Per-license `device_limit` and activation counts remain independent: changing device activations cannot alter `allocated_licenses`, and multiple devices on one license consume no additional agency license unit.
12. Suspended/terminated agency cannot allocate; retries and recovery from License Server outage deliver the newest revision without stale overwrite.

## 8. Unresolved business decisions requiring approval

1. Resolve Phase-1/Phase-2 conflict: add `license_quota` to CRM `agencies` (recommended) or designate a different authoritative store.
2. Define default/backfill quota for existing agencies and whether zero means “no licenses” or “not configured.”
3. Confirm quota unit: issued license records (recommended), active licenses only, or another business concept; define whether product-specific quotas are needed.
4. Decide lower-quota behavior: accept and block future allocation (recommended) vs reject while usage exceeds new quota.
5. Decide whether revocation, cancellation, expiry, suspension, or agency termination releases quota and/or revokes existing licenses.
6. Approve service-to-service credential type, key ownership/rotation, exact scope, and permitted allocation agency binding.
7. Approve sync transport and operational ownership. This proposal recommends transactional outbox + HTTPS upsert + periodic reconciliation; no such mechanism exists in inspected code.
8. Define how existing License Server rows are reconciled to `allocated_licenses`; do not assume the `allocated` device field is the answer.

**Approval gate:** no implementation of quota enforcement or sync should begin until these decisions and the contract in §§4–6 are approved.

## 9. Reference index

- CRM schema and agency identity: `server/database/migrations/085_mother_company_agencies.sql:95-135`.
- CRM agency writable fields and service scope: `server/services/agency.service.js:54-78`; non-implemented license overview: `:315-330`.
- CRM routes and Mother Company authorization: `server/routes/motherCompany.js:1-35,57-105`; `server/middleware/motherCompany.js:36-59,70-108`.
- Phase-1 authority and quota transaction requirement: `docs/licensing/phase-1-architecture-2026-10-11.md:60-67,279-295`.
- Phase-2 CRM no-change statement and allocation/schema contract: `docs/licensing/phase-2-implementation-plan-2026-10-11.md:44-46,105-115,169-183`.
- License Server tables: `license-server/src/db/schema.ts:70-146`.
- Allocation endpoint, auth, and legacy counter semantics: `license-server/src/routes/licenses.ts:14-21`; `license-server/src/middleware/auth.ts:10-37`; `license-server/src/middleware/quota.ts:33-54,75-130,132-171`.
- Service-token validation: `license-server/src/auth/tokens.ts:15-25,58-80`.
- Current idempotency exports and stored result: `license-server/src/idempotency.ts:27-85`; allocation replay: `license-server/src/middleware/quota.ts:77-107,173-202`.
- Concurrency fixture in current test source: `license-server/tests/integration/idempotency-persistence.test.ts:247-275`.
