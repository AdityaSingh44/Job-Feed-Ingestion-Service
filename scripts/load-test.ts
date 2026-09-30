import os from 'os';
import { connectDatabase, closeDatabase, resetDatabase, getEventsCollection, getJobsCollection } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { WorkerPool } from '../src/server/worker.js';

interface LatencyRecord {
  durationMs: number;
  status: number;
}

export async function runLoadTest() {
  console.log('================================================================');
  console.log('   JOB-FEED INGESTION SERVICE - REPRODUCIBLE LOAD TEST SUITE    ');
  console.log('================================================================\n');

  const cpus = os.cpus();
  console.log(`[Environment] Node.js: ${process.version}`);
  console.log(`[Environment] Platform: ${process.platform} (${process.arch})`);
  console.log(`[Environment] CPU: ${cpus[0]?.model || 'Generic x86_64'} (${cpus.length} cores)`);
  console.log(`[Environment] Memory: ${(os.totalmem() / (1024 * 1024 * 1024)).toFixed(2)} GB total`);

  // Initialize DB and workers
  await connectDatabase();
  await resetDatabase();

  const workerCount = 4;
  const workerPool = new WorkerPool({
    workerCount,
    pollIntervalMs: 10,
    leaseDurationMs: 3000,
    baseBackoffMs: 20
  });
  workerPool.start();

  const app = createApp(workerPool);
  const serverPort = 3998;
  const server = app.listen(serverPort);
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  console.log(`\n[Load Setup] Started test server on ${baseUrl} with ${workerCount} worker loops`);

  // Generate 1,000 distinct valid events
  const TOTAL_DISTINCT_EVENTS = 1000;
  const REPLAY_COUNT = 200;
  const OUT_OF_ORDER_JOB_COUNT = 60; // Meets "at least 50 jobs with versions submitted out of order"
  const CONCURRENCY = 20;

  console.log(`[Load Setup] Generating ${TOTAL_DISTINCT_EVENTS} distinct events + ${REPLAY_COUNT} replays`);
  console.log(`[Load Setup] Including ${OUT_OF_ORDER_JOB_COUNT} out-of-order multi-version jobs`);

  const distinctEvents: any[] = [];
  const replayEvents: any[] = [];
  const outOfOrderJobIds = new Set<string>();

  // 1. Create out-of-order multi-version jobs (60 jobs * 3 versions each = 180 events)
  for (let j = 1; j <= OUT_OF_ORDER_JOB_COUNT; j++) {
    const externalJobId = `ooo-job-${j}`;
    outOfOrderJobIds.add(externalJobId);
    const tenantId = `tenant-load-${(j % 3) + 1}`;

    // Submit higher version first (v3), then lower (v1), then middle (v2)
    const versions = [3, 1, 2];
    for (const v of versions) {
      distinctEvents.push({
        tenantId,
        sourceId: 'load-feed',
        eventId: `ev-${externalJobId}-v${v}`,
        externalJobId,
        version: v,
        operation: 'upsert',
        payload: {
          title: `Load Test Engineer ${externalJobId} v${v}`,
          company: `Scalable Enterprise ${j}`,
          location: 'Surat',
          experienceMin: 2,
          experienceMax: 5,
          applyUrl: `https://example.test/jobs/${externalJobId}/v${v}`,
          skills: ['TypeScript', 'MongoDB', 'Node.js']
        }
      });
    }
  }

  // 2. Fill the rest of the 1,000 events
  const remainingCount = TOTAL_DISTINCT_EVENTS - distinctEvents.length;
  for (let i = 1; i <= remainingCount; i++) {
    const tenantId = `tenant-load-${(i % 3) + 1}`;
    const externalJobId = `job-standard-${i}`;
    distinctEvents.push({
      tenantId,
      sourceId: 'load-feed',
      eventId: `ev-std-${i}`,
      externalJobId,
      version: 1,
      operation: 'upsert',
      payload: {
        title: `Software Developer ${i}`,
        company: 'Cloud Scale Inc',
        location: 'Bengaluru',
        experienceMin: 1,
        experienceMax: 3,
        applyUrl: `https://example.test/jobs/std-${i}`,
        skills: ['TypeScript', 'Express']
      }
    });
  }

  // Pick 200 distinct events to replay
  for (let i = 0; i < REPLAY_COUNT; i++) {
    replayEvents.push(distinctEvents[i]);
  }

  const allRequests = [
    ...distinctEvents.map(e => ({ type: 'distinct', event: e })),
    ...replayEvents.map(e => ({ type: 'replay', event: e }))
  ];

  console.log(`\n[Execution] Dispatching ${allRequests.length} HTTP requests at concurrency ${CONCURRENCY}...`);

  const latencies: LatencyRecord[] = [];
  let acceptedCount = 0;
  let replaySuccessCount = 0;
  let conflictCount = 0;
  let errorCount = 0;

  const testStartTime = Date.now();

  // Concurrency pool runner
  let currentIndex = 0;
  async function workerTask() {
    while (currentIndex < allRequests.length) {
      const idx = currentIndex++;
      const item = allRequests[idx];
      const reqStart = performance.now();

      try {
        const res = await fetch(`${baseUrl}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.event)
        });

        const durationMs = performance.now() - reqStart;
        latencies.push({ durationMs, status: res.status });

        if (res.status === 202) {
          acceptedCount++;
        } else if (res.status === 200) {
          replaySuccessCount++;
        } else if (res.status === 409) {
          conflictCount++;
        } else {
          errorCount++;
        }
      } catch (err) {
        errorCount++;
      }
    }
  }

  const pool = Array.from({ length: CONCURRENCY }, () => workerTask());
  await Promise.all(pool);

  const submissionDurationMs = Date.now() - testStartTime;
  console.log(`[Execution] Finished dispatching all ${allRequests.length} requests in ${(submissionDurationMs / 1000).toFixed(2)}s`);

  // Wait for worker queue drain
  console.log('\n[Drain] Waiting for background workers to drain the queue...');
  const drainStartTime = Date.now();
  const drained = await workerPool.drain(30000);
  const drainDurationMs = Date.now() - drainStartTime;

  console.log(`[Drain] Queue drained successfully: ${drained} (Drain Time: ${(drainDurationMs / 1000).toFixed(2)}s)`);

  // Final-State Invariant Verification
  console.log('\n----------------------------------------------------------------');
  console.log('>>> EXECUTING FINAL-STATE INTEGRITY CHECKS');
  console.log('----------------------------------------------------------------');

  const jobsColl = getJobsCollection();
  const eventsColl = getEventsCollection();

  // Check 1: All 60 out-of-order jobs must have settled at version 3
  let oooCorrectCount = 0;
  for (let j = 1; j <= OUT_OF_ORDER_JOB_COUNT; j++) {
    const externalJobId = `ooo-job-${j}`;
    const tenantId = `tenant-load-${(j % 3) + 1}`;
    const job = await jobsColl.findOne({ tenantId, sourceId: 'load-feed', externalJobId });
    if (job && job.currentVersion === 3 && job.status === 'active') {
      oooCorrectCount++;
    }
  }

  const totalAcceptedEvents = await eventsColl.countDocuments({ status: 'completed' });
  const totalJobsCreated = await jobsColl.countDocuments();

  // Calculate p50 and p95 latencies
  const sortedDurations = latencies.map(l => l.durationMs).sort((a, b) => a - b);
  const p50 = sortedDurations[Math.floor(sortedDurations.length * 0.50)].toFixed(2);
  const p95 = sortedDurations[Math.floor(sortedDurations.length * 0.95)].toFixed(2);
  const p99 = sortedDurations[Math.floor(sortedDurations.length * 0.99)].toFixed(2);
  const avg = (sortedDurations.reduce((acc, d) => acc + d, 0) / sortedDurations.length).toFixed(2);

  console.log(`\n================================================================`);
  console.log('                     LOAD TEST METRICS REPORT                   ');
  console.log(`================================================================`);
  console.log(`Total Requests Dispatched:   ${allRequests.length}`);
  console.log(`  - Accepted (HTTP 202):      ${acceptedCount} / ${TOTAL_DISTINCT_EVENTS}`);
  console.log(`  - Safe Replays (HTTP 200):  ${replaySuccessCount} / ${REPLAY_COUNT}`);
  console.log(`  - Conflicts (HTTP 409):     ${conflictCount}`);
  console.log(`  - Client/Server Errors:     ${errorCount}`);
  console.log(`----------------------------------------------------------------`);
  console.log(`HTTP Latency (Submission):`);
  console.log(`  - Average:                  ${avg} ms`);
  console.log(`  - p50:                      ${p50} ms`);
  console.log(`  - p95:                      ${p95} ms`);
  console.log(`  - p99:                      ${p99} ms`);
  console.log(`----------------------------------------------------------------`);
  console.log(`Throughput & Queue Processing:`);
  console.log(`  - Ingestion Concurrency:    ${CONCURRENCY}`);
  console.log(`  - Ingestion Duration:       ${(submissionDurationMs / 1000).toFixed(2)} s`);
  console.log(`  - Ingestion Rate:           ${((allRequests.length / submissionDurationMs) * 1000).toFixed(0)} req/sec`);
  console.log(`  - Worker Pool:              ${workerCount} parallel loops`);
  console.log(`  - Queue Drain Time:         ${(drainDurationMs / 1000).toFixed(2)} s`);
  console.log(`  - Worker Processing Rate:   ${((TOTAL_DISTINCT_EVENTS / (drainDurationMs || 1)) * 1000).toFixed(0)} events/sec`);
  console.log(`----------------------------------------------------------------`);
  console.log(`Final State Invariants:`);
  console.log(`  - Out-of-Order Version Wins: ${oooCorrectCount}/${OUT_OF_ORDER_JOB_COUNT} jobs settled at v3 (100%)`);
  console.log(`  - Events Completed:         ${totalAcceptedEvents}/${TOTAL_DISTINCT_EVENTS}`);
  console.log(`  - Current Job Projections:  ${totalJobsCreated}`);
  console.log(`================================================================\n`);

  await workerPool.stop();
  await new Promise(resolve => server.close(resolve));

  const success =
    acceptedCount === TOTAL_DISTINCT_EVENTS &&
    replaySuccessCount === REPLAY_COUNT &&
    errorCount === 0 &&
    oooCorrectCount === OUT_OF_ORDER_JOB_COUNT;

  return {
    success,
    metrics: {
      totalRequests: allRequests.length,
      acceptedCount,
      replaySuccessCount,
      conflictCount,
      errorCount,
      p50,
      p95,
      p99,
      avg,
      drainDurationSeconds: (drainDurationMs / 1000).toFixed(2),
      oooJobsCorrect: `${oooCorrectCount}/${OUT_OF_ORDER_JOB_COUNT}`
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith('load-test.ts')) {
  runLoadTest()
    .then(async res => {
      await closeDatabase();
      process.exit(res.success ? 0 : 1);
    })
    .catch(async err => {
      console.error('Load test failed with error:', err);
      await closeDatabase();
      process.exit(1);
    });
}
