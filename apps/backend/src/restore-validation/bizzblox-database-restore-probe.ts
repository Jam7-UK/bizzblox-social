import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

import {
  RestoreProbeError,
  buildDatabaseRestoreSnapshot,
  type DatabaseRestoreSnapshot,
} from './bizzblox-restore-probe';
import {
  RESTORE_CANARY_DATABASE_ID,
  verifyDatabaseRestoreCanary,
} from './bizzblox-restore-canary';

export type RestoreDatabaseKind = 'application' | 'temporal';

export type RestoreDatabaseQueryClient = Readonly<{
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  query: (statement: string) => Promise<readonly unknown[]>;
}>;

type ColumnRow = Readonly<{
  name: string;
  nullable: boolean;
  ordinal: number;
  schemaName: string;
  tableName: string;
  type: string;
}>;

type MigrationProbe = Readonly<{
  checksum: string;
  finished: boolean;
  name: string;
  rolledBack: boolean;
}>;

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const MAX_TABLES = 512;
const MAX_COLUMNS = 4_096;

function fail(): never {
  throw new RestoreProbeError();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail();
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, maxBytes = 256): string {
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

function identifier(value: unknown): string {
  const candidate = text(value, 63);
  if (!POSTGRES_IDENTIFIER.test(candidate)) return fail();
  return candidate;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail();
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail();
  return value as number;
}

function decimalCount(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    return fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fail();
  return parsed;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function columnRows(rows: readonly unknown[]): readonly ColumnRow[] {
  if (rows.length === 0 || rows.length > MAX_COLUMNS) return fail();
  return Object.freeze(
    rows.map((value) => {
      const row = record(value);
      return Object.freeze({
        name: identifier(row.name),
        nullable: boolean(row.nullable),
        ordinal: positiveInteger(row.ordinal),
        schemaName: identifier(row.schemaName),
        tableName: identifier(row.tableName),
        type: text(row.type),
      });
    })
  );
}

async function applicationMigrations(
  client: RestoreDatabaseQueryClient
): Promise<readonly MigrationProbe[]> {
  const rows = await client.query(`
    SELECT
      "migration_name" AS "name",
      "checksum",
      "finished_at" IS NOT NULL AS "finished",
      "rolled_back_at" IS NOT NULL AS "rolledBack"
    FROM "public"."_prisma_migrations"
    ORDER BY "migration_name"
  `);
  if (rows.length === 0 || rows.length > 2_048) return fail();
  return Object.freeze(
    rows.map((value) => {
      const row = record(value);
      return Object.freeze({
        checksum: text(row.checksum, 64),
        finished: boolean(row.finished),
        name: text(row.name),
        rolledBack: boolean(row.rolledBack),
      });
    })
  );
}

async function temporalMigrations(
  client: RestoreDatabaseQueryClient
): Promise<readonly MigrationProbe[]> {
  const rows = await client.query(`
    SELECT
      "version_partition"::text AS "partition",
      "db_name" AS "database",
      "creation_time"::text AS "createdAt",
      "curr_version" AS "current",
      "min_compatible_version" AS "compatibility"
    FROM "public"."schema_version"
    ORDER BY "version_partition", "db_name"
  `);
  if (rows.length === 0 || rows.length > 32) return fail();
  return Object.freeze(
    rows.map((value) => {
      const row = record(value);
      const partition = text(row.partition, 32);
      const database = text(row.database, 128);
      const createdAt = text(row.createdAt, 64);
      const current = text(row.current, 64);
      const compatibility = text(row.compatibility, 64);
      const canonical = JSON.stringify({
        compatibility,
        createdAt,
        current,
        database,
        partition,
      });
      return Object.freeze({
        checksum: sha256(canonical),
        finished: true,
        name: `temporal:${partition}:${database}:${current}`,
        rolledBack: false,
      });
    })
  );
}

async function databaseCanary(
  client: RestoreDatabaseQueryClient
): Promise<true> {
  const rows = await client.query(`
    SELECT "id", "checksum"
    FROM "public"."bizzblox_restore_canary"
    WHERE "id" = '${RESTORE_CANARY_DATABASE_ID}'
    LIMIT 2
  `);
  if (rows.length !== 1) return fail();
  const row = record(rows[0]);
  return verifyDatabaseRestoreCanary({
    checksum: row.checksum,
    id: row.id,
  });
}

async function collect(
  kind: RestoreDatabaseKind,
  client: RestoreDatabaseQueryClient
): Promise<DatabaseRestoreSnapshot> {
  const columns = columnRows(
    await client.query(`
      SELECT
        c."table_schema" AS "schemaName",
        c."table_name" AS "tableName",
        c."column_name" AS "name",
        c."ordinal_position"::int AS "ordinal",
        c."data_type" AS "type",
        c."is_nullable" = 'YES' AS "nullable"
      FROM "information_schema"."columns" c
      INNER JOIN "information_schema"."tables" t
        ON t."table_schema" = c."table_schema"
       AND t."table_name" = c."table_name"
      WHERE t."table_type" = 'BASE TABLE'
        AND c."table_schema" NOT IN ('pg_catalog', 'information_schema')
      ORDER BY c."table_schema", c."table_name", c."ordinal_position"
    `)
  );
  const grouped = new Map<
    string,
    { schema: string; name: string; columns: ColumnRow[] }
  >();
  for (const column of columns) {
    const identity = `${column.schemaName}.${column.tableName}`;
    const table = grouped.get(identity) ?? {
      schema: column.schemaName,
      name: column.tableName,
      columns: [],
    };
    table.columns.push(column);
    grouped.set(identity, table);
  }
  if (grouped.size === 0 || grouped.size > MAX_TABLES) return fail();

  const tables = [];
  for (const table of grouped.values()) {
    const rows = await client.query(
      `SELECT COUNT(*)::text AS "rowCount" FROM "${table.schema}"."${table.name}"`
    );
    if (rows.length !== 1) return fail();
    tables.push(
      Object.freeze({
        columns: Object.freeze(
          table.columns.map((column) =>
            Object.freeze({
              name: column.name,
              nullable: column.nullable,
              ordinal: column.ordinal,
              type: column.type,
            })
          )
        ),
        name: table.name,
        rowCount: decimalCount(record(rows[0]).rowCount),
        schema: table.schema,
      })
    );
  }
  const migrations =
    kind === 'application'
      ? await applicationMigrations(client)
      : await temporalMigrations(client);
  const canaryVerified = await databaseCanary(client);
  return buildDatabaseRestoreSnapshot({
    canaryVerified,
    connectionVerified: true,
    migrations,
    tables: Object.freeze(tables),
  });
}

/** Queries only catalog, migration, and COUNT metadata, then always disconnects. */
export async function collectDatabaseRestoreSnapshot(
  kind: RestoreDatabaseKind,
  client: RestoreDatabaseQueryClient
): Promise<DatabaseRestoreSnapshot> {
  if (kind !== 'application' && kind !== 'temporal') return fail();
  try {
    await client.connect();
    return await collect(kind, client);
  } catch {
    return fail();
  } finally {
    try {
      await client.disconnect();
    } catch {
      fail();
    }
  }
}

/** Production adapter; DATABASE_URL is supplied only by the isolated task. */
export function prismaRestoreDatabaseQueryClient(): RestoreDatabaseQueryClient {
  const client = new PrismaClient();
  return Object.freeze({
    connect: () => client.$connect(),
    disconnect: () => client.$disconnect(),
    query: (statement: string) => client.$queryRawUnsafe<unknown[]>(statement),
  });
}
