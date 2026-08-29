import { createHash } from 'node:crypto';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function bizzbloxCanonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(bizzbloxCanonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${bizzbloxCanonicalJson(value[key])}`
      )
      .join(',')}}`;
  }
  throw new Error('BizzBLOX value is not canonical JSON.');
}

export function bizzbloxDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(bizzbloxCanonicalJson(value), 'utf8')
    .digest('hex')}`;
}
