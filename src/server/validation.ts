import { IngestionEventInput, NormalizedJobPayload, ValidationResult } from './types.js';

function hasSurroundingWhitespace(val: string): boolean {
  return /^\s|\s$/.test(val);
}

function isValidIdentifier(val: unknown): { valid: boolean; error?: string } {
  if (typeof val !== 'string') {
    return { valid: false, error: 'Must be a string' };
  }
  if (val.trim().length === 0) {
    return { valid: false, error: 'Must be nonblank' };
  }
  if (hasSurroundingWhitespace(val)) {
    return { valid: false, error: 'Surrounding whitespace is not permitted; identifiers must be exact' };
  }
  return { valid: true };
}

export function validateAndNormalizeEvent(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const input = raw as Partial<IngestionEventInput>;

  // 1. Validate identifiers
  const idFields = ['tenantId', 'sourceId', 'eventId', 'externalJobId'] as const;
  for (const field of idFields) {
    const val = input[field];
    const check = isValidIdentifier(val);
    if (!check.valid) {
      return { valid: false, field, error: `Invalid ${field}: ${check.error}` };
    }
  }

  const tenantId = input.tenantId as string;
  const sourceId = input.sourceId as string;
  const eventId = input.eventId as string;
  const externalJobId = input.externalJobId as string;

  // 2. Validate version
  const version = input.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version <= 0 ||
    version > Number.MAX_SAFE_INTEGER
  ) {
    return {
      valid: false,
      field: 'version',
      error: 'version must be a positive safe integer (1, 2, ...)'
    };
  }

  // 3. Validate operation
  const operation = input.operation;
  if (operation !== 'upsert' && operation !== 'archive') {
    return {
      valid: false,
      field: 'operation',
      error: "operation must be either 'upsert' or 'archive'"
    };
  }

  // 4. Archive operation checks
  if (operation === 'archive') {
    if (input.payload !== undefined && input.payload !== null && Object.keys(input.payload).length > 0) {
      return {
        valid: false,
        field: 'payload',
        error: 'An archive operation must omit the payload'
      };
    }

    return {
      valid: true,
      normalized: {
        tenantId,
        sourceId,
        eventId,
        externalJobId,
        version,
        operation: 'archive'
      }
    };
  }

  // 5. Upsert operation checks
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      field: 'payload',
      error: 'An upsert operation requires a valid payload object'
    };
  }

  // Title, company, location: must be nonblank after trimming
  const stringFields = ['title', 'company', 'location'] as const;
  for (const f of stringFields) {
    const val = payload[f];
    if (typeof val !== 'string' || val.trim().length === 0) {
      return {
        valid: false,
        field: `payload.${f}`,
        error: `payload.${f} must be a nonblank string after trimming`
      };
    }
  }

  const title = payload.title.trim();
  const company = payload.company.trim();
  const location = payload.location.trim();

  // Experience: integers 0 to 50 with min <= max
  const expMin = payload.experienceMin;
  const expMax = payload.experienceMax;

  if (
    typeof expMin !== 'number' ||
    !Number.isInteger(expMin) ||
    expMin < 0 ||
    expMin > 50
  ) {
    return {
      valid: false,
      field: 'payload.experienceMin',
      error: 'payload.experienceMin must be an integer between 0 and 50'
    };
  }

  if (
    typeof expMax !== 'number' ||
    !Number.isInteger(expMax) ||
    expMax < 0 ||
    expMax > 50
  ) {
    return {
      valid: false,
      field: 'payload.experienceMax',
      error: 'payload.experienceMax must be an integer between 0 and 50'
    };
  }

  if (expMin > expMax) {
    return {
      valid: false,
      field: 'payload.experienceMin',
      error: `payload.experienceMin (${expMin}) cannot be greater than experienceMax (${expMax})`
    };
  }

  // applyUrl: must use HTTPS
  const applyUrl = payload.applyUrl;
  if (typeof applyUrl !== 'string' || applyUrl.trim().length === 0) {
    return {
      valid: false,
      field: 'payload.applyUrl',
      error: 'payload.applyUrl must be a nonblank string'
    };
  }

  try {
    const parsedUrl = new URL(applyUrl.trim());
    if (parsedUrl.protocol !== 'https:') {
      return {
        valid: false,
        field: 'payload.applyUrl',
        error: 'payload.applyUrl must use HTTPS protocol'
      };
    }
  } catch {
    return {
      valid: false,
      field: 'payload.applyUrl',
      error: 'payload.applyUrl must be a valid URL string'
    };
  }

  // skills: array of nonblank strings.
  // "Trim display strings and normalize skills to trimmed lowercase values with duplicates removed, preserving first occurrence order."
  const rawSkills = payload.skills;
  if (!Array.isArray(rawSkills) || rawSkills.length === 0) {
    return {
      valid: false,
      field: 'payload.skills',
      error: 'payload.skills must be a non-empty array of nonblank strings'
    };
  }

  const normalizedSkills: string[] = [];
  const seenSkills = new Set<string>();

  for (let i = 0; i < rawSkills.length; i++) {
    const item = rawSkills[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      return {
        valid: false,
        field: `payload.skills[${i}]`,
        error: `payload.skills[${i}] must be a nonblank string`
      };
    }

    const normalizedItem = item.trim().toLowerCase();
    if (!seenSkills.has(normalizedItem)) {
      seenSkills.add(normalizedItem);
      normalizedSkills.push(normalizedItem);
    }
  }

  const normalizedPayload: NormalizedJobPayload = {
    title,
    company,
    location,
    experienceMin: expMin,
    experienceMax: expMax,
    applyUrl: applyUrl.trim(),
    skills: normalizedSkills
  };

  return {
    valid: true,
    normalized: {
      tenantId,
      sourceId,
      eventId,
      externalJobId,
      version,
      operation: 'upsert',
      payload: normalizedPayload
    }
  };
}
