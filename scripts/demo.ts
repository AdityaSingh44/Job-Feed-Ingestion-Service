import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDatabase, closeDatabase, resetDatabase, getEventsCollection, getJobsCollection } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { WorkerPool } from '../src/server/worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ScenarioRequest {
  id: string;
  description: string;
  expectedStatus: number;
  event: any;
}

interface ScenarioFixture {
  description: string;
  phase1: ScenarioRequest[];
  phase2: ScenarioRequest[];
}

export async function runDemoScenario(targetBaseUrl?: string) {
  console.log('================================================================');
  console.log('   RELIABLE JOB-FEED INGESTION SERVICE - OFFICIAL DEMO SCENARIO  ');
  console.log('================================================================\n');

  // Load fixture
  const fixturePath = path.resolve(__dirname, '../fixtures/demo-scenario.json');
  if (!existsSync(fixturePath)) {
    throw new Error(`Demo fixture not found at: ${fixturePath}`);
  }
  const fixture: ScenarioFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

  let localServer: any = null;
  let workerPool: WorkerPool | null = null;
  let baseUrl = targetBaseUrl;

  if (!baseUrl) {
    // Spin up local instance for standalone CLI run
    console.log('[Setup] Initializing MongoDB and worker pool for demo run...');
    await connectDatabase();
    await resetDatabase();

    workerPool = new WorkerPool({
      workerCount: 2,
      pollIntervalMs: 20,
      leaseDurationMs: 2000,
      baseBackoffMs: 50
    });
    workerPool.start();

    const app = createApp(workerPool);
    const serverPort = 3999;
    localServer = app.listen(serverPort);
    baseUrl = `http://127.0.0.1:${serverPort}`;
    console.log(`[Setup] Standalone test server running on ${baseUrl}\n`);
  }

  const results: Array<{
    id: string;
    description: string;
    expectedStatus: number;
    actualStatus: number;
    statusMatch: boolean;
    phase: string;
  }> = [];

  // Helper to post an event
  async function submitEvent(reqItem: ScenarioRequest, phaseName: string) {
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqItem.event)
    });

    const statusMatch = res.status === reqItem.expectedStatus;
    const body = await res.json().catch(() => ({}));

    results.push({
      id: reqItem.id,
      description: reqItem.description,
      expectedStatus: reqItem.expectedStatus,
      actualStatus: res.status,
      statusMatch,
      phase: phaseName
    });

    const statusIcon = statusMatch ? '✓ PASS' : '✗ FAIL';
    console.log(`  [${reqItem.id}] (${phaseName}) HTTP ${res.status} [Expected ${reqItem.expectedStatus}] - ${statusIcon}: ${reqItem.description}`);
  }

  // --- PHASE 1 ---
  console.log('----------------------------------------------------------------');
  console.log('>>> SUBMITTING PHASE 1: 17 Requests in Fixture Order');
  console.log('----------------------------------------------------------------');

  for (const reqItem of fixture.phase1) {
    await submitEvent(reqItem, 'Phase 1');
  }

  console.log('\n[Phase 1] Waiting for background workers to drain and settle...');
  if (workerPool) {
    const drained = await workerPool.drain(10000);
    console.log(`[Phase 1] Worker drain completed (drained: ${drained}).`);
  } else {
    // Wait via polling stats if using external server
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  // --- PHASE 2 ---
  console.log('\n----------------------------------------------------------------');
  console.log('>>> SUBMITTING PHASE 2: 3 Delayed Requests in Fixture Order');
  console.log('----------------------------------------------------------------');

  for (const reqItem of fixture.phase2) {
    await submitEvent(reqItem, 'Phase 2');
  }

  console.log('\n[Phase 2] Waiting for background workers to drain and settle...');
  if (workerPool) {
    const drained = await workerPool.drain(10000);
    console.log(`[Phase 2] Worker drain completed (drained: ${drained}).`);
  } else {
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  // --- VERIFY SETTLED OUTCOMES ---
  console.log('\n----------------------------------------------------------------');
  console.log('>>> VERIFYING SETTLED JOB AND EVENT PROJECTIONS');
  console.log('----------------------------------------------------------------');

  const eventsColl = getEventsCollection();
  const jobsColl = getJobsCollection();

  const assertions: Array<{ name: string; passed: boolean; details: string }> = [];

  // Check 1: Alpha job v2 active under tenant-a, main source
  const jobAlpha = await jobsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', externalJobId: 'alpha' });
  assertions.push({
    name: 'Job alpha: version advanced to 2, status active',
    passed: jobAlpha?.currentVersion === 2 && jobAlpha?.status === 'active',
    details: `Version: ${jobAlpha?.currentVersion}, Status: ${jobAlpha?.status}`
  });

  // Check 2: Tenant isolation - Alpha job under tenant-b
  const jobAlphaB = await jobsColl.findOne({ tenantId: 'tenant-b', sourceId: 'main', externalJobId: 'alpha' });
  assertions.push({
    name: 'Tenant isolation: job alpha in tenant-b is distinct from tenant-a',
    passed: jobAlphaB?.tenantId === 'tenant-b' && jobAlphaB?.company === 'Tenant B Corp',
    details: `Tenant: ${jobAlphaB?.tenantId}, Company: ${jobAlphaB?.company}`
  });

  // Check 3: Source isolation - Alpha job under tenant-a, source partner
  const jobAlphaPartner = await jobsColl.findOne({ tenantId: 'tenant-a', sourceId: 'partner', externalJobId: 'alpha' });
  assertions.push({
    name: 'Source isolation: job alpha under source partner is distinct from main',
    passed: jobAlphaPartner?.sourceId === 'partner' && jobAlphaPartner?.company === 'Partner Agency',
    details: `Source: ${jobAlphaPartner?.sourceId}, Company: ${jobAlphaPartner?.company}`
  });

  // Check 4: Out-of-order versioning - Beta settled at v3 (v2 skipped as stale)
  const jobBeta = await jobsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', externalJobId: 'beta' });
  const eventBetaV2 = await eventsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', eventId: 'event-beta-v2' });
  assertions.push({
    name: 'Out-of-order: beta settled at version 3; version 2 was skipped as stale',
    passed: jobBeta?.currentVersion === 3 && eventBetaV2?.status === 'completed',
    details: `Beta Version: ${jobBeta?.currentVersion}, Title: "${jobBeta?.title}", V2 Event Status: ${eventBetaV2?.status}`
  });

  // Check 5: Archive-before-upsert & Delayed Reactivation - Gamma reactivated at v3
  const jobGamma = await jobsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', externalJobId: 'gamma' });
  const eventGammaV1 = await eventsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', eventId: 'event-gamma-v1' });
  assertions.push({
    name: 'Archive tombstone & reactivation: gamma settled at v3 active; v1 was prevented from reactivating v2 archive',
    passed: jobGamma?.currentVersion === 3 && jobGamma?.status === 'active' && eventGammaV1?.status === 'completed',
    details: `Gamma Version: ${jobGamma?.currentVersion}, Status: ${jobGamma?.status}`
  });

  // Check 6: Provider retry success - Delta settled active v1 with 2 attempts
  const jobDelta = await jobsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', externalJobId: 'delta' });
  const eventDelta = await eventsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', eventId: 'event-delta-v1' });
  assertions.push({
    name: 'Provider retry: delta succeeded on attempt 2 after transient 503',
    passed: jobDelta?.currentVersion === 1 && eventDelta?.status === 'completed' && eventDelta?.attemptCount === 2,
    details: `Delta Job Status: ${jobDelta?.status}, Attempts: ${eventDelta?.attemptCount}`
  });

  // Check 7: Permanent failure 422 - Epsilon terminal failed, no job projection
  const jobEpsilon = await jobsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', externalJobId: 'epsilon' });
  const eventEpsilon = await eventsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', eventId: 'event-epsilon-v1' });
  assertions.push({
    name: 'Permanent 422 failure: epsilon terminal failed, zero job projection created',
    passed: jobEpsilon === null && eventEpsilon?.status === 'failed',
    details: `Job Exists: ${jobEpsilon !== null}, Event Status: ${eventEpsilon?.status}, Last Error: ${eventEpsilon?.lastError}`
  });

  // Check 8: Retry exhaustion 429 - Zeta terminal failed after 3 attempts, no job projection
  const jobZeta = await jobsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', externalJobId: 'zeta' });
  const eventZeta = await eventsColl.findOne({ tenantId: 'tenant-a', sourceId: 'main', eventId: 'event-zeta-v1' });
  assertions.push({
    name: 'Retry exhaustion: zeta terminal failed after 3 attempts, zero job projection created',
    passed: jobZeta === null && eventZeta?.status === 'failed' && eventZeta?.attemptCount === 3,
    details: `Job Exists: ${jobZeta !== null}, Event Status: ${eventZeta?.status}, Attempts: ${eventZeta?.attemptCount}`
  });

  // Print assertion checklist
  for (const a of assertions) {
    const icon = a.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${icon}: ${a.name} (${a.details})`);
  }

  const allSubmissionsPassed = results.every(r => r.statusMatch);
  const allAssertionsPassed = assertions.every(a => a.passed);
  const totalPassed = allSubmissionsPassed && allAssertionsPassed;

  console.log('\n================================================================');
  console.log(`DEMO EXECUTION COMPLETE: ${totalPassed ? 'ALL CHECKS PASSED (20/20 HTTP, 8/8 INVARIANTS)' : 'SOME CHECKS FAILED'}`);
  console.log('================================================================\n');

  if (workerPool) {
    await workerPool.stop();
  }
  if (localServer) {
    await new Promise(resolve => localServer.close(resolve));
  }

  return {
    results,
    assertions,
    passed: totalPassed
  };
}

if (process.argv[1] && process.argv[1].endsWith('demo.ts')) {
  runDemoScenario()
    .then(async res => {
      await closeDatabase();
      process.exit(res.passed ? 0 : 1);
    })
    .catch(async err => {
      console.error('Demo failed with error:', err);
      await closeDatabase();
      process.exit(1);
    });
}
