# Interactive Demo & Verification Guide (DEMO.md)

This document provides exact step-by-step instructions to execute the official 20-request demo scenario, verify out-of-order versioning, observe crash recovery, and run the reproducible load test.

---

## 1. Quick Start Commands

### Prerequisites
- Node.js 22.x or newer
- (Optional) Docker & Docker Compose if using external MongoDB (an embedded real MongoDB instance starts automatically if Docker/MongoDB is not running).

### Setup Command
```bash
npm install
```

### Official Demo Command
```bash
npm run demo
```

### Official Test Suite (Vitest)
```bash
npm test
```

### Official Load Test Suite
```bash
npm run load-test
```

### Web UI Dashboard & Interactive Control Center
```bash
npm run dev
# Open browser at http://localhost:3000
```

---

## 2. Official Demo Scenario Walkthrough

The demo script (`scripts/demo.ts`) executes the 20-request fixture (`fixtures/demo-scenario.json`) in two distinct phases:

### Phase 1: 17 Requests in Strict Fixture Order
1. **`req-01`**: Valid upsert `alpha` v1 $\rightarrow$ **HTTP 202 Accepted**.
2. **`req-02`**: Replay safety test: identical JSON payload with scrambled key order $\rightarrow$ **HTTP 200 OK** (zero duplicate work created).
3. **`req-03`**: Conflicting reuse test: reusing `event-alpha-v1` with altered title $\rightarrow$ **HTTP 409 Conflict**.
4. **`req-04`**: Identifier validation: leading/trailing whitespace in `tenantId` $\rightarrow$ **HTTP 400 Bad Request** (ID not reserved).
5. **`req-05`**: Corrected request: reusing rejected `event-rejected-01` with valid syntax $\rightarrow$ **HTTP 202 Accepted**.
6. **`req-06`**: Version validation: `version: 0` $\rightarrow$ **HTTP 400 Bad Request**.
7. **`req-07`**: Experience validation: `min > max` ($8 > 3$) $\rightarrow$ **HTTP 400 Bad Request**.
8. **`req-08`**: Protocol validation: insecure HTTP URL $\rightarrow$ **HTTP 400 Bad Request**.
9. **`req-09`**: Tenant isolation: same `externalJobId: "alpha"` and same `eventId` under `tenant-b` $\rightarrow$ **HTTP 202 Accepted** (independent job in `tenant-b`).
10. **`req-10`**: Source isolation: same `externalJobId: "alpha"` under `sourceId: "partner"` $\rightarrow$ **HTTP 202 Accepted** (independent job in partner source).
11. **`req-11`**: Out-of-order arrival: `beta` v3 arrives first $\rightarrow$ **HTTP 202 Accepted** (settled at v3).
12. **`req-12`**: Delayed stale update: `beta` v2 arrives after v3 $\rightarrow$ **HTTP 202 Accepted** (skipped as stale, `beta` remains at v3).
13. **`req-13`**: Archive-before-upsert: `gamma` v2 archive arrives before any upsert $\rightarrow$ **HTTP 202 Accepted** (creates archived tombstone at v2).
14. **`req-14`**: Delayed stale upsert: `gamma` v1 upsert arrives after v2 archive $\rightarrow$ **HTTP 202 Accepted** (skipped as stale, does NOT resurrect job).
15. **`req-15`**: Provider transient retry: `delta` v1 fails attempt 1 with 503, retries attempt 2 $\rightarrow$ **HTTP 202 Accepted** (settled active v1, attempts: 2).
16. **`req-16`**: Provider permanent failure 422: `epsilon` v1 rejected permanently $\rightarrow$ **HTTP 202 Accepted** (event status `failed`, zero job projection created).
17. **`req-17`**: Provider retry exhaustion: `zeta` v1 fails 3 attempts with 429 $\rightarrow$ **HTTP 202 Accepted** (event status `failed`, zero job projection created).

*Phase 1 Draining: Background worker pool drains all 17 events.*

### Phase 2: 3 Delayed Requests
18. **`req-18`**: Archive reactivation: `gamma` v3 upsert arrives after v2 archive $\rightarrow$ **HTTP 202 Accepted** (reactivates `gamma` to `active` at v3!).
19. **`req-19`**: Version advancement: `alpha` v2 upsert updates `alpha` from v1 to v2 $\rightarrow$ **HTTP 202 Accepted**.
20. **`req-20`**: Stale archive: `alpha` v1 archive arrives after v2 upsert $\rightarrow$ **HTTP 202 Accepted** (skipped as stale, `alpha` remains active v2!).

*Phase 2 Draining: Background worker pool drains remaining events.*

---

## 3. Expected Demo Console Output

```text
================================================================
   RELIABLE JOB-FEED INGESTION SERVICE - OFFICIAL DEMO SCENARIO  
================================================================

[Setup] Initializing MongoDB and worker pool for demo run...
[Database] Connected successfully to jobfeed
[WorkerPool] Started 2 competing worker loops
[Setup] Standalone test server running on http://127.0.0.1:3999

----------------------------------------------------------------
>>> SUBMITTING PHASE 1: 17 Requests in Fixture Order
----------------------------------------------------------------
  [req-01] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Valid upsert alpha v1
  [req-02] (Phase 1) HTTP 200 [Expected 200] - ✓ PASS: Replay safety: Exact duplicate of req-01
  [req-03] (Phase 1) HTTP 409 [Expected 409] - ✓ PASS: Conflict: Reusing event-alpha-v1 with different content
  [req-04] (Phase 1) HTTP 400 [Expected 400] - ✓ PASS: Validation failure: Surrounding whitespace in tenantId
  [req-05] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Corrected reuse of rejected eventId from req-04
  [req-06] (Phase 1) HTTP 400 [Expected 400] - ✓ PASS: Validation failure: Zero version (must be positive integer)
  [req-07] (Phase 1) HTTP 400 [Expected 400] - ✓ PASS: Validation failure: experienceMin greater than experienceMax
  [req-08] (Phase 1) HTTP 400 [Expected 400] - ✓ PASS: Validation failure: Insecure HTTP URL (must use HTTPS)
  [req-09] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Tenant isolation: Same externalJobId and eventId under tenant-b
  [req-10] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Source isolation: Same tenant-a and externalJobId alpha under partner source
  [req-11] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Out-of-order versioning: Job beta v3 arrives before v2
  [req-12] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Delayed stale update: Job beta v2 arrives after v3 (should skip as stale)
  [req-13] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Archive before upsert: Job gamma v2 archive arrives before any upsert
  [req-14] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Delayed upsert for gamma: v1 upsert arrives after v2 archive (must NOT resurrect job)
  [req-15] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Provider failure with retry success: delta v1 fails attempt 1 (503), succeeds attempt 2
  [req-16] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Provider permanent failure 422: epsilon v1 rejected permanently without retry
  [req-17] (Phase 1) HTTP 202 [Expected 202] - ✓ PASS: Provider retry exhaustion: zeta v1 receives 429 across 3 attempts, ending in terminal failed

[Phase 1] Waiting for background workers to drain and settle...
[Phase 1] Worker drain completed (drained: true).

----------------------------------------------------------------
>>> SUBMITTING PHASE 2: 3 Delayed Requests in Fixture Order
----------------------------------------------------------------
  [req-18] (Phase 2) HTTP 202 [Expected 202] - ✓ PASS: Archive reactivation: Job gamma v3 upsert arrives after v2 archive, reactivating the job
  [req-19] (Phase 2) HTTP 202 [Expected 202] - ✓ PASS: Standard version advance: alpha v2 upsert updates alpha from v1 to v2
  [req-20] (Phase 2) HTTP 202 [Expected 202] - ✓ PASS: Stale archive: alpha v1 archive arrives after v2 upsert (should be ignored as stale)

[Phase 2] Waiting for background workers to drain and settle...
[Phase 2] Worker drain completed (drained: true).

----------------------------------------------------------------
>>> VERIFYING SETTLED JOB AND EVENT PROJECTIONS
----------------------------------------------------------------
  ✓ PASS: Job alpha: version advanced to 2, status active (Version: 2, Status: active)
  ✓ PASS: Tenant isolation: job alpha in tenant-b is distinct from tenant-a (Tenant: tenant-b, Company: Tenant B Corp)
  ✓ PASS: Source isolation: job alpha under source partner is distinct from main (Source: partner, Company: Partner Agency)
  ✓ PASS: Out-of-order: beta settled at version 3; version 2 was skipped as stale (Beta Version: 3, Title: "Principal Architect V3", V2 Event Status: completed)
  ✓ PASS: Archive tombstone & reactivation: gamma settled at v3 active; v1 was prevented from reactivating v2 archive (Gamma Version: 3, Status: active)
  ✓ PASS: Provider retry: delta succeeded on attempt 2 after transient 503 (Delta Job Status: active, Attempts: 2)
  ✓ PASS: Permanent 422 failure: epsilon terminal failed, zero job projection created (Job Exists: false, Event Status: failed)
  ✓ PASS: Retry exhaustion: zeta terminal failed after 3 attempts, zero job projection created (Job Exists: false, Event Status: failed, Attempts: 3)

================================================================
DEMO EXECUTION COMPLETE: ALL CHECKS PASSED (20/20 HTTP, 8/8 INVARIANTS)
================================================================
```

---

## 4. Manual API Verification (cURL Examples)

### Submit an Upsert Event
```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "tenant-a",
    "sourceId": "main",
    "eventId": "event-101",
    "externalJobId": "alpha",
    "version": 1,
    "operation": "upsert",
    "payload": {
      "title": "Full Stack Developer",
      "company": "Example Labs",
      "location": "Surat",
      "experienceMin": 1,
      "experienceMax": 3,
      "applyUrl": "https://example.test/jobs/alpha",
      "skills": [" TypeScript ", "MongoDB", "typescript"]
    }
  }'
```
*Expected Response: HTTP 202 Accepted*

### Re-submitting Identical Event (Replay Check)
```bash
# Same command as above
```
*Expected Response: HTTP 200 OK*

### Query Jobs (Deterministic Cursor Pagination)
```bash
curl "http://localhost:3000/jobs?tenantId=tenant-a&status=active&limit=10"
```

### Check Event Processing State & Attempt History
```bash
curl "http://localhost:3000/events/event-101?tenantId=tenant-a&sourceId=main"
```

### Service Health Check
```bash
curl http://localhost:3000/health
```
