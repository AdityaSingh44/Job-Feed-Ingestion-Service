import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectDatabase, closeDatabase, resetDatabase, getEventsCollection, getJobsCollection } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { WorkerPool } from '../src/server/worker.js';

describe('Job-Feed Ingestion Service Test Suite', () => {
  let workerPool: WorkerPool;
  let app: any;

  beforeAll(async () => {
    await connectDatabase();
    workerPool = new WorkerPool({
      workerCount: 2,
      pollIntervalMs: 20,
      leaseDurationMs: 1500,
      baseBackoffMs: 50
    });
    workerPool.start();
    app = createApp(workerPool);
  });

  afterAll(async () => {
    await workerPool.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  // --------------------------------------------------------------------------
  // Check 1: Validation, Normalization, Duplicate Replay, Conflicting Reuse, Corrected Reuse
  // --------------------------------------------------------------------------
  describe('1. Validation, Normalization, Replay Safety, and Conflicts', () => {
    it('accepts valid upsert event and normalizes skills correctly', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          tenantId: 'tenant-val',
          sourceId: 'src-1',
          eventId: 'ev-val-1',
          externalJobId: 'job-val-1',
          version: 1,
          operation: 'upsert',
          payload: {
            title: '  Senior Engineer  ',
            company: '  Acme Corp  ',
            location: '  Surat  ',
            experienceMin: 2,
            experienceMax: 5,
            applyUrl: 'https://example.com/apply',
            skills: [' TypeScript ', 'MongoDB', 'typescript', ' NODE.JS ']
          }
        });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('accepted');

      await workerPool.drain(5000);

      const job = await getJobsCollection().findOne({
        tenantId: 'tenant-val',
        sourceId: 'src-1',
        externalJobId: 'job-val-1'
      });

      expect(job).not.toBeNull();
      expect(job?.title).toBe('Senior Engineer');
      expect(job?.company).toBe('Acme Corp');
      expect(job?.location).toBe('Surat');
      // Skills normalized: trimmed, lowercased, deduplicated, first occurrence order preserved
      expect(job?.skills).toEqual(['typescript', 'mongodb', 'node.js']);
    });

    it('rejects surrounding whitespace in identifiers with 400', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          tenantId: '  tenant-space  ',
          sourceId: 'src-1',
          eventId: 'ev-space-1',
          externalJobId: 'job-space-1',
          version: 1,
          operation: 'upsert',
          payload: {
            title: 'Engineer',
            company: 'Corp',
            location: 'Surat',
            experienceMin: 1,
            experienceMax: 3,
            applyUrl: 'https://example.com',
            skills: ['Go']
          }
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Surrounding whitespace');

      // Identifier was not reserved
      const event = await getEventsCollection().findOne({ eventId: 'ev-space-1' });
      expect(event).toBeNull();
    });

    it('rejects invalid experience range (min > max) with 400', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          tenantId: 'tenant-val',
          sourceId: 'src-1',
          eventId: 'ev-bad-exp',
          externalJobId: 'job-bad-exp',
          version: 1,
          operation: 'upsert',
          payload: {
            title: 'Engineer',
            company: 'Corp',
            location: 'Surat',
            experienceMin: 10,
            experienceMax: 2,
            applyUrl: 'https://example.com',
            skills: ['Go']
          }
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cannot be greater than experienceMax');
    });

    it('rejects insecure HTTP URLs with 400', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          tenantId: 'tenant-val',
          sourceId: 'src-1',
          eventId: 'ev-http-url',
          externalJobId: 'job-http',
          version: 1,
          operation: 'upsert',
          payload: {
            title: 'Engineer',
            company: 'Corp',
            location: 'Surat',
            experienceMin: 1,
            experienceMax: 2,
            applyUrl: 'http://insecure.example.com',
            skills: ['Go']
          }
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('HTTPS');
    });

    it('handles exact duplicate replay safely with HTTP 200 and no second work item', async () => {
      const payload = {
        tenantId: 'tenant-replay',
        sourceId: 'src-main',
        eventId: 'ev-replay-1',
        externalJobId: 'job-rep',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Full Stack',
          company: 'Tech',
          location: 'Remote',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: 'https://example.com',
          skills: ['React']
        }
      };

      const res1 = await request(app).post('/events').send(payload);
      expect(res1.status).toBe(202);

      // Same parsed JSON document, key order reversed in payload object
      const reorderedPayload = {
        operation: 'upsert',
        version: 1,
        externalJobId: 'job-rep',
        eventId: 'ev-replay-1',
        sourceId: 'src-main',
        tenantId: 'tenant-replay',
        payload: {
          location: 'Remote',
          skills: ['React'],
          experienceMax: 3,
          experienceMin: 1,
          applyUrl: 'https://example.com',
          company: 'Tech',
          title: 'Full Stack'
        }
      };

      const res2 = await request(app).post('/events').send(reorderedPayload);
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('replayed');

      // Verify only 1 document in events collection
      const count = await getEventsCollection().countDocuments({
        tenantId: 'tenant-replay',
        sourceId: 'src-main',
        eventId: 'ev-replay-1'
      });
      expect(count).toBe(1);
    });

    it('returns 409 Conflict when reusing event identity with different content', async () => {
      const original = {
        tenantId: 'tenant-conflict',
        sourceId: 'src-main',
        eventId: 'ev-conf-1',
        externalJobId: 'job-c',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Initial Title',
          company: 'Tech',
          location: 'Remote',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: 'https://example.com',
          skills: ['React']
        }
      };

      const res1 = await request(app).post('/events').send(original);
      expect(res1.status).toBe(202);

      const conflicting = {
        ...original,
        payload: {
          ...original.payload,
          title: 'Conflicting Different Title'
        }
      };

      const res2 = await request(app).post('/events').send(conflicting);
      expect(res2.status).toBe(409);
      expect(res2.body.error).toContain('conflicting content');
    });

    it('allows a corrected request to reuse the rejected event ID', async () => {
      // 1. Rejected request
      const badReq = {
        tenantId: 'tenant-corr',
        sourceId: 'src-1',
        eventId: 'ev-reused-id',
        externalJobId: 'job-corr',
        version: 0, // Invalid!
        operation: 'upsert',
        payload: {
          title: 'Engineer',
          company: 'Tech',
          location: 'Remote',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: 'https://example.com',
          skills: ['Node.js']
        }
      };

      const res1 = await request(app).post('/events').send(badReq);
      expect(res1.status).toBe(400);

      // 2. Corrected request reusing same event ID
      const goodReq = {
        ...badReq,
        version: 1
      };

      const res2 = await request(app).post('/events').send(goodReq);
      expect(res2.status).toBe(202);
      expect(res2.body.status).toBe('accepted');
    });
  });

  // --------------------------------------------------------------------------
  // Check 2: Tenant/Source Isolation, Out-of-Order Versions, Archives
  // --------------------------------------------------------------------------
  describe('2. Tenant & Source Isolation and Version Projections', () => {
    it('isolates matching IDs in different tenants and sources', async () => {
      // Tenant A main
      await request(app).post('/events').send({
        tenantId: 'tenant-1',
        sourceId: 'main',
        eventId: 'ev-shared',
        externalJobId: 'job-same-id',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Job Tenant 1',
          company: 'Corp 1',
          location: 'City 1',
          experienceMin: 1,
          experienceMax: 2,
          applyUrl: 'https://example.com/1',
          skills: ['Java']
        }
      });

      // Tenant B main (same eventId and externalJobId)
      await request(app).post('/events').send({
        tenantId: 'tenant-2',
        sourceId: 'main',
        eventId: 'ev-shared',
        externalJobId: 'job-same-id',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Job Tenant 2',
          company: 'Corp 2',
          location: 'City 2',
          experienceMin: 3,
          experienceMax: 5,
          applyUrl: 'https://example.com/2',
          skills: ['Python']
        }
      });

      // Tenant A partner source
      await request(app).post('/events').send({
        tenantId: 'tenant-1',
        sourceId: 'partner',
        eventId: 'ev-shared-partner',
        externalJobId: 'job-same-id',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Job Tenant 1 Partner',
          company: 'Partner Corp',
          location: 'City 3',
          experienceMin: 2,
          experienceMax: 4,
          applyUrl: 'https://example.com/3',
          skills: ['Rust']
        }
      });

      await workerPool.drain(5000);

      const jobsColl = getJobsCollection();
      const jobT1 = await jobsColl.findOne({ tenantId: 'tenant-1', sourceId: 'main', externalJobId: 'job-same-id' });
      const jobT2 = await jobsColl.findOne({ tenantId: 'tenant-2', sourceId: 'main', externalJobId: 'job-same-id' });
      const jobT1Partner = await jobsColl.findOne({ tenantId: 'tenant-1', sourceId: 'partner', externalJobId: 'job-same-id' });

      expect(jobT1?.title).toBe('Job Tenant 1');
      expect(jobT2?.title).toBe('Job Tenant 2');
      expect(jobT1Partner?.title).toBe('Job Tenant 1 Partner');
    });

    it('ensures greatest version wins when versions arrive out of order', async () => {
      // Version 3 arrives first
      await request(app).post('/events').send({
        tenantId: 'tenant-ooo',
        sourceId: 'src-1',
        eventId: 'ev-ooo-v3',
        externalJobId: 'job-ooo',
        version: 3,
        operation: 'upsert',
        payload: {
          title: 'Staff Architect V3',
          company: 'Scale Labs',
          location: 'Surat',
          experienceMin: 5,
          experienceMax: 10,
          applyUrl: 'https://example.com/v3',
          skills: ['MongoDB']
        }
      });

      await workerPool.drain(5000);

      // Version 2 arrives second (delayed stale update)
      await request(app).post('/events').send({
        tenantId: 'tenant-ooo',
        sourceId: 'src-1',
        eventId: 'ev-ooo-v2',
        externalJobId: 'job-ooo',
        version: 2,
        operation: 'upsert',
        payload: {
          title: 'Junior Architect V2 (Stale)',
          company: 'Scale Labs',
          location: 'Surat',
          experienceMin: 2,
          experienceMax: 4,
          applyUrl: 'https://example.com/v2',
          skills: ['Go']
        }
      });

      await workerPool.drain(5000);

      const job = await getJobsCollection().findOne({
        tenantId: 'tenant-ooo',
        sourceId: 'src-1',
        externalJobId: 'job-ooo'
      });

      // Must remain at V3!
      expect(job?.currentVersion).toBe(3);
      expect(job?.title).toBe('Staff Architect V3');
    });

    it('preserves archive tombstone when archive arrives before any upsert', async () => {
      // 1. Version 2 archive arrives before any upsert
      await request(app).post('/events').send({
        tenantId: 'tenant-tombstone',
        sourceId: 'src-1',
        eventId: 'ev-tomb-v2',
        externalJobId: 'job-tomb',
        version: 2,
        operation: 'archive'
      });

      await workerPool.drain(5000);

      const jobAfterArchive = await getJobsCollection().findOne({
        tenantId: 'tenant-tombstone',
        sourceId: 'src-1',
        externalJobId: 'job-tomb'
      });

      expect(jobAfterArchive?.status).toBe('archived');
      expect(jobAfterArchive?.currentVersion).toBe(2);

      // 2. Delayed v1 upsert arrives
      await request(app).post('/events').send({
        tenantId: 'tenant-tombstone',
        sourceId: 'src-1',
        eventId: 'ev-tomb-v1',
        externalJobId: 'job-tomb',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Resurrect Attempt V1',
          company: 'Ghost Corp',
          location: 'Surat',
          experienceMin: 1,
          experienceMax: 2,
          applyUrl: 'https://example.com/ghost',
          skills: ['C++']
        }
      });

      await workerPool.drain(5000);

      const jobAfterStaleUpsert = await getJobsCollection().findOne({
        tenantId: 'tenant-tombstone',
        sourceId: 'src-1',
        externalJobId: 'job-tomb'
      });

      // Must NOT resurrect job: stays archived at v2
      expect(jobAfterStaleUpsert?.status).toBe('archived');
      expect(jobAfterStaleUpsert?.currentVersion).toBe(2);
      expect(jobAfterStaleUpsert?.title).toBeFalsy();

      // 3. Higher version v3 arrives and successfully reactivates job
      await request(app).post('/events').send({
        tenantId: 'tenant-tombstone',
        sourceId: 'src-1',
        eventId: 'ev-tomb-v3',
        externalJobId: 'job-tomb',
        version: 3,
        operation: 'upsert',
        payload: {
          title: 'Reactivated Role V3',
          company: 'Reborn Corp',
          location: 'Surat',
          experienceMin: 3,
          experienceMax: 6,
          applyUrl: 'https://example.com/reborn',
          skills: ['TypeScript']
        }
      });

      await workerPool.drain(5000);

      const jobReactivated = await getJobsCollection().findOne({
        tenantId: 'tenant-tombstone',
        sourceId: 'src-1',
        externalJobId: 'job-tomb'
      });

      expect(jobReactivated?.status).toBe('active');
      expect(jobReactivated?.currentVersion).toBe(3);
      expect(jobReactivated?.title).toBe('Reactivated Role V3');
    });
  });

  // --------------------------------------------------------------------------
  // Check 3: Retry Success, Permanent Failure, and Retry Exhaustion
  // --------------------------------------------------------------------------
  describe('3. External Provider Failures and Retries', () => {
    it('retries transient 503 error and succeeds on subsequent attempt', async () => {
      // Matching rule in provider-plan.json for delta
      const res = await request(app).post('/events').send({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        eventId: 'ev-prov-delta',
        externalJobId: 'delta',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Data Engineer Delta',
          company: 'Acme',
          location: 'Surat',
          experienceMin: 2,
          experienceMax: 4,
          applyUrl: 'https://example.com/delta',
          skills: ['Kafka']
        }
      });

      expect(res.status).toBe(202);
      await workerPool.drain(5000);

      const event = await getEventsCollection().findOne({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        eventId: 'ev-prov-delta'
      });

      expect(event?.status).toBe('completed');
      expect(event?.attemptCount).toBe(2);
      expect(event?.attemptHistory.length).toBeGreaterThanOrEqual(2);

      const job = await getJobsCollection().findOne({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        externalJobId: 'delta'
      });
      expect(job?.status).toBe('active');
    });

    it('treats 422 as permanent failure without retry, retaining terminal failed event', async () => {
      // Epsilon matches 422 in provider-plan.json
      const res = await request(app).post('/events').send({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        eventId: 'ev-prov-epsilon',
        externalJobId: 'epsilon',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Bad Epsilon Job',
          company: 'Spam Corp',
          location: 'Surat',
          experienceMin: 1,
          experienceMax: 2,
          applyUrl: 'https://example.com/epsilon',
          skills: ['Spam']
        }
      });

      expect(res.status).toBe(202);
      await workerPool.drain(5000);

      const event = await getEventsCollection().findOne({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        eventId: 'ev-prov-epsilon'
      });

      expect(event?.status).toBe('failed');
      expect(event?.attemptCount).toBe(1); // Permanent: does not retry
      expect(event?.lastError).toContain('422');

      // No job projection should exist
      const job = await getJobsCollection().findOne({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        externalJobId: 'epsilon'
      });
      expect(job).toBeNull();
    });

    it('exhausts retries after 3 attempts on persistent 429 and retains terminal failed state', async () => {
      // Zeta matches 429 in provider-plan.json
      const res = await request(app).post('/events').send({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        eventId: 'ev-prov-zeta',
        externalJobId: 'zeta',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Rate Limited Zeta Job',
          company: 'Acme',
          location: 'Surat',
          experienceMin: 1,
          experienceMax: 2,
          applyUrl: 'https://example.com/zeta',
          skills: ['Go']
        }
      });

      expect(res.status).toBe(202);
      await workerPool.drain(10000);

      const event = await getEventsCollection().findOne({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        eventId: 'ev-prov-zeta'
      });

      expect(event?.status).toBe('failed');
      expect(event?.attemptCount).toBe(3);
      expect(event?.lastError).toContain('Exhausted');

      const job = await getJobsCollection().findOne({
        tenantId: 'tenant-provider',
        sourceId: 'src-1',
        externalJobId: 'zeta'
      });
      expect(job).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Check 4: Concurrent Duplicate Requests and Concurrent Workers
  // --------------------------------------------------------------------------
  describe('4. Concurrency Safety and Worker Races', () => {
    it('handles concurrent duplicate POST requests safely with exact replay detection', async () => {
      const eventPayload = {
        tenantId: 'tenant-conc',
        sourceId: 'src-1',
        eventId: 'ev-conc-race',
        externalJobId: 'job-conc',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Concurrent Race Job',
          company: 'Fast Corp',
          location: 'Surat',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: 'https://example.com/race',
          skills: ['TypeScript']
        }
      };

      // Dispatch 10 parallel identical requests
      const promises = Array.from({ length: 10 }, () =>
        request(app).post('/events').send(eventPayload)
      );

      const responses = await Promise.all(promises);
      const statuses = responses.map(r => r.status);

      // Exactly one request should be 202 Accepted, and 9 should be 200 OK (replayed)
      const count202 = statuses.filter(s => s === 202).length;
      const count200 = statuses.filter(s => s === 200).length;

      expect(count202).toBe(1);
      expect(count200).toBe(9);

      // Ensure exactly 1 event record in database
      const dbEventCount = await getEventsCollection().countDocuments({
        tenantId: 'tenant-conc',
        sourceId: 'src-1',
        eventId: 'ev-conc-race'
      });
      expect(dbEventCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Check 5: Deliberate Crash After Writing Projection Followed by Recovery
  // --------------------------------------------------------------------------
  describe('5. Crash Recovery After Projection Write', () => {
    it('recovers cleanly after a worker crash following projection update without duplicate logical jobs', async () => {
      const crashEventId = 'ev-crash-test';

      // 1. Arm worker pool with crash hook for this event
      workerPool.crashAfterProjectionEventId = crashEventId;

      const res = await request(app).post('/events').send({
        tenantId: 'tenant-crash',
        sourceId: 'src-1',
        eventId: crashEventId,
        externalJobId: 'job-crash-rec',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Crash Resilient Engineer',
          company: 'Chaos Engineering Inc',
          location: 'Surat',
          experienceMin: 3,
          experienceMax: 5,
          applyUrl: 'https://example.com/crash',
          skills: ['Reliability', 'MongoDB']
        }
      });

      expect(res.status).toBe(202);

      // Wait for crash hook to trigger and lease to expire
      await new Promise(resolve => setTimeout(resolve, 1800));

      // Worker pool should automatically recover the expired lease and finish work
      const drained = await workerPool.drain(5000);
      expect(drained).toBe(true);

      const event = await getEventsCollection().findOne({
        tenantId: 'tenant-crash',
        sourceId: 'src-1',
        eventId: crashEventId
      });

      // Event was recovered and marked completed
      expect(event?.status).toBe('completed');
      expect(event?.attemptCount).toBeGreaterThanOrEqual(2);

      // Exactly one logical job exists, with correct projection
      const job = await getJobsCollection().findOne({
        tenantId: 'tenant-crash',
        sourceId: 'src-1',
        externalJobId: 'job-crash-rec'
      });

      expect(job).not.toBeNull();
      expect(job?.currentVersion).toBe(1);
      expect(job?.title).toBe('Crash Resilient Engineer');

      const totalMatchingJobs = await getJobsCollection().countDocuments({
        tenantId: 'tenant-crash',
        sourceId: 'src-1',
        externalJobId: 'job-crash-rec'
      });
      expect(totalMatchingJobs).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Check 6: Pagination and Read Endpoints
  // --------------------------------------------------------------------------
  describe('6. Read Endpoints and Cursor Pagination Boundaries', () => {
    it('paginates deterministically using cursor across active and archived jobs', async () => {
      const tenantId = 'tenant-page';

      // Insert 25 jobs (20 active, 5 archived)
      for (let i = 1; i <= 25; i++) {
        const isArchived = i > 20;
        await request(app).post('/events').send({
          tenantId,
          sourceId: 'main',
          eventId: `ev-page-${i}`,
          externalJobId: `job-page-${i.toString().padStart(2, '0')}`,
          version: 1,
          operation: isArchived ? 'archive' : 'upsert',
          payload: isArchived
            ? undefined
            : {
                title: `Job ${i}`,
                company: 'Pagination Corp',
                location: 'Surat',
                experienceMin: 1,
                experienceMax: 3,
                applyUrl: `https://example.com/jobs/${i}`,
                skills: ['JavaScript']
              }
        });
      }

      await workerPool.drain(5000);

      // Page 1: Default active, limit 10
      const page1Res = await request(app).get(`/jobs?tenantId=${tenantId}&limit=10`);
      expect(page1Res.status).toBe(200);
      expect(page1Res.body.items.length).toBe(10);
      expect(page1Res.body.hasMore).toBe(true);
      expect(page1Res.body.nextCursor).toBeTruthy();

      // Page 2: Using nextCursor
      const page2Res = await request(app).get(
        `/jobs?tenantId=${tenantId}&limit=10&cursor=${page1Res.body.nextCursor}`
      );
      expect(page2Res.status).toBe(200);
      expect(page2Res.body.items.length).toBe(10);
      expect(page2Res.body.hasMore).toBe(false);

      // Verify no duplicate IDs between Page 1 and Page 2
      const page1Ids = page1Res.body.items.map((j: any) => j.externalJobId);
      const page2Ids = page2Res.body.items.map((j: any) => j.externalJobId);
      const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
      expect(overlap.length).toBe(0);

      // Archived filter
      const archivedRes = await request(app).get(`/jobs?tenantId=${tenantId}&status=archived`);
      expect(archivedRes.status).toBe(200);
      expect(archivedRes.body.items.length).toBe(5);

      // All filter
      const allRes = await request(app).get(`/jobs?tenantId=${tenantId}&status=all&limit=30`);
      expect(allRes.status).toBe(200);
      expect(allRes.body.items.length).toBe(25);
    });

    it('retrieves event state via GET /events/:eventId', async () => {
      await request(app).post('/events').send({
        tenantId: 'tenant-ev-read',
        sourceId: 'src-1',
        eventId: 'ev-read-101',
        externalJobId: 'job-read',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Read Endpoint Job',
          company: 'Inspect Corp',
          location: 'Surat',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: 'https://example.com/inspect',
          skills: ['TypeScript']
        }
      });

      await workerPool.drain(5000);

      const res = await request(app).get('/events/ev-read-101?tenantId=tenant-ev-read&sourceId=src-1');
      expect(res.status).toBe(200);
      expect(res.body.eventId).toBe('ev-read-101');
      expect(res.body.status).toBe('completed');
      expect(res.body.attemptCount).toBe(1);
      expect(res.body.attemptHistory.length).toBe(1);
    });

    it('returns service readiness via GET /health', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
      expect(res.body.database.status).toBe('CONNECTED');
      expect(res.body.workers.status).toBe('RUNNING');
      expect(res.body.workers.count).toBe(2);
    });
  });
});
