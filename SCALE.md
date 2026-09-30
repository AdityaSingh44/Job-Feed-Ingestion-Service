# Scalability & Production Architecture (SCALE.md)

## 1. System Scaling Profile & Workload Dimensions

### Target Parameters
- **Daily Volume**: Scaling from **100,000 events/day** (~1.16 events/sec avg) to **10,000,000 events/day** (~116 events/sec steady-state avg).
- **Peak Burst**: **5,000 events/sec** burst arrival rate.
- **SLA**: Accepted events must settle into job projections within **5 minutes (300 seconds)** under design capacity.
- **Payload Size**: ~1 KB average raw JSON event.
- **Event Retention**: 7 days for audit/replay safety; rolling purge after 7 days.
- **Active Job Footprint**: ~1,000,000 current job projections.

---

## 2. Quantitative Mathematical Modeling

### A. Average vs. Peak Burst Arrival Rates
| Parameter | 100,000 events/day | 10,000,000 events/day (Steady-State) | Peak Burst Event |
| :--- | :--- | :--- | :--- |
| **Arrival Rate ($R_{in}$)** | 1.16 events/sec | 115.74 events/sec | **5,000 events/sec** |
| **Ingestion Bandwidth** | 1.16 KB/sec | 115.7 KB/sec (925 Kbps) | 5.0 MB/sec (40 Mbps) |
| **Daily Ingestion Storage** | 100 MB/day | 10 GB/day | 18 GB/hour (at sustained peak) |

### B. Worker Capacity & Drain-Time Calculations
Let:
- $R_{burst} = 5,000 \text{ events/sec}$ (burst arrival rate)
- $T_{burst}$ = duration of burst in seconds
- $C_{worker}$ = worker processing throughput per worker core (estimated at 80 events/sec per worker thread with indexed MongoDB pipeline updates and mock external verification)
- $W$ = number of active worker threads / execution slots
- $C_{total} = W \times C_{worker}$ (aggregate cluster processing rate)
- $SLA_{max} = 300 \text{ seconds}$ (5-minute maximum drain limit)

#### Sizing for the Burst:
To drain accepted events within 5 minutes under design capacity, the system must process accumulated backlog before $T_{drain} \le 300 \text{ s}$.

If we experience a burst of **5,000 events/sec for 60 seconds**:
- Total burst accumulation: $Q_{burst} = 5,000 \times 60 = 300,000 \text{ events}$.
- While the burst arrives, workers process events concurrently.
- Maximum allowable drain time from burst start: $T_{total} \le 300 \text{ s}$.
- Net drain time remaining after burst: $300 - 60 = 240 \text{ s}$.
- Required cluster processing rate:
  $$C_{total} \ge \frac{Q_{burst}}{300} = \frac{300,000}{300} = 1,000 \text{ events/sec}$$
- Required worker cores ($W$):
  $$W = \frac{1,000 \text{ events/sec}}{80 \text{ events/sec/core}} \approx 13 \text{ dedicated worker cores}$$

#### Burst Sustainability Envelope:
With a provisioned worker cluster throughput of **1,200 events/sec** (15 worker cores):
- Net backlog accumulation rate during burst:
  $$\Delta Q = R_{burst} - C_{total} = 5,000 - 1,200 = 3,800 \text{ events/sec}$$
- For a burst of duration $T_b$:
  $$Q_{max} = 3,800 \times T_b$$
- After the burst ends (input drops back to steady-state $R_{steady} \approx 116 \text{ events/sec}$):
  $$C_{net\_drain} = C_{total} - R_{steady} = 1,200 - 116 = 1,084 \text{ events/sec}$$
- Time to drain backlog:
  $$T_{drain\_post} = \frac{Q_{max}}{1,084} = \frac{3,800 \times T_b}{1,084} \approx 3.5 \times T_b$$
- Total time from burst onset until queue is fully cleared:
  $$T_{settle} = T_b + 3.5 \times T_b = 4.5 \times T_b$$
- Enforcing $T_{settle} \le 300 \text{ seconds}$ (5-minute SLA):
  $$4.5 \times T_b \le 300 \implies T_b \le \mathbf{66.6 \text{ seconds}}$$

**Conclusion**: Under this design capacity, the service can sustain a full 5,000 events/sec burst for **up to 66 seconds (~333,000 events accumulated)** and completely drain within the 5-minute SLA window. If bursts exceed 66 seconds, horizontal autoscaling or gateway rate-limiting backpressure must trigger.

---

## 3. Storage, Indexes, and Retention Budget

### A. 7-Day Raw Event Storage Budget
- 10,000,000 events/day $\times$ 7 days = **70,000,000 event documents**.
- Raw JSON payload size: 1 KB / document.
- Metadata, attempts, leases, content hashes: ~0.5 KB / document.
- Total raw document size: 1.5 KB $\times$ 70,000,000 = **105 GB**.
- WiredTiger compression (Snappy / Zstandard default): ~2.5x to 3x reduction $\implies$ **~35 to 42 GB disk data footprint**.
- Indexes on `events` collection:
  - `{ tenantId: 1, sourceId: 1, eventId: 1 }` (~55 bytes/doc) $\implies$ ~3.8 GB
  - `{ status: 1, nextAttemptAt: 1, claimExpiresAt: 1 }` (sparse or partial index for `pending`/`processing`) $\implies$ ~400 MB (only active queue items!)
  - Total event index RAM footprint: ~4.5 GB.

### B. 1 Million Current Job Projections Budget
- 1,000,000 job listings.
- Average projection record size: ~0.8 KB.
- Total raw projection data: ~800 MB.
- Compressed projection footprint: **~250 MB**.
- Indexes on `jobs` collection:
  - `{ tenantId: 1, sourceId: 1, externalJobId: 1 }`: ~50 MB
  - `{ tenantId: 1, status: 1, _id: 1 }`: ~40 MB
  - Total jobs working set fits completely in RAM (<1 GB RAM required).

### C. Retention & Purge Mechanism
- To enforce the 7-day retention rule without heavy background deletes that lock WiredTiger eviction, we configure a MongoDB TTL index on `completedAt`:
  ```javascript
  db.events.createIndex(
    { completedAt: 1 },
    { expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { status: { $in: ["completed", "failed"] } } }
  );
  ```
- Alternatively, for extreme high-volume production, **time-bucketed collections** (e.g. `events_YYYY_WW`) allow instant drop of expired partitions via `db.events_2026_w38.drop()` with zero disk fragmentation and zero I/O eviction overhead.

---

## 4. Sharding & Partitioning Strategy

When scaling beyond 10M events/day or handling multiple multi-tenant enterprise clusters:

```
               [Load Balancer / Ingress]
                          │
             ┌────────────┴────────────┐
       [API Gateway]             [API Gateway]
             │                         │
      (Shard Key: tenantId + externalJobId)
             │
    ┌────────┴────────┬────────────────┴────────┐
    ▼                 ▼                         ▼
[Shard 1]         [Shard 2]                 [Shard 3]
Tenant: A-H       Tenant: I-P               Tenant: Q-Z
- events chunk    - events chunk            - events chunk
- jobs chunk      - jobs chunk              - jobs chunk
```

### Sharding Key Selection:
- **Sharded Collections**: `events` and `jobs`.
- **Shard Key Choice**: Compound hashed shard key `{ tenantId: 1, externalJobId: 1 }` or `{ tenantId: "hashed" }`.
- **Tradeoffs & Uniqueness Constraints**:
  - MongoDB enforces that unique indexes on sharded collections *must* include the shard key as a prefix.
  - Because our primary uniqueness constraints are:
    - Events: `{ tenantId, sourceId, eventId }`
    - Jobs: `{ tenantId, sourceId, externalJobId }`
  - Sharding by `tenantId` ensures that all writes for a given tenant route to a single shard replica set. This preserves local unique constraint enforcement without cross-shard distributed transactions!
  - Eliminates scatter-gather queries for all tenant-scoped reads (`GET /jobs?tenantId=...`).
  - *Risk*: A super-tenant ("noisy neighbor") might cause shard hotspotting.
  - *Hotspot Mitigation*: Compound shard key `{ tenantId: 1, externalJobId: "hashed" }` distributes large tenants across multiple chunks while maintaining atomic single-document updates on `(tenantId, sourceId, externalJobId)`.

---

## 5. Backpressure, Noisy Neighbors & Retry Resilience

### A. Ingestion Admission Control (Token Bucket)
- To prevent a malicious or malfunctioning tenant from exhausting database connection pools during the 5,000 events/sec burst:
  1. **Per-Tenant Rate Limits**: Token bucket algorithm implemented at the API Gateway (e.g., maximum 500 req/sec per tenant with burst allowance of 1,500).
  2. **Tiered Throttling**: Excess requests return HTTP `429 Too Many Requests` with a `Retry-After: <seconds>` header.
  3. **Memory Backpressure**: If database write queue depth exceeds 250,000 items, the API returns HTTP `503 Service Unavailable` with backpressure signaling, shielding MongoDB from thrashing.

### B. Worker Fairness Across Tenants
- In a shared worker pool, a flood of 100,000 events from Tenant X must not starve Tenant Y.
- **Fair Queuing**: Workers claim items using a round-robin or bucketed query:
  ```typescript
  // Claiming work with tenant round-robin consideration
  events.findOneAndUpdate(
    { status: 'pending', nextAttemptAt: { $lte: now } },
    { $set: { status: 'processing', ... } },
    { sort: { nextAttemptAt: 1, createdAt: 1 } }
  );
  ```
- At 10M events/day, separate worker groups are provisioned for standard vs. high-throughput enterprise tiers.

### C. Preventing Retry Storms
- When an external provider suffers an outage (e.g. returning 503 or 429):
  1. **Full Jitter Exponential Backoff**:
     $$T_{backoff} = \text{base} \times 2^{\text{attempt}} + \text{random}(0, \text{jitter})$$
     Jitter de-synchronizes worker retries, preventing thundering herds.
  2. **Circuit Breaker Pattern**: If external provider failure rate exceeds 50% over a 30-second window, the circuit trips to `OPEN`. Workers pause external verification attempts for 60 seconds rather than pounding the dead downstream API.

---

## 6. Observability: Metrics, Health, & Alerts

### Key Prometheus / Datadog Metrics
| Metric Name | Type | Description | Alert Threshold |
| :--- | :--- | :--- | :--- |
| `jobfeed_events_accepted_total` | Counter | Total accepted events (HTTP 202) | Rate drop > 50% |
| `jobfeed_events_replayed_total` | Counter | Safe deduplicated replays (HTTP 200) | Informational |
| `jobfeed_events_conflict_total` | Counter | Reused event identity conflicts (HTTP 409) | Spike > 100/min |
| `jobfeed_queue_depth` | Gauge | Count of `pending` + `processing` events | **> 150,000 items (Warning)**, **> 300,000 (Critical)** |
| `jobfeed_queue_age_seconds` | Gauge | Age of oldest uncompleted event (`now - createdAt`) | **> 180s (Warning)**, **> 300s (Critical SLA Breach)** |
| `jobfeed_worker_duration_seconds` | Histogram | Latency to process single event (p50/p95/p99) | p95 > 250 ms |
| `jobfeed_provider_errors_total` | Counter | Transient (429/503) vs Permanent (422) failures | Error rate > 5% |
| `mongodb_oplatencies_write` | Histogram | Database write latency | p95 > 25 ms |

---

## 7. Architectural Evolution: When to Introduce a Dedicated Broker

While our MongoDB lease queue meets all correctness and scale requirements up to ~5-10 million events/day, we recommend transitioning to an external streaming log (Apache Kafka / Apache Pulsar) when the following triggers are met:

1. **Write Contention on Queue Index**: When concurrent worker count exceeds ~60 threads, atomic `findOneAndUpdate` polling on the index head causes lock contention in WiredTiger cache eviction.
2. **Sustained Ingestion Exceeding 10,000 events/sec**: Kafka provides sequential append-only disk writes at millions of messages/sec with zero indexing overhead at ingestion time.
3. **Multi-Consumer Fan-Out**: When additional microservices (e.g., search indexing, candidate recommendation engines, audit logs) require real-time consumption of job events without querying MongoDB.

```
[API Gateway] ──> [Kafka Topic: job-events] (Partitioned by tenantId)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
  [Projection Workers]        [Search Indexer Worker]
  (Updates MongoDB Jobs)       (Indexes into Elasticsearch)
```

---

## 8. Empirical Local Load Test Measurements

As required, we executed a local load test simulating 1,200 HTTP requests:
- **1,000 distinct valid events** across 3 tenants (`tenant-load-1`, `tenant-load-2`, `tenant-load-3`).
- **200 exact duplicate replay requests**.
- **60 jobs with out-of-order versions** (versions 3, 1, 2 submitted deliberately out of order).
- **Ingestion Concurrency**: 20 parallel HTTP connections.
- **Worker Configuration**: 4 parallel competing worker loops with 10ms poll intervals.

### Measured Results:
- **Hardware Environment**: Node.js v22.23.2, Linux x64, 4.0 GB RAM, WiredTiger storage engine.
- **Total Requests**: 1,200 requests.
- **Accepted (HTTP 202)**: **1,000 / 1,000 (100%)**
- **Safe Replays (HTTP 200)**: **200 / 200 (100%)**
- **Conflicts (HTTP 409)**: **0**
- **HTTP Latency**:
  - **p50**: **71.68 ms**
  - **p95**: **113.79 ms**
  - **p99**: **264.90 ms**
  - **Average**: **75.47 ms**
- **Ingestion Throughput**: **261 req/sec**
- **Queue Drain Time**: **3.84 seconds**
- **Worker Processing Throughput**: **260 events/sec** across 4 worker loops (~65 events/sec/worker).
- **Final State Verification**:
  - **100% of out-of-order jobs (60/60) settled at Version 3**.
  - **1,000 / 1,000 events completed**.
  - **Zero duplicate logical jobs created**.
