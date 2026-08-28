import { createHash } from 'node:crypto';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MEDIA_PREFIX = 'managed-media/';

type DatabaseColumn = Readonly<{
  name: string;
  nullable: boolean;
  ordinal: number;
  type: string;
}>;

type DatabaseMigration = Readonly<{
  checksum: string;
  finished: boolean;
  name: string;
  rolledBack: boolean;
}>;

type DatabaseTable = Readonly<{
  columns: readonly DatabaseColumn[];
  name: string;
  rowCount: number;
  schema: string;
}>;

export type DatabaseRestoreProbe = Readonly<{
  connectionVerified: boolean;
  migrations: readonly DatabaseMigration[];
  tables: readonly DatabaseTable[];
}>;

export type DatabaseRestoreSnapshot = Readonly<{
  connectionVerified: true;
  dataDigest: string;
  failedMigrationCount: number;
  migrationDigest: string;
  rowCount: number;
}>;

type MediaObjectProbe = Readonly<{
  byteCount: number;
  checksumSha256: string;
  key: string;
}>;

export type MediaRestoreSnapshot = Readonly<{
  byteCount: number;
  inventoryDigest: string;
  objectCount: number;
  verifiedObjectCount: number;
}>;

export class RestoreProbeError extends Error {
  constructor() {
    super('Restore probe failed.');
    this.name = 'RestoreProbeError';
  }
}

function fail(): never {
  throw new RestoreProbeError();
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail();
  }
  return value as number;
}

function boundedText(value: unknown, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fail();
  }
  return value;
}

function hash(parts: readonly string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) {
    digest.update(String(Buffer.byteLength(part, 'utf8')));
    digest.update(':');
    digest.update(part);
  }
  return digest.digest('hex');
}

function addCount(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) return fail();
  return total;
}

function normalizedColumns(
  columns: readonly DatabaseColumn[]
): readonly string[] {
  if (!Array.isArray(columns) || columns.length === 0) return fail();
  const seen = new Set<string>();
  return Object.freeze(
    columns
      .map((column) => {
        const name = boundedText(column?.name, 63);
        const type = boundedText(column?.type, 256);
        const ordinal = safeCount(column?.ordinal);
        if (ordinal < 1 || typeof column?.nullable !== 'boolean') return fail();
        const identity = `${ordinal}:${name}`;
        if (seen.has(identity)) return fail();
        seen.add(identity);
        return `${ordinal}|${name}|${type}|${
          column.nullable ? 'nullable' : 'required'
        }`;
      })
      .sort()
  );
}

/**
 * Produces logical schema/migration/cardinality evidence. It deliberately never
 * reads or returns customer row values.
 */
export function buildDatabaseRestoreSnapshot(
  probe: DatabaseRestoreProbe
): DatabaseRestoreSnapshot {
  if (probe?.connectionVerified !== true || !Array.isArray(probe.tables)) {
    return fail();
  }
  const tables = new Map<
    string,
    Readonly<{ columns: readonly string[]; rowCount: number }>
  >();
  let rowCount = 0;
  for (const table of probe.tables) {
    const schema = boundedText(table?.schema, 63);
    const name = boundedText(table?.name, 63);
    const identity = `${schema}.${name}`;
    if (tables.has(identity)) return fail();
    const tableRows = safeCount(table?.rowCount);
    rowCount = addCount(rowCount, tableRows);
    tables.set(
      identity,
      Object.freeze({
        columns: normalizedColumns(table.columns),
        rowCount: tableRows,
      })
    );
  }
  if (
    tables.size === 0 ||
    !Array.isArray(probe.migrations) ||
    probe.migrations.length === 0
  ) {
    return fail();
  }

  const migrationNames = new Set<string>();
  let failedMigrationCount = 0;
  const migrations = probe.migrations
    .map((migration) => {
      const name = boundedText(migration?.name, 256);
      if (migrationNames.has(name)) return fail();
      migrationNames.add(name);
      if (!SHA256_HEX.test(migration?.checksum ?? '')) return fail();
      if (
        typeof migration?.finished !== 'boolean' ||
        typeof migration?.rolledBack !== 'boolean'
      ) {
        return fail();
      }
      if (!migration.finished || migration.rolledBack)
        failedMigrationCount += 1;
      return `${name}|${migration.checksum}|${
        migration.finished ? 'finished' : 'unfinished'
      }|${migration.rolledBack ? 'rolled-back' : 'current'}`;
    })
    .sort();
  const tableEvidence = [...tables.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([identity, table]) => [
      identity,
      ...table.columns,
      String(table.rowCount),
    ]);

  return Object.freeze({
    connectionVerified: true,
    dataDigest: hash(tableEvidence),
    failedMigrationCount,
    migrationDigest: hash(migrations),
    rowCount,
  });
}

function normalizedChecksum(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 44 ||
    !value.endsWith('=')
  ) {
    return fail();
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.byteLength !== 32 || decoded.toString('base64') !== value)
      return fail();
  } catch {
    return fail();
  }
  return value;
}

/** Builds a private media inventory digest from key, size, and stored SHA-256. */
export function buildMediaRestoreSnapshot(
  objects: readonly MediaObjectProbe[]
): MediaRestoreSnapshot {
  if (!Array.isArray(objects)) return fail();
  const seen = new Set<string>();
  let byteCount = 0;
  const inventory = objects
    .map((object) => {
      const key = boundedText(object?.key, 1024);
      if (
        !key.startsWith(MEDIA_PREFIX) ||
        key.length === MEDIA_PREFIX.length ||
        seen.has(key)
      ) {
        return fail();
      }
      seen.add(key);
      const objectBytes = safeCount(object?.byteCount);
      byteCount = addCount(byteCount, objectBytes);
      return `${key}|${objectBytes}|${normalizedChecksum(
        object?.checksumSha256
      )}`;
    })
    .sort();
  return Object.freeze({
    byteCount,
    inventoryDigest: hash(inventory),
    objectCount: inventory.length,
    verifiedObjectCount: inventory.length,
  });
}
