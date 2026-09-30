import { MongoClient, Db, Collection } from 'mongodb';
import { EventDocument, JobDocument } from './types.js';

let client: MongoClient | null = null;
let db: Db | null = null;
let memoryServer: any = null;
let isConnected = false;

export async function connectDatabase(customUri?: string): Promise<{ client: MongoClient; db: Db }> {
  if (client && db && isConnected) {
    return { client, db };
  }

  let uri = customUri || process.env.MONGODB_URI;

  if (!uri) {
    // Spin up real embedded MongoDB via MongoMemoryServer
    try {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      memoryServer = await MongoMemoryServer.create();
      uri = memoryServer.getUri();
      console.log(`[Database] Embedded real MongoDB started at ${uri}`);
    } catch (err) {
      console.error('[Database] Failed to launch MongoMemoryServer, falling back to localhost:27017:', err);
      uri = 'mongodb://127.0.0.1:27017/jobfeed';
    }
  }

  const connectionUri = uri || 'mongodb://127.0.0.1:27017/jobfeed';
  client = new MongoClient(connectionUri, {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await client.connect();
  db = client.db(process.env.MONGODB_DB_NAME || 'jobfeed');
  isConnected = true;

  // Initialize indexes
  await initIndexes(db);
  console.log(`[Database] Connected successfully to ${db.databaseName}`);

  return { client, db };
}

export async function initIndexes(database: Db): Promise<void> {
  const events = database.collection<EventDocument>('events');
  const jobs = database.collection<JobDocument>('jobs');

  // Events collection indexes
  await events.createIndex(
    { tenantId: 1, sourceId: 1, eventId: 1 },
    { unique: true, name: 'idx_events_identity' }
  );

  await events.createIndex(
    { status: 1, nextAttemptAt: 1, claimExpiresAt: 1 },
    { name: 'idx_events_claim' }
  );

  await events.createIndex(
    { tenantId: 1, sourceId: 1, externalJobId: 1, version: 1 },
    { name: 'idx_events_job_version' }
  );

  // Jobs collection indexes
  await jobs.createIndex(
    { tenantId: 1, sourceId: 1, externalJobId: 1 },
    { unique: true, name: 'idx_jobs_identity' }
  );

  await jobs.createIndex(
    { tenantId: 1, status: 1, _id: 1 },
    { name: 'idx_jobs_tenant_status' }
  );

  await jobs.createIndex(
    { tenantId: 1, sourceId: 1, status: 1, _id: 1 },
    { name: 'idx_jobs_tenant_source_status' }
  );
}

export function getDatabase(): Db {
  if (!db) {
    throw new Error('Database not initialized. Call connectDatabase() first.');
  }
  return db;
}

export function getEventsCollection(): Collection<EventDocument> {
  return getDatabase().collection<EventDocument>('events');
}

export function getJobsCollection(): Collection<JobDocument> {
  return getDatabase().collection<JobDocument>('jobs');
}

export function isDatabaseConnected(): boolean {
  return isConnected && client !== null;
}

export async function resetDatabase(): Promise<void> {
  if (!db) return;
  await db.collection('events').deleteMany({});
  await db.collection('jobs').deleteMany({});
}

export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    isConnected = false;
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
