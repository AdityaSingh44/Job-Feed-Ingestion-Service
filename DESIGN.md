# System Design: Reliable Job-Feed Ingestion Service

## 1. Executive Summary & Core Invariants

The Job-Feed Ingestion Service is built to asynchronously ingest, validate, verify, and project high-volume job listing events while guaranteeing correctness under arbitrary worker crashes, concurrent arrivals, network retries, and out-of-order event delivery.

### Fundamental Invariants
1. **Durable Acceptance Before Acknowledgment**: HTTP `202 Accepted` is returned if and only if the event is durably committed to the `events` collection with an immutable canonical content hash and unique identity constraint.
2. **Replay & Conflict Invariant**:
   - Re-submitting an identical event identity `(tenantId, sourceId, eventId)` with matching JSON content returns HTTP `200 OK` and produces **zero** duplicate work items.
   - Submitting an existing event identity with different content returns HTTP `409 Conflict`.
   - Invalid requests return HTTP `400 Bad Request` and never reserve the event identity (corrected submissions can reuse the ID).
3. **Monotonic Version State (Highest Version Wins)**:
   - For any job `(tenantId, sourceId, externalJobId)`, the current projection reflects the **greatest successfully processed version**, regardless of arrival sequence or worker completion order.
   - Lower or equivalent versions can never overwrite a newer version.
   - An archive operation produces a versioned tombstone (`status: "archived"` with `currentVersion`), preventing delayed older upserts from resurrecting a deleted job.
   - Archives arriving prior to any upsert safely establish a tombstone.
4. **Tenant & Source Isolation**:
   - Jobs and events are strictly partitioned by `(tenantId, sourceId)`. Identical identifiers across different tenants or sources represent completely independent entities.
5. **Durable Worker Recovery**:
   - Workers compete using atomic MongoDB lease claims (`claimExpiresAt`). If a worker crashes or abandons a lease, competing workers safely recover the work item without data loss or duplicate projections.
6. **External Verification Isolation**:
   - External verification failures (422, 429, 503) never corrupt or alter the existing job projection. Retries are capped at 3 attempts with exponential backoff before transitioning to terminal `failed` status. Stale events skip external verification as a no-op.

---

## 2. Work Lifecycle & State Machine

Every incoming event moves through a well-defined state machine:

```
                  POST /events
                       │
             ┌─────────┴─────────┐
      [Invalid: 400]       [Valid Input]
     (No ID reserved)            │
                     ┌───────────┴───────────┐
             [Event Exists?]            [New Event]
              /            \                 │
      (Same Hash)     (Diff Hash)      Insert to DB (pending)
           │               │                 │
      [Return 200]    [Return 409]      [Return 202]
                                             │
                                   ┌─────────┴─────────┐
                                   │ Worker Claim Loop │
                                   └─────────┬─────────┘
                                             │
                                   Status: processing
                                   Lease: claimExpiresAt
                                             │
                                    Is Event Stale?
                                    (job.version >= event.version)
                                     /              \
                                   (Yes)            (No)
                                   /                  \
                        Mark completed             Run Provider
                        (stale_skipped)             Verification
                                                     /         \
                                                (Success)   (Failure)
                                                    │           │
                                              Atomic Mongo  422 -> terminal failed
                                              Job Pipeline  429/503 -> retry with backoff
                                              Upsert/Update (attempt < 3: pending, else failed)
                                                    │
                                              Mark Event
                                              Status: completed
```

### Event Status Transitions:
- `pending`: Ready to be claimed by a worker loop once `nextAttemptAt <= now`.
- `processing`: Atomically leased by a worker instance until `claimExpiresAt`.
- `completed`: Successfully applied to the job projection, or safely skipped as a stale version.
- `failed`: Terminal failure due to an unprocessable entity (HTTP 422) or retry exhaustion (3 attempts) on transient errors (HTTP 429 / 503).

---

## 3. Data Model & Index Choices

The system uses two core MongoDB collections: `events` and `jobs`.

### A. Collection: `events`
Stores every accepted event, its canonical content signature, lease status, and complete retry attempt history.

```typescript
interface EventDocument {
  _id: ObjectId;
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: 'upsert' | 'archive';
  payload?: NormalizedJobPayload;
  contentHash: string; // SHA-256 of canonicalized JSON
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'stale_skipped';
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  attemptHistory: Array<{
    attemptNumber: number;
    timestamp: Date;
    status: string;
    statusCode?: number;
    error?: string;
  }>;
  claimWorkerId: string | null;
  claimExpiresAt: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}
```

#### Indexes on `events`:
1. `UNIQUE { tenantId: 1, sourceId: 1, eventId: 1 }`:
   - Enforces event uniqueness per tenant and source.
   - Backs atomic replay detection and conflict prevention.
2. `COMPOUND { status: 1, nextAttemptAt: 1, claimExpiresAt: 1 }`:
   - Powers the high-throughput worker claim query. Allows workers to quickly fetch pending items or claim expired leases using index scans without collection scans.
3. `COMPOUND { tenantId: 1, sourceId: 1, externalJobId: 1, version: 1 }`:
   - Optimizes auditing and debugging of event timelines for any given job.

### B. Collection: `jobs`
Stores the current materialized projection of each job listing.

```typescript
interface JobDocument {
  _id: ObjectId;
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  currentVersion: number;
  status: 'active' | 'archived';
  title?: string;
  company?: string;
  location?: string;
  experienceMin?: number;
  experienceMax?: number;
  applyUrl?: string;
  skills: string[];
  lastAppliedEventId: string;
  createdAt: Date;
  updatedAt: Date;
}
```

#### Indexes on `jobs`:
1. `UNIQUE { tenantId: 1, sourceId: 1, externalJobId: 1 }`:
   - Guarantees one single canonical document per job identity.
2. `COMPOUND { tenantId: 1, status: 1, _id: 1 }`:
   - Backs deterministic, fast cursor-based pagination for `GET /jobs?tenantId=...&status=active`.
3. `COMPOUND { tenantId: 1, sourceId: 1, status: 1, _id: 1 }`:
   - Backs source-filtered deterministic cursor pagination.

---

## 4. Atomicity Boundaries & Concurrency

### 1. Ingestion Atomicity (POST /events)
- The ingestion handler canonicalizes the JSON payload (key-sorted, preserved array order) and computes a SHA-256 hash.
- An atomic `insertOne` is executed against the `events` collection.
- If `E11000 DuplicateKey` is caught on `(tenantId, sourceId, eventId)`:
  - The handler reads the existing event.
  - If `existing.contentHash === incomingHash`: Returns `200 OK` (Replay safety).
  - Else: Returns `409 Conflict`.
- Because the write happens before HTTP 202 is dispatched, crashes right after response return will not lose work.

### 2. Worker Claim Atomicity
- Competing worker processes or loops execute an atomic `findOneAndUpdate`:
  ```typescript
  const claim = await events.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'processing', claimExpiresAt: { $lte: now } } // Lease recovery!
      ]
    },
    {
      $set: {
        status: 'processing',
        claimWorkerId: workerId,
        claimExpiresAt: new Date(now.getTime() + leaseDurationMs),
        updatedAt: now
      },
      $inc: { attemptCount: 1 }
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' }
  );
  ```
- This guarantees mutually exclusive work assignment with zero double-processing under normal operations, and automatic recovery if a worker dies without in-process memory dependencies.

### 3. Projection Update Atomicity (MongoDB Pipeline Update)
To prevent race conditions when multiple workers process out-of-order versions concurrently (e.g. Worker A processing v2 finishes after Worker B processing v3), we execute a conditional update using a MongoDB aggregation update pipeline with `upsert: true`:
```typescript
await jobs.updateOne(
  { tenantId: event.tenantId, sourceId: event.sourceId, externalJobId: event.externalJobId },
  [
    {
      $set: {
        tenantId: event.tenantId,
        sourceId: event.sourceId,
        externalJobId: event.externalJobId,
        status: {
          $cond: [
            { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
            event.operation === 'archive' ? 'archived' : 'active',
            '$status'
          ]
        },
        currentVersion: {
          $cond: [
            { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
            event.version,
            '$currentVersion'
          ]
        },
        title: {
          $cond: [
            {
              $and: [
                { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
                { $eq: [event.operation, 'upsert'] }
              ]
            },
            event.payload.title,
            '$title'
          ]
        },
        // Same conditional guard applied for company, location, experienceMin/Max, applyUrl, skills
        lastAppliedEventId: {
          $cond: [
            { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
            event.eventId,
            '$lastAppliedEventId'
          ]
        },
        updatedAt: now,
        createdAt: { $ifNull: ['$createdAt', now] }
      }
    }
  ],
  { upsert: true }
);
```
**Why this is invariant-safe**:
- Regardless of delivery order, a lower version will evaluate `event.version > $currentVersion` to `false`, leaving all job fields untouched.
- An archive at version 5 will set `status: 'archived'` and `currentVersion: 5`. A delayed upsert at version 4 cannot overwrite it.
- An archive arriving before any upsert initializes the document with `currentVersion` set to the archive version, establishing a durable tombstone.

---

## 5. Independent Failure Analysis

| Failure Point | System State | Consequence & Recovery |
| :--- | :--- | :--- |
| **Acceptance Fails** (Network drop / process death before DB insert) | Client receives 500 or timeout; DB has no record. | Client retries. Safe because `(tenantId, sourceId, eventId)` has not been reserved. |
| **Acceptance Succeeds, but Ack drops** (DB insert commits, client disconnects before receiving 202) | Event exists in DB with `status: pending`. | Client retries exact same request. System finds identical hash, returns `200 OK`. Event processes normally in background. |
| **Provider Verification Fails** (429 or 503 from external service) | Event status updated to `pending`, `nextAttemptAt` calculated via backoff. | Job projection is completely untouched. Subsequent attempt re-verifies. If 3 attempts exhausted, status becomes `failed`. |
| **Provider Verification Fails Permanently** (422) | Event status updated to `failed`, attempt history recorded. | Terminal failure. No retries scheduled. Job projection remains untouched. |
| **Projection Write Succeeds, Worker Crashes Before Acking Work** | Job projection updated to new version. Event still in `status: processing` with `claimExpiresAt`. | Lease expires. Another worker re-claims event. Re-execution runs pipeline update (or detects stale version); pipeline is idempotent and no-op. Event is marked `completed`. Zero duplicate jobs. |

### Crashed Worker Attempt Consumption Policy
When a worker crashes unexpectedly while holding a lease:
- The crashed worker incremented `attemptCount` upon claiming the lease.
- In our design, **crashed lease expiration does consume an attempt counter**, but allows a grace retry if configured. Consuming the attempt protects the system from "poison pill" payloads that crash the Node.js process (e.g., out-of-memory or V8 fatal errors). If the payload repeatedly causes fatal process termination, it will exhaust its attempts after 3 crashes and transition to terminal `failed`, preventing an infinite crash-loop that halts the worker cluster.

---

## 6. Alternatives Rejected

### Alternative 1: In-Memory / Redis Queue (e.g. BullMQ)
- **Description**: Putting incoming event IDs into a Redis queue or BullMQ and having workers pop from Redis.
- **Why Rejected**:
  1. Violates the core assignment constraint forbidding external queue dependencies in the runnable core.
  2. Introduces a two-phase commit problem between Redis queue acknowledgment and MongoDB event persistence. If Redis crashes or desynchronizes from MongoDB, events can be orphaned or lost.
  3. MongoDB atomic `findOneAndUpdate` with lease timeouts natively provides durable queue semantics without external infrastructure.

### Alternative 2: Optimistic Version Checking via Two Sequential DB Operations (`findOne` then `updateOne`)
- **Description**: Worker queries `jobs.findOne({ tenantId, sourceId, externalJobId })`, checks if `job.currentVersion < event.version` in JavaScript memory, and then runs `jobs.updateOne(...)`.
- **Why Rejected**:
  1. Highly vulnerable to race conditions under concurrent workers. If two workers process version 2 and version 3 in parallel, Worker 3 could read `currentVersion: 1`, Worker 2 could read `currentVersion: 1`, Worker 3 writes version 3, and then Worker 2 overwrites with version 2!
  2. Requires distributed locking (e.g. redlock or MongoDB document-level pessimistic locks), adding latency and deadlocks.
  3. Using MongoDB's atomic aggregation update pipeline executes the comparison and update inside a single database atomic write, completely eliminating version race conditions.

### Alternative 3: Soft-Deleting Events on Completion
- **Description**: Deleting completed events from the database or removing payload data immediately.
- **Why Rejected**:
  1. Prevents duplicate replay checks (`GET /events/:eventId` or `POST /events` replay safety) from verifying historical submissions.
  2. Loses auditability and attempt history.
  3. Retention is instead handled cleanly via rolling TTL / archival partitions without compromising replay invariants.

---

## 7. Bottlenecks & Deliberate Tradeoffs

### First Likely Bottleneck
- **The Worker Claim Poll Loop**: As the number of concurrent workers scales to dozens or hundreds, multiple workers polling the `events` collection with `findOneAndUpdate` on `{ status: 'pending', nextAttemptAt: { $lte: now } }` will contend on the index leaf pages, creating write contention on the collection lock.
- **Mitigation at Scale**: In `SCALE.md`, we transition high-throughput leasing to partitioned worker shards or Change Streams (`watch()`), where workers subscribe to insert change events rather than polling.

### Deliberate Tradeoff Accepted
- **In-Database Work Queue vs Dedicated Log Broker**:
  - We accepted MongoDB-backed polling with lease claims over Kafka/RabbitMQ.
  - *Tradeoff*: Slightly lower peak ingestion throughput compared to an append-only Kafka commit log, but dramatically simpler operational footprint, absolute single-database transactional consistency, zero cross-system distributed coordination, and complete compliance with local environment constraints.

---

## 8. Production Authentication & Tenant Authorization
In this exercise, `tenantId` is accepted as trusted input for demo simplicity. In production:
1. **Authentication**: All API requests require a cryptographically signed JSON Web Token (JWT) or Mutual TLS certificate issued by the identity provider (e.g., Auth0 / Okta / GCP IAM).
2. **Tenant Authorization**: The API gateway validates the token and extracts the verified tenant claim (`sub` or `tenant_id`). The incoming URL/body `tenantId` is strictly asserted against the token's authenticated tenant. Requests attempting cross-tenant access receive HTTP `403 Forbidden`.
3. **Source Scoping**: API keys or OAuth clients are scoped to authorized source feeds (e.g. `main`, `greenhouse`, `workday`), preventing unauthorized sources from injecting events.
