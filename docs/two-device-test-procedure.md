# TWO-DEVICE SESSION TEST PROCEDURE — BlackStack CRM Desktop

Repeatable procedure for validating multi-device session independence on two
clean Windows machines (physical or VM). Design basis (verified in code, §2/§6
of the handover report): each login creates its own `auth_sessions` row;
normal logout revokes ONLY the calling session; the JWT signing key is
per-install, so the two machines never share token-signing material.

## PREREQUISITES

| Requirement | Detail |
|---|---|
| Two Windows 10/11 x64 machines (or VMs) | Refer to them as **Device A** and **Device B** |
| Signed/test installer | The SAME build on both devices (record version + build hash) |
| Test account | One dedicated account created via the server provisioning flow BEFORE the test; record its username/password in the password manager — **never a real user's account** |
| Network | Both devices can reach the Supabase project (T9 gate must be green first) |
| Evidence folder | A shared folder / repo dir `test-results/two-device-<date>/` for screenshots & logs |

**DO NOT start until:** migration 096 checklist executed on the target project,
live E2E harness (`tests/live-supabase-e2e.js`) exits 0, and the build's
packaged `blackstack.env` contains a REAL anon key.

---

## PROCEDURE

### Phase 0 — Clean install (both devices)
1. Confirm `%APPDATA%\blackstack-crm-v2` does NOT exist (fresh machine). If it
   does (re-test), rename it to `…-pretest` so nothing is inherited.
2. Install the SAME installer build on both devices. Record installer SHA-256.
3. Launch once on each device. Confirm:
   - `session-signing.key` was created in each device's
     `%APPDATA%\blackstack-crm-v2\` (Prove independence later in Step F).
   - No error dialog about configuration; packaged env carried the anon key.

### Phase 1 — Simultaneous login (expectation: BOTH succeed independently)
| # | Step | Expected outcome | Evidence |
|---|---|---|---|
| 1.1 | Log in on Device A with the test account | Login succeeds; CRM dashboard renders | screenshot A-1 |
| 1.2 | WITHOUT logging out A, log in on Device B with the SAME account | Login ALSO succeeds — concurrent sessions are supported by design | screenshot B-1 |
| 1.3 | On each device run the app's status/profile fetch (or any authenticated page) | Both return the SAME user identity | screenshot A-2, B-2 |

### Phase 2 — Logout isolation (the core isolation requirement)
| # | Step | Expected outcome | Evidence |
|---|---|---|---|
| 2.1 | Log out on Device A ONLY | A returns to the login screen; localStorage `crm_token` cleared | screenshot A-3 |
| 2.2 | On Device B, click ANY authenticated page / press F5 to issue a request | **B REMAINS AUTHENTICATED** — no 401, no redirect to login | screenshot B-3 |
| 2.3 | Wait 60s on B and interact again | Still authenticated (proves it wasn't a timing fluke) | screenshot B-4 |

### Phase 3 — Restart session restoration (Device B)
| # | Step | Expected outcome | Evidence |
|---|---|---|---|
| 3.1 | Fully quit the app on Device B (close window, confirm process exit) | — | — |
| 3.2 | Relaunch the app on Device B | Session restored automatically from persisted localStorage token; dashboard renders WITHOUT re-login | screenshot B-5 |
| 3.3 | Restart Device A and attempt login | Normal login flow works (per-install JWT key persisted — the restart must NOT have regenerated it and invalidated sessions) | screenshot A-4 |

### Phase 4 — Token refresh independence
| # | Step | Expected outcome | Evidence |
|---|---|---|---|
| 4.1 | On Device B, trigger the app's token-refresh path (natural expiry or forced refresh) | New access token issued for B only | screenshot B-6 |
| 4.2 | Confirm Device A (logged back in per 3.3) still functions | Refresh on B must not disturb A's session | screenshot A-5 |

### Phase 5 — Normal logout must NOT be a global logout | Expected outcome | Evidence |
|---|---|---|---|
| 5.1 | With BOTH devices authenticated again, log out on Device B | B logs out; A unaffected (still on dashboard) | screenshot A-6, B-7 |

### Phase 6 — Global Logout (feature-gated; may be SKIP)
| # | Step | Expected outcome | Evidence |
|---|---|---|---|
| 6.1 | Check if a "Revoke all sessions"/"Global logout" control exists in the build (admin/storage flows only per §6 of the audit) | If absent: mark TEST 6 **SKIP — not implemented (documented as optional)** | note |
| 6.2 | If present: trigger it from Device A | BOTH devices forced to re-login on next request | screenshots |

### Phase 7 — Per-install secret independence (forensic proof)
| # | Step | Expected outcome | Evidence |
|---|---|---|---|
| 7.1 | On EACH device run in PowerShell:<br>`icacls "$env:APPDATA\blackstack-crm-v2\session-signing.key"` and record file size + first 8 chars of a `Get-FileHash` | Files exist with owner-only ACL `(I)` absent; hashes DIFFER between devices | terminal captures |
| 7.2 | Confirm no secret appears in any packaged file:<br>scan the installer/resources dir for `session-signing` and `JWT_SECRET=` | Zero hits | terminal capture |

---

## PASS CRITERIA (all must hold)

- P1: Both devices logged in simultaneously (1.2).
- P2: Device A logout did NOT terminate Device B (2.2, 2.3).
- P3: Device restart restored a valid session without re-login (3.2).
- P4: Token refresh on one device did not affect the other (4.2).
- P5: Normal logout is per-session, never global (5.1).
- P6: Global Logout, IF implemented, revokes all sessions (6.2) — or SKIP.
- P7: Each device's signing key is independent and owner-only (7.1).

## RESULT RECORD TEMPLATE

```
Run date:            ______  Installer build: ______ (sha256 ______)
Device A (model/OS): ______            Device B: ______
P1 [PASS/FAIL]  P2 [PASS/FAIL]  P3 [PASS/FAIL]  P4 [PASS/FAIL]
P5 [PASS/FAIL]  P6 [PASS/SKIP-NOT-IMPLEMENTED/FAIL]  P7 [PASS/FAIL]
Tester: ______   Evidence folder: test-results/two-device-<date>/
Overall: VERIFIED / NOT VERIFIED (any FAIL or missing evidence → NOT VERIFIED)
```
