export const DATABASE_RESTORE_VALIDATION_RESULT =
  'bizzblox-social-validation:v1;database-checksums=matched;migrations=passed';
export const MEDIA_RESTORE_VALIDATION_RESULT =
  'bizzblox-social-validation:v1;media-checksums=matched';

const SHA256_HEX = /^[a-f0-9]{64}$/;

type UnknownRecord = Readonly<Record<string, unknown>>;

type DatabaseSnapshot = Readonly<{
  dataDigest: string;
  migrationDigest: string;
  rowCount: number;
}>;

type MediaSnapshot = Readonly<{
  byteCount: number;
  inventoryDigest: string;
  objectCount: number;
}>;

type RestoredMediaSnapshot = MediaSnapshot &
  Readonly<{
    verifiedObjectCount: number;
  }>;

export class RestoreValidationError extends Error {
  constructor() {
    super('Restore validation failed.');
    this.name = 'RestoreValidationError';
  }
}

function fail(): never {
  throw new RestoreValidationError();
}

function record(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail();
  }
  return value as UnknownRecord;
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail();
  }
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    return fail();
  }
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail();
  }
  return value as number;
}

function databaseSnapshot(value: unknown): DatabaseSnapshot {
  const candidate = record(value);
  hasExactKeys(candidate, ['dataDigest', 'migrationDigest', 'rowCount']);
  return Object.freeze({
    dataDigest: digest(candidate.dataDigest),
    migrationDigest: digest(candidate.migrationDigest),
    rowCount: count(candidate.rowCount),
  });
}

function mediaSnapshot(value: unknown): MediaSnapshot {
  const candidate = record(value);
  hasExactKeys(candidate, ['byteCount', 'inventoryDigest', 'objectCount']);
  return Object.freeze({
    byteCount: count(candidate.byteCount),
    inventoryDigest: digest(candidate.inventoryDigest),
    objectCount: count(candidate.objectCount),
  });
}

function restoredMediaSnapshot(value: unknown): RestoredMediaSnapshot {
  const candidate = record(value);
  hasExactKeys(candidate, [
    'byteCount',
    'inventoryDigest',
    'objectCount',
    'verifiedObjectCount',
  ]);
  return Object.freeze({
    byteCount: count(candidate.byteCount),
    inventoryDigest: digest(candidate.inventoryDigest),
    objectCount: count(candidate.objectCount),
    verifiedObjectCount: count(candidate.verifiedObjectCount),
  });
}

/**
 * Accepts only value-free aggregate evidence produced by the isolated recovery
 * probe. Customer rows, object keys, and provider credentials never enter this
 * contract or its result.
 */
export function validateDatabaseRestore(evidence: unknown): string {
  const candidate = record(evidence);
  hasExactKeys(candidate, [
    'connectionVerified',
    'expected',
    'failedMigrationCount',
    'kind',
    'restored',
    'version',
  ]);
  if (
    candidate.kind !== 'database' ||
    candidate.version !== 1 ||
    candidate.connectionVerified !== true ||
    count(candidate.failedMigrationCount) !== 0
  ) {
    fail();
  }

  const expected = databaseSnapshot(candidate.expected);
  const restored = databaseSnapshot(candidate.restored);
  if (
    expected.dataDigest !== restored.dataDigest ||
    expected.migrationDigest !== restored.migrationDigest ||
    expected.rowCount !== restored.rowCount
  ) {
    fail();
  }
  return DATABASE_RESTORE_VALIDATION_RESULT;
}

/** Validates a fully checksum-verified restored media inventory. */
export function validateMediaRestore(evidence: unknown): string {
  const candidate = record(evidence);
  hasExactKeys(candidate, [
    'checksumFailureCount',
    'expected',
    'kind',
    'restored',
    'version',
  ]);
  if (
    candidate.kind !== 'media' ||
    candidate.version !== 1 ||
    count(candidate.checksumFailureCount) !== 0
  ) {
    fail();
  }

  const expected = mediaSnapshot(candidate.expected);
  const restored = restoredMediaSnapshot(candidate.restored);
  if (
    expected.byteCount !== restored.byteCount ||
    expected.inventoryDigest !== restored.inventoryDigest ||
    expected.objectCount !== restored.objectCount ||
    restored.verifiedObjectCount !== restored.objectCount
  ) {
    fail();
  }
  return MEDIA_RESTORE_VALIDATION_RESULT;
}
