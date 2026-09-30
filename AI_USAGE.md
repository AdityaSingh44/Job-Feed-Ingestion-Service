# AI Collaboration & Assistance Record (AI_USAGE.md)

## 1. Overview of AI Assistance
In accordance with the assignment guidelines, AI assistance (Google AI Studio Build engine running Gemini 3.8 Flash) was used to accelerate the architectural synthesis, test scenario design, and edge-case boundary checks for this submission.

As the submitting engineer, I have personally reviewed, edited, validated, and verified every single claim, calculation, test assertion, and line of code across the codebase.

---

## 2. Artifact Log

### Artifact 1: MongoDB Pipeline-Based Atomic Version Update
- **Tool / Model**: Gemini 3.8 Flash
- **Prompt Summary**:
  *"Design an atomic MongoDB update query for out-of-order job event projections. The query must ensure the greatest version wins, lower versions never overwrite newer fields, an archive operation sets status to archived with a version tombstone, and archives can arrive before any upsert without race conditions under concurrent workers."*
- **Target Artifact / File**: `src/server/worker.ts` (Commit `33cbf17`)
- **What Was Accepted**:
  - The use of MongoDB 4.2+ aggregation update pipeline in `jobs.updateOne({ tenantId, sourceId, externalJobId }, [ ... ], { upsert: true })`.
  - Conditional `$cond` expressions evaluating `$gt: [event.version, { $ifNull: ['$currentVersion', -1] }]`.
- **What Was Changed / Corrected During Human Review**:
  - Initial generation missed preserving existing projection fields when an archive arrives *after* an upsert; the update needed to preserve the version number while switching `status: 'archived'` without resetting `_id` or creating duplicate documents.
  - Verified that an archive arriving *before* any upsert initializes `currentVersion` so that any subsequent lower-version upsert evaluates to false and does not overwrite the tombstone.
- **Verification Method**:
  - Executed integration test `tests/ingestion.test.ts` ("preserves archive tombstone when archive arrives before any upsert").
  - Executed 20-request scenario verifying requests `req-13` (archive v2 before upsert), `req-14` (stale upsert v1 attempted), and `req-18` (reactivation at v3).

---

### Artifact 2: Canonical JSON Serialization & Hash Comparison
- **Tool / Model**: Gemini 3.8 Flash
- **Prompt Summary**:
  *"Implement a deterministic JSON serializer in TypeScript that sorts all object keys alphabetically regardless of depth, strictly preserves array element order, and generates a SHA-256 hash to distinguish exact duplicates from conflicting reuses."*
- **Target Artifact / File**: `src/server/hasher.ts`
- **What Was Accepted**:
  - Recursive traversal algorithm sorting `Object.keys()` lexicographically.
  - Preserving array elements in their native order (addressing the spec requirement: *"Ignore object-key order when comparing JSON; array order remains significant"*).
- **What Was Changed / Corrected During Human Review**:
  - Verified that nested primitive types (null, boolean, numbers) stringify consistently without locale formatting differences.
- **Verification Method**:
  - Tested with scrambled key orders in `req-01` vs `req-02` in `fixtures/demo-scenario.json`. Reordering keys produced the exact same SHA-256 hash, returning HTTP 200 OK. Modifying one field in `req-03` produced a different hash, returning HTTP 409 Conflict.

---

### Artifact 3: Quantitative Scale Sizing & Burst Drain Modeling
- **Tool / Model**: Gemini 3.8 Flash
- **Prompt Summary**:
  *"Formulate a mathematical queue drain and burst capacity model for scaling an event ingestion service from 100k/day to 10M/day with 5,000 events/sec bursts and a 5-minute drain SLA."*
- **Target Artifact / File**: `SCALE.md`
- **What Was Accepted**:
  - Derivation of the burst sustainability window ($T_b \le 66.6 \text{ s}$ for a 15-core cluster).
  - Storage estimation taking into account WiredTiger Snappy compression and RAM working set calculations.
- **What Was Changed / Corrected During Human Review**:
  - Replaced arbitrary CPU estimates with empirical processing throughput measured during our local load test (`scripts/load-test.ts`), which recorded 260 events/sec across 4 worker loops (~65 events/sec/worker core).
- **Verification Method**:
  - Validated queue drain metrics and memory usage against actual recorded output from `scripts/load-test.ts`.

---

## 3. Independent Verification Statement
All AI-suggested constructs and code segments were independently tested against a real MongoDB database instance with strict TypeScript type-checking enabled. No unverified assumptions or ungrounded claims remain in this repository.
