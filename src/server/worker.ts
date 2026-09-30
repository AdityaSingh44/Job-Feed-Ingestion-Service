import { Db } from 'mongodb';
import { getEventsCollection, getJobsCollection } from './db.js';
import { evaluateProviderPlan } from './provider.js';
import { EventDocument } from './types.js';

export interface WorkerOptions {
  workerCount?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  baseBackoffMs?: number;
  crashAfterProjectionEventId?: string | null;
}

export class WorkerPool {
  private workerCount: number;
  private pollIntervalMs: number;
  private leaseDurationMs: number;
  private baseBackoffMs: number;
  private isRunning = false;
  private workerLoops: Promise<void>[] = [];
  private abortControllers: AbortController[] = [];
  public crashAfterProjectionEventId: string | null = null;
  public processedCount = 0;
  public crashSimulatedCount = 0;

  constructor(options: WorkerOptions = {}) {
    this.workerCount = options.workerCount ?? 2;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.leaseDurationMs = options.leaseDurationMs ?? 5000;
    this.baseBackoffMs = options.baseBackoffMs ?? 200;
    this.crashAfterProjectionEventId = options.crashAfterProjectionEventId ?? null;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    for (let i = 1; i <= this.workerCount; i++) {
      const workerId = `worker-${i}`;
      const ac = new AbortController();
      this.abortControllers.push(ac);
      this.workerLoops.push(this.runWorkerLoop(workerId, ac.signal));
    }

    console.log(`[WorkerPool] Started ${this.workerCount} competing worker loops`);
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    for (const ac of this.abortControllers) {
      ac.abort();
    }
    await Promise.all(this.workerLoops);
    this.workerLoops = [];
    this.abortControllers = [];
    console.log('[WorkerPool] Stopped all workers');
  }

  public getStatus() {
    return {
      isRunning: this.isRunning,
      workerCount: this.workerCount,
      processedCount: this.processedCount,
      crashSimulatedCount: this.crashSimulatedCount,
      pollIntervalMs: this.pollIntervalMs,
      leaseDurationMs: this.leaseDurationMs,
      baseBackoffMs: this.baseBackoffMs,
    };
  }

  /**
   * Waits until all pending and processing events have been completely settled.
   */
  public async drain(timeoutMs = 15000): Promise<boolean> {
    const events = getEventsCollection();
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const pendingOrProcessing = await events.countDocuments({
        status: { $in: ['pending', 'processing'] }
      });

      if (pendingOrProcessing === 0) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return false;
  }

  private async runWorkerLoop(workerId: string, signal: AbortSignal): Promise<void> {
    while (this.isRunning && !signal.aborted) {
      try {
        const didWork = await this.claimAndProcessOne(workerId);
        if (!didWork) {
          await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch (err) {
        if (!signal.aborted) {
          console.error(`[${workerId}] Error in worker loop:`, err);
          await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        }
      }
    }
  }

  /**
   * Atomically claims an available pending or expired lease event, then executes processing.
   */
  public async claimAndProcessOne(workerId: string): Promise<boolean> {
    const events = getEventsCollection();
    const jobs = getJobsCollection();
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + this.leaseDurationMs);

    // Atomic claim: selects pending items ready for attempt OR abandoned/expired leases
    const event = await events.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', nextAttemptAt: { $lte: now } },
          { status: 'processing', claimExpiresAt: { $lte: now } }
        ]
      },
      {
        $set: {
          status: 'processing',
          claimWorkerId: workerId,
          claimExpiresAt: claimExpiresAt,
          updatedAt: now
        },
        $inc: { attemptCount: 1 }
      },
      {
        sort: { nextAttemptAt: 1, createdAt: 1 },
        returnDocument: 'after'
      }
    );

    if (!event) {
      return false; // No work available right now
    }

    await this.processClaimedEvent(event, workerId);
    this.processedCount++;
    return true;
  }

  private async processClaimedEvent(event: EventDocument, workerId: string): Promise<void> {
    const events = getEventsCollection();
    const jobs = getJobsCollection();
    const now = new Date();

    // 1. Check if event is stale before external verification
    const currentJob = await jobs.findOne({
      tenantId: event.tenantId,
      sourceId: event.sourceId,
      externalJobId: event.externalJobId
    });

    if (currentJob && currentJob.currentVersion >= event.version) {
      // Lower or equal stale work skips verification and completes as a no-op
      await events.updateOne(
        { _id: event._id },
        {
          $set: {
            status: 'completed',
            claimWorkerId: null,
            claimExpiresAt: null,
            completedAt: now,
            updatedAt: now
          },
          $push: {
            attemptHistory: {
              attemptNumber: event.attemptCount,
              timestamp: now,
              status: 'stale_skipped',
              workerId
            }
          }
        }
      );
      return;
    }

    // 2. Run external provider verification
    const verification = evaluateProviderPlan(event, event.attemptCount);

    if (verification.isPermanentFailure) {
      // Permanent failure (422) - retain terminal failed event, do not change job projection
      await events.updateOne(
        { _id: event._id },
        {
          $set: {
            status: 'failed',
            lastError: verification.message,
            claimWorkerId: null,
            claimExpiresAt: null,
            updatedAt: now
          },
          $push: {
            attemptHistory: {
              attemptNumber: event.attemptCount,
              timestamp: now,
              status: 'permanent_failure',
              statusCode: verification.statusCode,
              error: verification.message,
              workerId
            }
          }
        }
      );
      return;
    }

    if (verification.isTransientFailure) {
      // Transient failure (429 or 503)
      if (event.attemptCount >= event.maxAttempts) {
        // Exhausted retries -> terminal failed
        await events.updateOne(
          { _id: event._id },
          {
            $set: {
              status: 'failed',
              lastError: `Exhausted max ${event.maxAttempts} attempts. Final error: ${verification.message}`,
              claimWorkerId: null,
              claimExpiresAt: null,
              updatedAt: now
            },
            $push: {
              attemptHistory: {
                attemptNumber: event.attemptCount,
                timestamp: now,
                status: 'retries_exhausted',
                statusCode: verification.statusCode,
                error: verification.message,
                workerId
              }
            }
          }
        );
      } else {
        // Schedule retry with exponential backoff
        const backoffDelay = this.baseBackoffMs * Math.pow(2, event.attemptCount - 1);
        const nextAttemptAt = new Date(now.getTime() + backoffDelay);

        await events.updateOne(
          { _id: event._id },
          {
            $set: {
              status: 'pending',
              lastError: verification.message,
              claimWorkerId: null,
              claimExpiresAt: null,
              nextAttemptAt,
              updatedAt: now
            },
            $push: {
              attemptHistory: {
                attemptNumber: event.attemptCount,
                timestamp: now,
                status: 'retry_scheduled',
                statusCode: verification.statusCode,
                error: verification.message,
                workerId
              }
            }
          }
        );
      }
      return;
    }

    // 3. Verification succeeded -> Apply Job Projection Atomically
    // Using MongoDB aggregation update pipeline to guarantee version monotonicity
    await jobs.updateOne(
      {
        tenantId: event.tenantId,
        sourceId: event.sourceId,
        externalJobId: event.externalJobId
      },
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
                event.payload?.title ?? null,
                '$title'
              ]
            },
            company: {
              $cond: [
                {
                  $and: [
                    { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
                    { $eq: [event.operation, 'upsert'] }
                  ]
                },
                event.payload?.company ?? null,
                '$company'
              ]
            },
            location: {
              $cond: [
                {
                  $and: [
                    { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
                    { $eq: [event.operation, 'upsert'] }
                  ]
                },
                event.payload?.location ?? null,
                '$location'
              ]
            },
            experienceMin: {
              $cond: [
                {
                  $and: [
                    { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
                    { $eq: [event.operation, 'upsert'] }
                  ]
                },
                event.payload?.experienceMin ?? null,
                '$experienceMin'
              ]
            },
            experienceMax: {
              $cond: [
                {
                  $and: [
                    { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
                    { $eq: [event.operation, 'upsert'] }
                  ]
                },
                event.payload?.experienceMax ?? null,
                '$experienceMax'
              ]
            },
            applyUrl: {
              $cond: [
                {
                  $and: [
                    { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
                    { $eq: [event.operation, 'upsert'] }
                  ]
                },
                event.payload?.applyUrl ?? null,
                '$applyUrl'
              ]
            },
            skills: {
              $cond: [
                {
                  $and: [
                    { $gt: [event.version, { $ifNull: ['$currentVersion', -1] }] },
                    { $eq: [event.operation, 'upsert'] }
                  ]
                },
                event.payload?.skills ?? [],
                '$skills'
              ]
            },
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

    // 4. Deliberate crash hook test check
    if (this.crashAfterProjectionEventId === event.eventId) {
      this.crashSimulatedCount++;
      // Clear hook so subsequent retry can succeed
      this.crashAfterProjectionEventId = null;
      throw new Error(`[SIMULATED_CRASH] Deliberate worker crash after projection write for event ${event.eventId}`);
    }

    // 5. Acknowledge and finalize event
    await events.updateOne(
      { _id: event._id },
      {
        $set: {
          status: 'completed',
          claimWorkerId: null,
          claimExpiresAt: null,
          completedAt: now,
          updatedAt: now
        },
        $push: {
          attemptHistory: {
            attemptNumber: event.attemptCount,
            timestamp: now,
            status: 'success',
            statusCode: 200,
            workerId
          }
        }
      }
    );
  }
}
