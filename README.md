# Reliable Job-Feed Ingestion Service

[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-7.0-brightgreen.svg)](https://www.mongodb.com/)
[![Tests](https://img.shields.io/badge/Vitest-18%2F18%20Passed-success.svg)](https://vitest.dev/)
[![License](https://img.shields.io/badge/License-MIT-lightgrey.svg)](LICENSE)

A production-grade, asynchronous job-feed ingestion service built with **Node.js 22**, **TypeScript (Strict Checking)**, and **MongoDB**. Designed from first principles to guarantee correctness, version monotonicity, tenant isolation, and crash resilience under high concurrency and arbitrary network failures.

---

## Key Guarantees & Invariants

1. **Durable Acceptance Before Acknowledgment**:
   Returns HTTP `202 Accepted` only after persisting the event into durable storage. Work items are never lost if the API process restarts immediately after acceptance.
2. **Deterministic Replay Safety & Conflict Prevention**:
   - Re-submitting an identical event identity `(tenantId, sourceId, eventId)` with matching JSON content returns HTTP `200 OK` without creating duplicate work items.
   - Reusing that event identity with modified content returns HTTP `409 Conflict`.
   - Invalid submissions return HTTP `400 Bad Request` and never reserve the event identity.
3. **Monotonic Version Projections (Highest Version Wins)**:
   - For any job `(tenantId, sourceId, externalJobId)`, the current projection always reflects the **greatest successfully processed version**, regardless of delivery sequence or worker execution order.
   - Lower or equivalent versions skip external verification and finish as no-ops.
   - Versioned archive tombstones prevent delayed stale upserts from resurrecting deleted listings.
   - Archives arriving before any upsert successfully establish a tombstone.
4. **Tenant & Source Isolation**:
   Matching IDs in different tenants or sources are strictly partitioned and treated as independent entities.
5. **Durable Background Recovery**:
   Multiple worker loops compete for work using atomic lease claims (`claimExpiresAt`). Abandoned or crashed worker leases are recovered automatically by peer workers with zero data loss or duplicate projections.
6. **External Verification Isolation & Retries**:
   Simulated external verification step evaluates `fixtures/provider-plan.json`. Transient errors (HTTP 429, 503) trigger exponential backoff up to 3 attempts. Permanent failures (HTTP 422) transition to terminal `failed` state immediately. Failed verifications never alter existing job projections.

---

## Architecture Overview

```
                                  Client Request
                                        │
                                        ▼
                                 [POST /events]
                                        │
                         ┌──────────────┴──────────────┐
                   [Valid Input?]                [Invalid] ──> 400 Bad Request
                         │
             ┌───────────┴───────────┐
     [Event Exists?]            [New Event]
      /           \                  │
(Same Hash)   (Diff Hash)      Insert to DB (status: pending)
    │              │                 │
[200 OK]     [409 Conflict]    [202 Accepted]
                                     │
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
             [Worker Loop 1]                 [Worker Loop 2]
         (Atomic Lease Claim)            (Atomic Lease Claim)
                     │                               │
            Is Event Stale?                  Is Event Stale?
              /           \                    /           \
           (Yes)          (No)              (Yes)          (No)
            /               \                /               \
       Skip to         Provider         Skip to         Provider
      Completed      Verification      Completed      Verification
                     (422/429/503)                    (422/429/503)
                           │                                │
                      Atomic Mongo                     Atomic Mongo
                    Pipeline Update                  Pipeline Update
                           │                                │
                       Completed                        Completed
```

---

## Documentation Deliverables

- **[DESIGN.md](./DESIGN.md)**: Invariants, work lifecycle, atomicity boundaries, data models, index designs, independent failure modes, rejected alternatives, and deliberate tradeoffs.
- **[SCALE.md](./SCALE.md)**: Quantitative scaling model from 100k to 10M events/day, 5,000 events/sec burst sustainability, storage & index RAM sizing, partition/sharding strategy, and load test benchmarks.
- **[DEMO.md](./DEMO.md)**: Detailed phase-by-phase execution guide for the 20-request scenario with expected inputs, HTTP responses, and settled states.
- **[AI_USAGE.md](./AI_USAGE.md)**: AI collaboration log, prompts, accepted changes, human review, and verification evidence.
- **[QC_REPORT.md](./QC_REPORT.md)**: Post-generation Quality Control audit, failure hypothesis testing, and SHA traceability.

---

## Getting Started

### 1. Prerequisites
- **Node.js 22.x** or higher
- **npm** 10.x or higher
- (Optional) Docker & Docker Compose

### 2. Local Setup
Clone the repository and install dependencies:
```bash
git clone <repo-url>
cd job-feed-ingestion
npm install
```

### 3. Running with Docker Compose (Recommended for Production Setup)
```bash
docker compose up --build -d
```
This launches:
- MongoDB 7.0 replica/container on `localhost:27017`
- Ingestion Service and Worker Pool on `http://localhost:3000`

### 4. Running Locally in Standalone Dev Mode
If running without Docker, the service automatically detects that no external MongoDB is running and starts an embedded real MongoDB instance:
```bash
npm run dev
```

---

## Executing Demo and Verification Scripts

### Run the Official 20-Request Scenario
Executes Phase 1 (17 requests), waits for queue drainage, executes Phase 2 (3 delayed requests), waits for drainage, and verifies all 8 invariant assertions:
```bash
npm run demo
```

### Run the Vitest Test Suite (18 Integration Checks)
Executes all unit, concurrency, crash recovery, and pagination tests against real MongoDB:
```bash
npm test
```

### Run the Reproducible Load Test (1,200 Requests)
Dispatches 1,000 distinct events + 200 replays + 60 out-of-order version jobs under concurrency 20:
```bash
npm run load-test
```

---

## API Endpoints Reference

### 1. Ingest Event
`POST /events`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
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
  }
  ```
- **Responses**:
  - `202 Accepted`: Event accepted and durably queued.
  - `200 OK`: Duplicate submission replayed safely with no second work item.
  - `409 Conflict`: Reusing event ID with conflicting payload.
  - `400 Bad Request`: Validation failure.

### 2. Query Jobs (Tenant-Scoped with Deterministic Cursor Pagination)
`GET /jobs?tenantId=...&sourceId=...&status=active&limit=20&cursor=...`
- `tenantId` (required): Scope query to tenant.
- `sourceId` (optional): Filter by source feed.
- `status` (optional): `active` (default), `archived`, or `all`.
- `limit` (optional): Items per page (capped at 100).
- `cursor` (optional): Base64 encoded cursor for pagination.

### 3. Query Event Status
`GET /events/:eventId?tenantId=...&sourceId=...`
- Returns event status (`pending`, `processing`, `completed`, `failed`), attempt count, and complete attempt history.

### 4. Health Readiness Check
`GET /health`
- Returns readiness status of the HTTP service, MongoDB database connection, and worker pool.
