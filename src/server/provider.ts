import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventDocument, ProviderPlanRule } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let defaultRules: ProviderPlanRule[] = [];

function loadDefaultPlan(): ProviderPlanRule[] {
  if (defaultRules.length > 0) {
    return defaultRules;
  }

  const possiblePaths = [
    path.resolve(process.cwd(), 'fixtures/provider-plan.json'),
    path.resolve(process.cwd(), '../fixtures/provider-plan.json'),
    path.resolve(__dirname, '../../fixtures/provider-plan.json'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8');
        defaultRules = JSON.parse(raw);
        return defaultRules;
      } catch (err) {
        console.warn(`[Provider] Error reading provider plan from ${p}:`, err);
      }
    }
  }

  return defaultRules;
}

export interface VerificationResult {
  statusCode: number;
  message: string;
  isTransientFailure: boolean;
  isPermanentFailure: boolean;
}

export function evaluateProviderPlan(
  event: EventDocument,
  attempt: number,
  customRules?: ProviderPlanRule[]
): VerificationResult {
  const rules = customRules || loadDefaultPlan();

  for (const rule of rules) {
    const m = rule.match;

    if (m.tenantId !== undefined && m.tenantId !== event.tenantId) continue;
    if (m.sourceId !== undefined && m.sourceId !== event.sourceId) continue;
    if (m.externalJobId !== undefined && m.externalJobId !== event.externalJobId) continue;
    if (m.eventId !== undefined && m.eventId !== event.eventId) continue;
    if (m.version !== undefined && m.version !== event.version) continue;
    if (m.attempt !== undefined && m.attempt !== attempt) continue;

    const statusCode = rule.result.status;
    const isTransient = statusCode === 429 || statusCode === 503;
    const isPermanent = statusCode === 422;

    return {
      statusCode,
      message: rule.result.message,
      isTransientFailure: isTransient,
      isPermanentFailure: isPermanent,
    };
  }

  // Default is success
  return {
    statusCode: 200,
    message: 'Provider verification successful',
    isTransientFailure: false,
    isPermanentFailure: false,
  };
}
