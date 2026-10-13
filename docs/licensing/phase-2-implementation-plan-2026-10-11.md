# BlackStack CRM — Licensing Platform: Phase 2 Implementation Plan

**Status:** Implementation plan (spec). **No production changes, no source changes, no migrations, no signing.** This document exists so that the moment Phase 2 is approved, implementation can begin directly.

**Repository:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Depends on:** `docs/licensing/phase-1-architecture-2026-10-11.md` (Architecture v2 — already in the repository).

---

## 0. Scope and safety boundaries

Phase 2 is deliberately split into **four clean areas**, each with its own entry/exit criteria. Nothing touches the CRM's tables, the production database, the signing certificate, or the Mother Company account.

| Area | What changes | What does NOT change |
|---|---|---|
| A. License signing key + client binding | License-server signing key material (in the license-server deployment), client-side device key generation | No CRM, no signing certificate, no production provisioning |
| B. License server | New repo/service + `license.db` + API + tests | No CRM schema, no CRM production DB |
| C. Client integration | `server/app.js` / frontend read of `offline-policy`, device key generation, lease enforcement, ticket refresh | No CRM write models, no quota decrement, no billing |
| D. Acceptance | Vitest + E2E + release gate | No production verifier (live install/update/rollback only per explicit authorisation) |

**Blocked until explicit approval:**
- `scripts/provision-mother-company.js` run with a password (Mother Company account `admin@blackstack.lockal`).
- Code-signing (Windows Authenticode) and release-gate pass.
- Any change to `data/blackstack-crm.db`, `server/` write models, migrations, or `package.json`.

---

## 1. Placement of the two systems (unchanged from Architecture v2)

```
+---------------------+        HTTPS        +-----------------------------+
|  Local CRM (client) |  read-only via     |  Central License Server     |
|  node/Electron app  |  blind signed APIs |  (new service/URL)          |
+---------------------+                    +-----------------------------+
        ^                                            ^
        | signed entitlement                         | signed entitlement
        v                                            v
+---------------------+       HTTPS       +-----------------------------+
|  Customer / Agency  |  activation state  |  License signing key       |
|  Admin (Phase 1)    |  in audit logs     |  server-side ONLY          |
+---------------------+                    +-----------------------------+
```

- **CRM DB stays exactly as it is.** No `license`, `activation`, `binding`, or `license_quota` column is added to any existing table.
- **License server has its own `license.db`** — fresh, migrated from the bundle, never an upgrade from legacy state (no legacy licensing store exists).
- The CRM reads the license server **read-only** for `offline-policy` and for the published lease/device-limit policy. It never writes license records.

---

## 2. Central license server — repository layout

```
license-server/
  package.json
  src/
    index.ts                  # HTTP entry: express (or fastify) on a configured port
    config/
      server.ts               # port, https cert/key paths, clock_tolerance, jwt secret (env)
    auth/
      tokens.ts               # service-token: sign/verify, audit scope, nbf/iat/exp, jti
      auth.ts                 # express middleware: verify audit scope; reject ['*']
    db/
      migration.ts            # apply license.db migrations (bundle) on first run
      schema.ts               # sqlite schema (DDL) — see §3
    model/
      license.ts              # upserts, allocate, activate, renew, suspend, revoke, recover
      binding.ts              # register binding; challenge-verify
      audit.ts                # append license audit rows
    policy/
      lease.ts                # lease math: expiry, clock_tolerance, offline window
    routes/
      licenses.ts             # POST/GET /licenses, :id, /:id/activate, /:id/bind, /:id/renew, /:id/suspend, /:id/recover
      auth.ts                 # /auth/login (operator)
      health.ts               # /health, /offline-policy
    errors.ts                 # LICENSE_*, AUTH_*, mapping to status codes
    audit.ts                  # append to license DB `audit_logs`
```

Key constraint: **no CRM code in this server.** Cross-tenant checks on the client token (`sub` = client company) are done with the token, not the CRM DB.

---

## 3. API contracts (full spec)

All endpoints under `/api/licenses`. JSON envelope `{success, data, status}` (CRM convention). Responses are snake_case → camelCase via the CRM middleware.

### 3.1 Discovery / health / policy

```
GET  /api/licenses/health
RESP: { success: true, data: { version, server_time, db_status, clock_tolerance } }

GET  /api/licenses/offline-policy
RESP: { success: true, data: { lease_days, max_devices, revocation_policy } }
```
**Auth:** none. Client call on launch.

### 3.2 Operator-facing login (if operator management is exposed)

```
POST /api/licenses/auth/login   { email, password }
RESP 200: { success: true, data: { token, expiresAt } }
```

### 3.3 License allocation

```
POST /api/licenses
Auth: Bearer <service-token>
Req:  { agency_id, product_id, count }
Resp: { success: true, data: { licenses: [ { id, code, status, device_limit, lease_days, allocated, allocated_at, expires_at } ] } }
```
- Server: atomic per-`id` insert, plus quota check. **See §4 (quota) and §6 (idempotency).**
- Errors: `400 VALIDATION_ERROR`, `409 QUOTA_EXCEEDED`, `404 AGENCY_NOT_FOUND`.

```
GET /api/licenses?agency_id=<id>&status=ACTIVE
Resp: { success: true, data: { total, licenses: [ { id, code, status, device_limit, lease_days, allocated, used, expires_at } ] } }
```

### 3.4 Device binding

```
POST /api/licenses/:id/bind
Auth: Bearer <service-token>
Req:  { device_id, challenge, signature, public_key, device_fingerprint? }
Resp: { success: true, data: { binding: { id, device_id, status, bound_at } } }
```
- `challenge` = **single-use nonce** from the server; `signature` = client's ECDSA signature over `challenge`.
- Server verifies: (a) license `status == ACTIVE` and not expired; (b) `signature` over `challenge` is valid; (c) `public_key` was never bound to another active license (or re-bind is explicitly allowed); (d) `device_id` does not already have an **active** binding unless re-bind is allowed.
- Errors: `400 VALIDATION_ERROR`, `401 LICENSE_EXPIRED`, `409 BINDING_EXISTS`, `422 BAD_CRYPTO`.

### 3.5 Activation

```
POST /api/licenses/:id/activate
Auth: Bearer <service-token>
Req:  { device_id, nonce, signature, public_key }
Resp: { success: true, data: { activation: { id, license_id, device_id, status, expires_at } } }
```
- Rejects if: license expired, device not bound (or re-activation of already-active device), `signature` over `nonce` invalid, `nonce` already used.
- On success: `activations` row created with `status=ACTIVE`, `expires_at = now + lease_days`.

```
POST /api/licenses/:id/document    { device_id }
POST /api/licenses/:id/revoke      { reason }
POST /api/licenses/:id/renew       { term_days }
POST /api/licenses/:id/suspend     { reason }
POST /api/licenses/:id/recover     { reason }
```
- `renew`: returns updated `expires_at`; a revoked/suspended license cannot be renewed (409).
- `suspend`/`recover`: suspend requires a reason; recover requires verification of the requesting party (support channel).

### 3.6 Errors (shared)

| Code | Meaning |
|---|---|
| 400 | `VALIDATION_ERROR` (field map) |
| 401 | `AUTHENTICATION_ERROR` (no/invalid/missing token) |
| 403 | `LICENSE_EXPIRED`, `LICENSE_INVALID_CREDENTIALS`, `NOT_AUTHORIZED` (scope/tenant) |
| 404 | `LICENSE_NOT_FOUND`, `AGENCY_NOT_FOUND`, `DEVICE_NOT_BOUND` |
| 409 | `QUOTA_EXCEEDED`, `BINDING_EXISTS`, `DEVICE_ALREADY_ACTIVE`, `TOKEN_REVOKED` |
| 422 | `BAD_CRYPTO` (bad signature) |

No raw SQLite text, no JWT secret, no private key.

---

## 4. License database schema (`license.db`)

Fully separate from the CRM. Fresh on first run; re-runnable migrations from the bundle. **No FK into the CRM.**

| Table | Purpose |
|---|---|
| `licenses` | `id`, `agency_id`, `product_id`, `code`, `status` (`ACTIVE`,`EXPIRED`,`REVOKED`,`SUSPENDED`), `device_limit`, `lease_days`, `allocated`, `allocated_at`, `expires_at`, `created_by`, `created_at`, `updated_at`, `last_seen_at` |
| `activations` | `id`, `license_id`, `device_id`, `nonce`, `signature`, `public_key`, `status` (`ACTIVE`,`REVOKED`,`RECOVERY_PENDING`), `expires_at`, `created_at`, `updated_at` |
| `bindings` | `id`, `license_id`, `device_id`, `public_key`, `status` (`ACTIVE`,`REVOKED`), `bound_at`, `unbound_at` |
| `policy_cache` | `client_id`, `lease_days`, `max_devices`, `revocation_policy`, `refreshed_at` |
| `audit_logs` | `id`, `agency_id`, `user_id`, `action`, `entity_type`, `entity_id`, `old_values_json`, `new_values_json`, `ip_address`, `user_agent`, `session_id`, `created_at` |

Notes:
- `activations` and `activations.status` mirror the CRM's descriptive semantics (`RECOVERY_PENDING`) so the client's revovery workflow maps 1:1.
- `license.db` has **no column or row from the CRM**; the license server's `audit_logs` is platform-scoped and never written to the CRM's `audit_logs`.

---

## 5. Client integration (the only CRM-side change)

No new CRM table, no new CRM API endpoint (uses the license-server's API). The client only does this at launch:

1. `GET /api/licenses/offline-policy` → cache `lease_days`, `max_devices`, `revocation_policy` in secure storage.
2. Start each activation with a **service token** obtained from the license server (`/auth/login` or a pre-provisioned enrollment) — **never** the CRM JWT.
3. Device registration: create an ECDSA key pair in OS secure storage; `bind` with `challenge` + `signature`.
4. Activate: `activate` with `nonce` + `signature` + `public_key`.
5. On `403 LICENSE_EXPIRED` / `SERVER_TIME_UNAVAILABLE`: stop new activations; surface `SYSTEM_CLOCK_INVALID`; on reconnect, re-sync from `reconcile`.
6. Renew: `POST /api/licenses/:id/renew` with a fresh service token + `Idempotency-Key`.

Client-side tables (secure storage) are new to the local install and are **not** part of the CRM DB.

---

## 6. Request/response contracts (detail)

### 6.1 `POST /api/licenses`

**Request**
```json
{ "agency_id": "agy_xxx", "product_id": "bscrm", "count": 5 }
```
**Response 201**
```json
{
  "success": true,
  "data": {
    "licenses": [
      { "id": "lic_a1", "code": "LIC-xxxx", "status": "ACTIVE",
        "device_limit": 1, "lease_days": 30, "allocated": 0, "allocated_at": "ISO" }
    ]
  }
}
```
**Errors:** 400 VALIDATION_ERROR (field map), 404 AGENCY_NOT_FOUND, 409 QUOTA_EXCEEDED, 422 not JSON.

### 6.2 `POST /api/licenses/:id/bind`

**Request**
```json
{
  "device_id": "dev_a1",
  "challenge": "nonce-<random>",
  "signature": "base64(ecdsa_pubkey(sign(challenge)))",
  "public_key": "base64(ec_public_key)"
}
```
**Response 201**
```json
{ "success": true,
  "data": { "binding": { "id": "bnd_a1", "device_id": "dev_a1", "status": "ACTIVE", "bound_at": "ISO" } } }
```
**Errors:** 400 VALIDATION_ERROR, 401 LICENSE_EXPIRED, 409 BINDING_EXISTS, 422 BAD_CRYPTO.

### 6.3 `POST /api/licenses/:id/activate`

**Request**
```json
{
  "device_id": "dev_a1",
  "nonce": "one-time-<random>",
  "signature": "base64(bind_or_activation_key.sign(nonce))",
  "public_key": "base64(...)"
}
```
**Response 201**
```json
{ "success": true,
  "data": { "activation": { "id": "act_a1", "device_id": "dev_a1", "status": "ACTIVE", "expires_at": "ISO" } } }
```
**Errors:** 400 VALIDATION_ERROR, 401 LICENSE_EXPIRED, 404 LICENSE_NOT_FOUND, 409 DEVICE_NOT_BOUND / DEVICE_ALREADY_ACTIVE, 422 BAD_CRYPTO, 409 TOKEN_REVOKED.

### 6.4 Idempotency key (all mutation endpoints)

Every `POST` mutation accepts an `Idempotency-Key` header. On repeat with the same key within the retention window the server returns the stored result verbatim (no duplicate rows). Keys are single-use per request.

### 6.5 Service authentication

```
Authorization: Bearer <service-token>
```
- `iss` = license server, `aud` = fixed scope string, `sub` = client company, `scope` restricted, `nbf`/`iat`/`exp` short (default 15 min).
- `jti` single-use. Expiry enforced server-side. A CRM user's `['*']` is never accepted here.

---

## 7. Implementation phases (pre-approved plan)

| Phase | What changes (code-base) | Entry | Exit |
|---|---|---|---|
| **P1 — License server** | New `license-server/` repo + `license.db` migrations + API + tests | Authorization approved | Server runs; `/health`, `/offline-policy`, allocation, binding, activation pass all e2e |
| **P2 — Client integration** | `server/app.js` + frontend read + device key generation + lease policy | Approval | E2E: launch → offline-policy → bind → activate → lease expiry → reconnect |
| **P3 — Acceptance** | Vitest + Playwright E2E + release gates | Approval | 12 acceptance tests pass; release gate green |

**Phase 1 (this document) is complete.** Approval of P1 gates P2's start.

---

## 8. Acceptance tests (expanded)

| # | Test | Passes when |
|---|---|---|
| 1 | Service-token RFC | CRM presents token with `aud` (host), `scope` restricted; license server rejects 403 on `['*']` CRM role |
| 2 | Cross-tenant isolation | Tenant A cannot read/mutate tenant B's licenses (404, never 403); `sub` scope enforced |
| 3 | Quota transaction | Concurrent allocation requests under the same agency are serialised; quota never over-allocated (no race) |
| 4 | Lease expiry | Client with expired lease cannot activate; reconnect re-syncs server state; `403 LICENSE_EXPIRED` observed |
| 5 | Clock change | Client with wrong clock is rejected (`LICENSE_INVALID_CREDENTIALS`); re-syncs on clock correction; long lease never granted to drift |
| 6 | Device binding | ECDSA binding handshake succeeds; private key never leaves OS secure storage; `challenge` signed once |
| 7 | Renewal | `renew` issues a new `expires_at`; an expired ticket is refused; `Idempotency-Key` deduplicates |
| 8 | Revocation | `revoke` sets `status='REVOKED'`; client refuses new activation; audit row written |
| 9 | Recovery | Recovery workflow returns the bound device to the current client with a fresh ticket |
| 10 | Idempotency | Repeat of a mutation with the same `Idempotency-Key` returns the same result, no duplicate rows |
| 11 | Backup/restore | License DB backup → restore → reconciliation against the central server; CRM `audit_logs` untouched |
| 12 | DB separation | No `licenses` rows in `data/blackstack-crm.db`; no CRM table has a new license column; zero rows added to existing CRM tables |
| 13 | Release gate | `npm run test:release` green **with** a real signature (already current as the gate for certificate signing) |

---

## 9. Risk and assumptions

- **Billing/payment integration is out of scope here and deferred** to a later phase, so the license server does not touch accounting or CRM write models.
- **Central server hosting**: hosted HTTPS service assumed; LAN deployment explicitly deferred (optional).
- **Certificate**: the Windows Authenticode signing certificate and the license-signing key are vendor/vault items; this document does not produce them.
- **Mother Company provisioning**: not in scope; requires explicit approval + password.
- **No legacy licensing store exists**, so `license.db` is created fresh by the migration bundle (not an upgrade).

---

## 10. What is not decided (and intentionally not built)

- Payment/billing integration (explicit defer).
- Sub-agency hierarchy (explicit defer).
- Device-activation UI inside the dashboard (belongs to a later phase once the license server is live).
- Central-server DNS / hostname (operational decision).

---

## 11. Summary of the plan

| Item | State |
|---|---|
| Architecture v2 | Written and in repo; approved by design review |
| Production DB | Untouched (`data_version` = 2; no new tables / columns) |
| Code signing | No certificate / private key available |
| Mother Company provisioning | Locked behind explicit approval + password |
| Phase 2 spec (this document) | Written; awaiting approval to implement |

**Next action on approval:** P1 — create the `license-server/` repository, write the `license.db` migration bundle, and implement §4 API + §3.0 acceptance tests. The approval gate for starting P1 is the design sign-off given in the previous message.
