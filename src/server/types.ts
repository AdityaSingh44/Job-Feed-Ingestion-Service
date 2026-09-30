import { ObjectId } from 'mongodb';

export interface RawJobPayload {
  title: string;
  company: string;
  location: string;
  experienceMin: number;
  experienceMax: number;
  applyUrl: string;
  skills: string[];
}

export interface NormalizedJobPayload {
  title: string;
  company: string;
  location: string;
  experienceMin: number;
  experienceMax: number;
  applyUrl: string;
  skills: string[];
}

export type EventOperation = 'upsert' | 'archive';

export interface IngestionEventInput {
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: EventOperation;
  payload?: RawJobPayload;
}

export type EventStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'stale_skipped';

export interface AttemptRecord {
  attemptNumber: number;
  timestamp: Date;
  status: 'retry_scheduled' | 'permanent_failure' | 'retries_exhausted' | 'success' | 'stale_skipped';
  statusCode?: number;
  error?: string;
  workerId?: string;
}

export interface EventDocument {
  _id?: ObjectId;
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: EventOperation;
  payload?: NormalizedJobPayload;
  contentHash: string;
  status: EventStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  attemptHistory: AttemptRecord[];
  claimWorkerId: string | null;
  claimExpiresAt: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export type JobStatus = 'active' | 'archived';

export interface JobDocument {
  _id?: ObjectId;
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  currentVersion: number;
  status: JobStatus;
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

export interface ProviderPlanRule {
  description?: string;
  match: {
    tenantId?: string;
    sourceId?: string;
    externalJobId?: string;
    eventId?: string;
    version?: number;
    attempt?: number;
  };
  result: {
    status: number;
    message: string;
  };
}

export interface ValidationSuccess {
  valid: true;
  normalized: {
    tenantId: string;
    sourceId: string;
    eventId: string;
    externalJobId: string;
    version: number;
    operation: EventOperation;
    payload?: NormalizedJobPayload;
  };
}

export interface ValidationError {
  valid: false;
  error: string;
  field?: string;
}

export type ValidationResult = ValidationSuccess | ValidationError;
