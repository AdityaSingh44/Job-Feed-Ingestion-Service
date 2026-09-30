import { createHash } from 'crypto';

/**
 * Deterministically serializes a JavaScript object/value to canonical JSON.
 * - Object keys are sorted alphabetically at all nesting depths.
 * - Array order is strictly preserved.
 * - Whitespace differences are eliminated.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const elements = value.map(element => canonicalizeJson(element));
    return `[${elements.join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map(key => {
    const valStr = canonicalizeJson(obj[key]);
    return `${JSON.stringify(key)}:${valStr}`;
  });

  return `{${entries.join(',')}}`;
}

/**
 * Computes a SHA-256 hash of the canonicalized JSON representation.
 */
export function computeCanonicalHash(value: unknown): string {
  const canonicalStr = canonicalizeJson(value);
  return createHash('sha256').update(canonicalStr, 'utf8').digest('hex');
}
