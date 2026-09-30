import express, { Request, Response } from 'express';
import { ObjectId, MongoServerError } from 'mongodb';
import { getEventsCollection, getJobsCollection, isDatabaseConnected, resetDatabase } from './db.js';
import { computeCanonicalHash } from './hasher.js';
import { validateAndNormalizeEvent } from './validation.js';
import { WorkerPool } from './worker.js';
import { EventDocument } from './types.js';

export function createApp(workerPool?: WorkerPool) {
  const app = express();
  app.use(express.json());

  // 1. POST /events: Ingest single event
  app.post('/events', async (req: Request, res: Response) => {
    // A. Validation
    const validation = validateAndNormalizeEvent(req.body);
    if (!validation.valid) {
      res.status(400).json({
        error: validation.error,
        field: validation.field
      });
      return;
    }

    const normalized = validation.normalized;
    const incomingHash = computeCanonicalHash(req.body);
    const events = getEventsCollection();

    // B. Replay safety check before treating request as new work
    const existing = await events.findOne({
      tenantId: normalized.tenantId,
      sourceId: normalized.sourceId,
      eventId: normalized.eventId
    });

    if (existing) {
      if (existing.contentHash === incomingHash) {
        // Idempotent exact replay -> 200 OK, no new work created
        res.status(200).json({
          status: 'replayed',
          tenantId: existing.tenantId,
          sourceId: existing.sourceId,
          eventId: existing.eventId,
          message: 'Event already accepted; duplicate request acknowledged safely'
        });
        return;
      } else {
        // Conflicting reuse -> 409 Conflict
        res.status(409).json({
          error: 'Event identity already exists with conflicting content',
          tenantId: normalized.tenantId,
          sourceId: normalized.sourceId,
          eventId: normalized.eventId
        });
        return;
      }
    }

    // C. Durable Acceptance: insert pending work item
    const now = new Date();
    const eventDoc: EventDocument = {
      tenantId: normalized.tenantId,
      sourceId: normalized.sourceId,
      eventId: normalized.eventId,
      externalJobId: normalized.externalJobId,
      version: normalized.version,
      operation: normalized.operation,
      payload: normalized.payload,
      contentHash: incomingHash,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      lastError: null,
      attemptHistory: [],
      claimWorkerId: null,
      claimExpiresAt: null,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };

    try {
      await events.insertOne(eventDoc);
      // Return 202 Accepted only after durable record
      res.status(202).json({
        status: 'accepted',
        tenantId: normalized.tenantId,
        sourceId: normalized.sourceId,
        eventId: normalized.eventId,
        externalJobId: normalized.externalJobId,
        message: 'Event accepted and durably queued for asynchronous processing'
      });
    } catch (err: unknown) {
      if (err instanceof MongoServerError && err.code === 11000) {
        // Concurrent race condition: another request just inserted this event identity!
        const racedExisting = await events.findOne({
          tenantId: normalized.tenantId,
          sourceId: normalized.sourceId,
          eventId: normalized.eventId
        });

        if (racedExisting && racedExisting.contentHash === incomingHash) {
          res.status(200).json({
            status: 'replayed',
            tenantId: racedExisting.tenantId,
            sourceId: racedExisting.sourceId,
            eventId: racedExisting.eventId,
            message: 'Event already accepted; duplicate request acknowledged safely'
          });
          return;
        } else {
          res.status(409).json({
            error: 'Event identity already exists with conflicting content',
            tenantId: normalized.tenantId,
            sourceId: normalized.sourceId,
            eventId: normalized.eventId
          });
          return;
        }
      }

      console.error('[POST /events] Unexpected error during insertion:', err);
      res.status(500).json({ error: 'Internal server error recording event' });
    }
  });

  // 2. GET /events/:eventId: Retrieve event state, attempt count, and last error
  app.get('/events/:eventId', async (req: Request, res: Response) => {
    const eventId = req.params.eventId;
    const tenantId = req.query.tenantId as string;
    const sourceId = req.query.sourceId as string;

    if (!tenantId || !sourceId) {
      res.status(400).json({
        error: "Query parameters 'tenantId' and 'sourceId' are required"
      });
      return;
    }

    const events = getEventsCollection();
    const event = await events.findOne({ tenantId, sourceId, eventId });

    if (!event) {
      res.status(404).json({
        error: `Event not found for tenant '${tenantId}', source '${sourceId}', eventId '${eventId}'`
      });
      return;
    }

    res.json({
      tenantId: event.tenantId,
      sourceId: event.sourceId,
      eventId: event.eventId,
      externalJobId: event.externalJobId,
      version: event.version,
      operation: event.operation,
      status: event.status,
      attemptCount: event.attemptCount,
      lastError: event.lastError,
      attemptHistory: event.attemptHistory,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      completedAt: event.completedAt
    });
  });

  // 3. GET /jobs: List jobs with tenant isolation, status filter, and deterministic pagination
  app.get('/jobs', async (req: Request, res: Response) => {
    const tenantId = req.query.tenantId as string;
    if (!tenantId || tenantId.trim().length === 0) {
      res.status(400).json({
        error: "Query parameter 'tenantId' is required and must be nonblank"
      });
      return;
    }

    const sourceId = req.query.sourceId as string | undefined;
    const rawStatus = (req.query.status as string) || 'active';
    const limitQuery = parseInt(req.query.limit as string, 10);
    const limit = isNaN(limitQuery) || limitQuery <= 0 ? 20 : Math.min(limitQuery, 100);
    const cursor = req.query.cursor as string | undefined;

    const filter: Record<string, unknown> = {
      tenantId: tenantId.trim()
    };

    if (sourceId && sourceId.trim().length > 0) {
      filter.sourceId = sourceId.trim();
    }

    if (rawStatus === 'active') {
      filter.status = 'active';
    } else if (rawStatus === 'archived') {
      filter.status = 'archived';
    } else if (rawStatus === 'all') {
      // no status filter
    } else {
      res.status(400).json({
        error: "Invalid status parameter. Must be 'active', 'archived', or 'all'"
      });
      return;
    }

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
        filter._id = { $gt: new ObjectId(decoded) };
      } catch {
        res.status(400).json({ error: 'Invalid cursor parameter' });
        return;
      }
    }

    const jobs = getJobsCollection();
    const docs = await jobs
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const items = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore
      ? Buffer.from(items[items.length - 1]._id.toHexString()).toString('base64')
      : null;

    res.json({
      items,
      nextCursor,
      hasMore,
      limit
    });
  });

  // 4. GET /health: Service and dependency readiness check
  app.get('/health', async (_req: Request, res: Response) => {
    const dbConnected = isDatabaseConnected();
    const workerStatus = workerPool?.getStatus() ?? {
      isRunning: false,
      workerCount: 0,
      processedCount: 0
    };

    const isHealthy = dbConnected && workerStatus.isRunning;
    const statusCode = isHealthy ? 200 : 503;

    res.status(statusCode).json({
      status: isHealthy ? 'UP' : 'DEGRADED',
      database: {
        status: dbConnected ? 'CONNECTED' : 'DISCONNECTED',
        name: 'jobfeed'
      },
      workers: {
        status: workerStatus.isRunning ? 'RUNNING' : 'STOPPED',
        count: workerStatus.workerCount,
        processedCount: workerStatus.processedCount
      },
      timestamp: new Date().toISOString()
    });
  });

  // 5. API Dashboard & Control endpoints
  app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      const events = getEventsCollection();
      const jobs = getJobsCollection();

      const [
        totalEvents,
        pendingEvents,
        processingEvents,
        completedEvents,
        failedEvents,
        totalJobs,
        activeJobs,
        archivedJobs,
        recentEvents,
        recentJobs
      ] = await Promise.all([
        events.countDocuments(),
        events.countDocuments({ status: 'pending' }),
        events.countDocuments({ status: 'processing' }),
        events.countDocuments({ status: 'completed' }),
        events.countDocuments({ status: 'failed' }),
        jobs.countDocuments(),
        jobs.countDocuments({ status: 'active' }),
        jobs.countDocuments({ status: 'archived' }),
        events.find().sort({ updatedAt: -1 }).limit(10).toArray(),
        jobs.find().sort({ updatedAt: -1 }).limit(10).toArray(),
      ]);

      res.json({
        events: {
          total: totalEvents,
          pending: pendingEvents,
          processing: processingEvents,
          completed: completedEvents,
          failed: failedEvents,
        },
        jobs: {
          total: totalJobs,
          active: activeJobs,
          archived: archivedJobs,
        },
        workerStatus: workerPool?.getStatus(),
        recentEvents,
        recentJobs
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/reset', async (_req: Request, res: Response) => {
    try {
      await resetDatabase();
      res.json({ status: 'ok', message: 'Database reset successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
