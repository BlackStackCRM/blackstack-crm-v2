# BlackStack CRM — Licensing Platform (Phase 2)

## Status: Architecture v2 (design-only deliverable, security decisions locked in)

**Repository:** `D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2`
**Date:** 2026-10-11

This is **phase 1** of the Licensing Platform. **No production database changes,
no source changes, no migrations, no signing.** It defines the contracts,
boundaries, and security decisions that Phase 2 (implementation) must obey.

The previous version of this document was **v1**. This version **replaces** it.
Every open point listed in v1 is now decided.

---

## 0. Why this revision exists

The original design expected the CRM code signing certificate to also sign
license entitlements. **That is removed.** The Windows installer signing
certificate and the license-server signing key are two different credentials:

- Windows installer / application `.exe` — signed with the **Windows
  Authenticode certificate** (vendor-provided).
- License entitlements → **license signing key**: a private key under the
  exclusive control of the central license server; **never stored in the CRM,
  never shipped to the client app, never stored in the local database.**

Client apps verify the central server's signatures with a fixed **public key**
embedded at build time. If the license server key is ever lost or compromised, a
rotation procedure re-issues entitlements under a new signing key — the local
app accepts the new key without state migration (the public key is refreshed by
the server).

---

## 1. Architecture overview

```
+---------------------+        HTTPS        +-----------------------------+
|  Local CRM (client) |  read-only via     |  Central License Server     |
|  node/Electron app  |  blind signed APIs |  (HTTPS, authenticated)     |
+---------------------+                    +-----------------------------+
        ^                                            ^
        | signed entitlement                         | signed entitlement
        v                                            v
+---------------------+       HTTPS       +-----------------------------+
|  Customer / Agency  |  activation state  |  License signing key       |
|  Admin (Phase 1)    |  in audit logs     |  server-side ONLY          |
+---------------------+                    +-----------------------------+
```

**Non-goals for this phase:** payment/billing, statement generation, sub-agency
hierarchy, device-activation UI, renewal billing flow.

---

## 2. Answering the five license questions (v2)

| Question | Decision (v2) |
|---|---|
| Licenses per agency? | **Mother Company** sets `license_quota` on the agency record (reused from `server/services/agency.service.js` + `motherCompany.js`). The agency's own admin **can only allocate inside that limit**. The central server enforces the final number. |
| Devices per license? | `license.device_limit` = **1** (default), configurable per license. Enforced by the license server, not by the CRM. |
| Offline validity | **Lease window:** `license.lease_days` (default **30**). The client keeps working only inside this window and only if it can present a **signed, unexpired** ticket from the server. When the lease lapses, the client refuses new activations; **on reconnect**, it **syncs** (`reconcile`) and flips `license.status` to `EXPIRED` / `REVOKED` as the server reports. |
| Clock-change handling | The client **will not** accept a wall-clock-only check as sufficient. A lease whose expiry is before a threshold in the past (or whose start is in the future) is marked `INVALID_CLOCK` and cannot be presented to the server. Reconnection after a clock change **re-syncs** from the server; the client **never trusts its own clock for license validity**. |
| Who controls renewal / suspension / recovery? | **Central server only.** The client **cannot** renew, suspend, or recover. It only **reads** the server's decision and **presents** a ticket. Recovery of a bound device is a **server-side** workflow (owner + signed request); the client does not reset binding state on its own. |
| Server down? | The client keeps working **within its lease window**; when the lease lapses it refuses new activations. New activations require `server_responding=true` and a fresh server ticket. It never falls back to a local quota. |

---

## 3. Envelope: two distinct tokens

### 3.1 CRM JWT (existing)
- `server/auth/session.js` — HS256 or RS256 as configured, `JWT_SECRET` / `JWT_EXPIRY`.
- Valid for the **CRM** (`/api/...` endpoints, including the Mother Company
  dashboard). Never sent to the central license server.
- **NOT** the credential for service-to-service calls to License Server.

### 3.2 License Server tokens (new, distinct)

Service-to-service credential between the CRM (client) and the License Server:

**A. Operator-facing login** (Mother Company → License Server, if the server
exposes operator management):

```
POST /api/licenses/auth/login   { email, password }
Response: { success:true, data: { token, expiresAt } }
```

- Issued only to accounts that hold the server's own role (e.g. `LICENSE_ADMIN`
  / product owner).

**B. Service-to-service, time-bounded, audience-scoped token** (CRM client →
License Server for every `licenses/*` request):

```
Authorization: Bearer <license-server-token>
```

- Issued to the **client** by the License Server after proving the client holds
  a valid license (or a pre-provisioned enrollment).
- **Claims** (all required):
  - `iss` = `https://<license-server-host>/`
  - `aud` = the **fixed audience** the CRM client presents (e.g.
    `blackstack-crm-v2`)
  - `sub` = the CRM client's **own** company id (`company_id` from the CRM
    session)
  - `jti` = unique token id (used for single-use revocation)
  - `scope` = the restricted scopes the client is allowed (e.g.
    `licenses:alloc`, `licenses:activate`)
  - `nbf` / `iat` / `exp` — issued-at, not-before, **short expiry** (e.g. 15
    minutes)
  - `client_ver` = Client token version; the License Server rejects older
    versions.
- Scope list is **not** `['*']`. A CRM operator's `['*']` (the existing CRM
  wildcard) is **dead** for this flow: the License Server derives scope from the
  client's entitlement, not from the CRM's role model.
- Expiry is enforced server-side. The client refreshes the token by logging in
  again (or by a dedicated refresh endpoint, if required) — it never reuses a
  raw CRM JWT.

**C. Service-to-service credential alternative.** If the CRM and License Server
communicate without a browser-facing login flow, the License Server accepts a
**signed, time-bounded token** from a trusted **secret store** (e.g. an
AWS/GCP secret) at startup, and signs the received JWTs; the private key is
rotated quarterly and never mirrors to the client.

**The contract is therefore:**

```
CRM (client)                        License Server
    |  (a) enrollment / login                    |
    |------------------------------------------->|  { token, scopes, exp, client_ver }
    |<------------------------------------------|
    |  (b) client → lic server:  Authorization: Bearer <token>
    |<------------------------------------------|  { ok, license, ticket, ... }
```

**Never:** CRM JWT → License Server.

---

## 4. Code-signing certificate ≠ License-signing key

| Item | Credential | Owner | Where it lives |
|---|---|---|---|
| Windows installer / app `.exe` | **Windows Authenticode certificate** (vendor-provided) | Vendor | Build environment / signing service |
| License entitlements | **License signing key** (`license_private_key`) | Vendor / product owner | **Central license server only** (in memory / HSM / KMS at runtime) |

- The client app gets only the **public key** (`license_public_key`) embedded at
  build time.
- If a license entitlement is invalidated (e.g. revoked), the central server
  issues a **new signed ticket** under a **new signing key**; the client accepts
  the new key via its embedded public key (which is re-provisioned in a
  server-only update). Every signed object carries a **`kid`** = key-id claim so
  the client can select the correct public key when verifying; the server
  maintains a small, ordered key set and **revokes** any compromised key by
  removing it from that set (a `kid` not present in the trusted set is treated
  as revoked).

- **Never** stored in the CRM, **never** shipped to the client app, **never**
  stored in any SQLite file owned by the CRM.

---

## 5. Offline lease, revocation, and clock handling (specification)

### 5.1 Lease model
A license has a **lease** (`lease_days`). The client calculates its allowed
operating window as:

```
lease_valid_until = issue_time + lease_days_days
```

The client presents to the central server a **signed ticket** containing the
license id, device id, **nonce** (one-time-use), and the server-issued `exp`
claim. The server checks the ticket's `exp` against the server's own clock.

### 5.2 When the lease expires
- Local client: **stops accepting new activations**. The service is nevertheless
  **usable for read-only** (list quotas/status). New activation calls are
  rejected with `403 LICENSE_EXPIRED` until a fresh ticket arrives from the
  server.
- Reconnection: on start or when the server becomes reachable, the client runs
  `reconcile`:
  - If `license.status == ACTIVE` and the client's local view is newer → no op.
  - If `license.status == EXPIRED` or `REVOKED` in the server → client **locks the
    license** locally; it cannot re-activate without a server-issued ticket.
- **Server does not unilaterally wipe the client's state.** It records
  `license.status` and `activations.status`; the client honors it.

### 5.3 Clock-change handling — SPEC
- **Wall-clock inspection alone is insufficient.** The client may verify the
  server-issued ticket `exp` against a server-provided `clock` value, but if the
  client's wall clock is wrong, a purely local check will silently accept or
  reject a ticket incorrectly.
- The client **must** detect clock drift by combining three signals:
  1. the **server's final agreed lease**: the server, on issuing or refreshing a
     ticket, includes `lease_valid_until` (server time, `exp`), and requires the
     client to confirm receipt of that window within a single lease period;
  2. **restart-time verification**: after a restart, the client MUST present a
     ticket whose `exp` is still in the future relative to the client's current
     wall clock AND whose `issued_at` (from the server) is within the client's
     last known valid window — this is the authoritative re-sync, and it fails
     open if the client's clock is outside the server's trust window;
  3. any ticket whose server-issued `exp` is **before** the client's present
     wall-clock time (within a small `clock_tolerance`, default 60 s) is a
     **clock-drift signal**, surfaced to the user or operator as
     `SYSTEM_CLOCK_INVALID`.
- Missing server time: if the client cannot obtain a server-issued `clock` or
  `lease_valid_until` (server unreachable at startup), the client **must not**
  trust its own clock. It shows `SERVER_TIME_UNAVAILABLE` and refuses new
  activations until the server reports a valid window. It never falls back to a
  locally computed expiry.
- Clock correction: when the client later reads a valid window from the server
  (or the server re-syncs an expired lease), the client re-enables activations
  and continues. **A longer lease is never granted to cover drift** — a drift is
  always surfaced, not silently absorbed.

### 5.4 Server-side clock policy
- The central license server **rejects** a ticket whose `nbf`/`exp` would place
  the run outside its own configured valid-time window.
- All timestamps in the license database are stored as UTC milliseconds.

### 5.5 Revocation
- `revoke` is a **server-side** action (not a client-side toggle).
- Revocation sets `license.status = REVOKED` and `activations.status = REVOKED`
  (per activation, so a revoked device cannot be re-bound).
- The client is notified by subsequent `reconcile`; the new ticket it receives
  has the revoked state.

---

## 6. Device binding: key-pair, not hardware fingerprint

### 6.1 Device identity
- On first device registration, the **client generates an ECDSA key pair** (or
  Ed25519 — the choice is a configuration, not a protocol bound). The **private
  key stays on the device in an OS-secure store** (Windows DPAPI, macOS Keychain,
  Android Keystore, iOS Secure Enclave).
- **Never** a hardware-fingerprint-only identity. A fingerprint (MAC, NIC, disk
  serial) may be included as **metadata** but never as the cryptographic
  identity.

### 6.2 Binding flow
```
client (device, OS-secure storage)        license server
    |  1. createDeviceKeyPair()               |
    |  2. challengeResponse(challenge)        |  (challenge from server, sign with client private key)
    |  3. publicKey, signature -> POST /api/licenses/:id/bind |
    |------------------------------------------>|  { binding: { id, device_id, public_key, signature } }
    |<------------------------------------------|
```

- Before the public key is registered, the server MUST verify that the client
  holds the corresponding private key (challenge-response for exactly one
  **nonce**). The nonce is single-use: a replay of a challenge signs a stale
  ticket and is rejected.
- Binding is accepted only for an **ACTIVE, non-expired license** at the time
  of request.
- Once bound, the device **presents** its public key alongside its activation
  ticket; the server verifies the signature.

### 6.3 Device change / recovery
- **Device change** (replacement): the customer requests a recovery, the
  licensing admin **rebinds** or **re-activates** under a new device identity;
  the old device's binding is **revoked** server-side.
- **Recovery workflow** (owned by the **licensing customer**, via a support
  channel):
  1. License after-sale provider (license server) claims the device, marks
     `activations.status = RECOVERY_PENDING` with a signed request.
  2. After verification, the license server flips `activations.status =
     RECOVERED` and issues a fresh ticket to the current client.

---

## 7. Agency quota — who controls it, and how

- **Mother Company** sets and republishes the agency's `license_quota` through
  the existing `data/blackstack-crm.db` `agencies` table (or a Phase-2 migration
  that adds a `license_quota` column there). The CRM's existing
  `agency.service.js` records **activations** (`license.activations`) and the
  **allocation is server-side** in the License Server.
- The agency's own administrator may **allocate** only **within** the limit the
  Mother Company has set. The License Server **rejects** any allocation that
  would exceed the quota with `409 QUOTA_EXCEEDED`.
- **Concurrent requests** are handled by a **server-side transaction** that
  atomically checks `allocated < quota` and then increments `allocated`. No race
  can decrement the quota twice. Duplicate requests are rejected (idempotency).
  Re-use the existing `transaction(fn)` contract pattern from
  `server/services/agency.service.js`.
- **Never** decrement the quota on the client side; the client only reads the
  published policy.

---

## 8. Service authentication

- License Server tokens: time-bounded, audience-scoped, **short expiry**
  (default 15 minutes), **not** `['*']`.
- License Server is a **hosted HTTPS service** (HTTPS required). LAN deployment
  is allowed for later phases (optional).
- The CRM client presents its token to the license server; the license server
  verifies the token's signature, `aud`, `exp`, `nbf`, `jti` (single-use), and
  `scope` **before any mutation endpoint**.
- A CRM user's `['*']` permission is **not** a license server credential.
  Distribution endpoints reject it with 403.

---

## 9. Compliance with the list of decisions

| Review item | v2 decision |
|---|---|
| CRM token + License Server token distinct | ✅ Distinct scopes; no CRM JWT forwarded (§3) |
| Code-signing cert + License-signing key distinct | ✅ install cert ≠ license key (§4) |
| Offline lease / revocation defined | ✅ §5 |
| Device binding with private key in secure storage | ✅ §6.1 |
| Agency quota: Mother Company sets, server-side transaction | ✅ §7 |
| Central server hosting | ✅ HTTPS hosted; LAN allowed later |
| Service authentication | ✅ Time-bounded, audience-scoped service tokens (§3/§8) |
| License signing | ✅ Server-side private key (§4) |
| License database separation | ✅ License DB purely separate from CRM (§5) |
| Device identity | ✅ Device-generated key pair; no hardware-fingerprint-only (§6) |
| Idempotency | ✅ All mutation endpoints accept `Idempotency-Key` (§12) |
| Backup | ✅ License DB has its own backup/restore procedure (not in scope for this doc) |
| Billing | ✅ Phase 1 removed billing; separate phase later |

---

## 10. Phase 1 vs Phase 2 boundary

- **Phase 1 (architecture only):** this document — no DB, no schema, no code.
- **Phase 2 (implementation):** central license server repository, HTTP API,
  `license.db`, server-side transaction for allocations, device key-pair
  generation on the client, signed ticket issuance, local lease-policy read,
  revocation/recovery endpoints.
- **Defer:** billing/payment pipeline, statement generation, sub-agency
  hierarchy, device-activation UI inside the dashboard (those belong to a later
  phase once the license server API is live).

---

## 11. Acceptance test list (Phase 2 to implement)

| # | Test | Passes when |
|---|---|---|
| 1 | Service token RFC | CRM presents token with `aud` (host), `scope` restricted; license server rejects with 403 on `['*']` CRM role |
| 2 | Cross-tenant isolation | Session for tenant A cannot read or mutate tenant B's licenses (404, never 403) |
| 3 | Quota transaction | Concurrent allocation requests under the same agency are serialized; quota is never over-allocated |
| 4 | Lease expiry | Client with an expired lease cannot activate; reconnection re-syncs server state |
| 5 | Clock change | Client with wrong clock is rejected with `LICENSE_INVALID_CREDENTIALS`; re-syncs on clock correction |
| 6 | Device binding | ECDSA binding handshake succeeds; client private key never leaves the OS secure storage |
| 7 | Renewal | `POST /api/licenses/:id/renew` issues a new ticket; expired ticket is refused |
| 8 | Revocation | `revoke` sets `status='REVOKED'`; client refuses new activation |
| 9 | Recovery | Recovery workflow returns the bound device to the current client with a fresh ticket |
| 10 | Idempotency | Re-submission of a mutation with the same `Idempotency-Key` returns the same result, no duplicates |
| 11 | Backup/restore | License DB backup → restore → reconciliation against the central server; CRM `audit_logs` untouched |
| 12 | DB separation | No `licenses` rows in `data/blackstack-crm.db`; no CRM table has a new license column |

---

## 12. Summary

| Decision | v2 status |
|---|---|
| CRM JWT + License Server token distinct | ✅ |
| Separate code-signing certificate + license-signing key | ✅ |
| Offline lease + revocation + clock-change spec | ✅ |
| Device binding with key-pair + OS secure storage | ✅ |
| Agency quota: Mother Company sets, server-side transaction | ✅ |
| Hosted service (HTTPS), LAN later | ✅ |
| Server-side license private key | ✅ |
| License DB fully separate | ✅ |
| No billing integration | ✅ |
| No production DB / schema / source changes | ✅ |

Everything above is **design only**. The next step is **implementation** of the
central license server plus the integration tests listed in §11, followed by
certificate/key provisioning, then release-signing and installer verification.
