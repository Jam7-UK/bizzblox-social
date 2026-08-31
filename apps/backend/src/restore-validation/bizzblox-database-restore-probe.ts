import { PrismaClient } from '@prisma/client';

import { restoreDatabaseUrlFromEnvironment } from './bizzblox-restore-database-config';
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
  defaultValue: string | null;
  generated: boolean;
  generationExpression: string | null;
  identity: boolean;
  identityGeneration: string | null;
  name: string;
  nullable: boolean;
  ordinal: number;
  schemaName: string;
  tableName: string;
  type: string;
  udtName: string;
  udtSchema: string;
}>;

type SchemaObjectRow = Readonly<{
  definition: string;
  kind: 'constraint' | 'enum' | 'index';
  objectName: string;
  relationName: string;
  schemaName: string;
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
const MAX_SCHEMA_OBJECTS = 8_192;

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

function optionalText(value: unknown, maxBytes = 256): string | null {
  if (value === null) return null;
  return text(value, maxBytes);
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

function restoreManifest(value: unknown) {
  const candidate = record(value);
  const keys = Object.keys(candidate).sort();
  if (
    keys.join(',') !== 'dataDigest,migrationDigest,rowCount' ||
    !/^[a-f0-9]{64}$/.test(String(candidate.dataDigest ?? '')) ||
    !/^[a-f0-9]{64}$/.test(String(candidate.migrationDigest ?? '')) ||
    !Number.isSafeInteger(candidate.rowCount) ||
    (candidate.rowCount as number) < 0
  ) {
    return fail();
  }
  return Object.freeze({
    dataDigest: candidate.dataDigest as string,
    migrationDigest: candidate.migrationDigest as string,
    rowCount: candidate.rowCount as number,
  });
}

function columnRows(rows: readonly unknown[]): readonly ColumnRow[] {
  if (rows.length === 0 || rows.length > MAX_COLUMNS) return fail();
  return Object.freeze(
    rows.map((value) => {
      const row = record(value);
      return Object.freeze({
        defaultValue: optionalText(row.defaultValue, 8_192),
        generated: boolean(row.generated),
        generationExpression: optionalText(row.generationExpression, 8_192),
        identity: boolean(row.identity),
        identityGeneration: optionalText(row.identityGeneration, 32),
        name: identifier(row.name),
        nullable: boolean(row.nullable),
        ordinal: positiveInteger(row.ordinal),
        schemaName: identifier(row.schemaName),
        tableName: identifier(row.tableName),
        type: text(row.type),
        udtName: identifier(row.udtName),
        udtSchema: identifier(row.udtSchema),
      });
    })
  );
}

async function applicationSchemaState(
  client: RestoreDatabaseQueryClient,
  columns: readonly ColumnRow[]
): Promise<readonly MigrationProbe[]> {
  // This application intentionally deploys with `prisma db push`, which has no
  // migration ledger. The complete bounded catalog state used by Prisma is the
  // durable evidence that the restore manifest pins and compares after recovery.
  const rows = await client.query(`
    SELECT
      'constraint'::text AS "kind",
      n."nspname" AS "schemaName",
      r."relname" AS "relationName",
      c."conname" AS "objectName",
      pg_catalog.pg_get_constraintdef(c."oid", true) AS "definition"
    FROM "pg_catalog"."pg_constraint" c
    INNER JOIN "pg_catalog"."pg_class" r ON r."oid" = c."conrelid"
    INNER JOIN "pg_catalog"."pg_namespace" n ON n."oid" = r."relnamespace"
    WHERE n."nspname" NOT IN ('pg_catalog', 'information_schema')
      AND n."nspname" NOT LIKE 'pg_%'
    UNION ALL
    SELECT
      'index'::text AS "kind",
      i."schemaname" AS "schemaName",
      i."tablename" AS "relationName",
      i."indexname" AS "objectName",
      i."indexdef" AS "definition"
    FROM "pg_catalog"."pg_indexes" i
    WHERE i."schemaname" NOT IN ('pg_catalog', 'information_schema')
      AND i."schemaname" NOT LIKE 'pg_%'
    UNION ALL
    SELECT
      'enum'::text AS "kind",
      n."nspname" AS "schemaName",
      t."typname" AS "relationName",
      e."enumlabel" AS "objectName",
      e."enumsortorder"::text AS "definition"
    FROM "pg_catalog"."pg_type" t
    INNER JOIN "pg_catalog"."pg_namespace" n ON n."oid" = t."typnamespace"
    INNER JOIN "pg_catalog"."pg_enum" e ON e."enumtypid" = t."oid"
    WHERE n."nspname" NOT IN ('pg_catalog', 'information_schema')
      AND n."nspname" NOT LIKE 'pg_%'
    ORDER BY 1, 2, 3, 4, 5
  `);
  if (rows.length === 0 || rows.length > MAX_SCHEMA_OBJECTS) return fail();
  const objects: readonly SchemaObjectRow[] = Object.freeze(
    rows.map((value) => {
      const row = record(value);
      if (!['constraint', 'enum', 'index'].includes(String(row.kind ?? '')))
        return fail();
      return Object.freeze({
        definition: text(row.definition, 32_768),
        kind: row.kind as SchemaObjectRow['kind'],
        objectName: text(row.objectName),
        relationName: identifier(row.relationName),
        schemaName: identifier(row.schemaName),
      });
    })
  );
  const catalog = {
    columns: [...columns].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
    objects: [...objects].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
  };
  return Object.freeze([
    Object.freeze({
      checksum: sha256(JSON.stringify(catalog)),
      finished: true,
      name: 'prisma-db-push:catalog-v2',
      rolledBack: false,
    }),
  ]);
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
        c."udt_schema" AS "udtSchema",
        c."udt_name" AS "udtName",
        c."column_default" AS "defaultValue",
        c."is_nullable" = 'YES' AS "nullable",
        c."is_identity" = 'YES' AS "identity",
        c."identity_generation" AS "identityGeneration",
        c."is_generated" = 'ALWAYS' AS "generated",
        c."generation_expression" AS "generationExpression"
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
      ? await applicationSchemaState(client, columns)
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

/** Reads the strict aggregate manifest that was included in the recovery point. */
export async function readDatabaseRestoreManifest(
  client: RestoreDatabaseQueryClient
) {
  try {
    await client.connect();
    const rows = await client.query(`
      SELECT "expected_manifest" AS "expectedManifest"
      FROM "public"."bizzblox_restore_canary"
      WHERE "id" = '${RESTORE_CANARY_DATABASE_ID}'
      LIMIT 2
    `);
    if (rows.length !== 1) return fail();
    return restoreManifest(record(rows[0]).expectedManifest);
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

/** Production adapter; connection fields are supplied only by the isolated task. */
export function prismaRestoreDatabaseQueryClient(
  environment: Readonly<Record<string, string | undefined>>
): RestoreDatabaseQueryClient {
  const client = new PrismaClient({
    datasourceUrl: restoreDatabaseUrlFromEnvironment(environment),
  });
  return Object.freeze({
    connect: () => client.$connect(),
    disconnect: () => client.$disconnect(),
    query: (statement: string) => client.$queryRawUnsafe<unknown[]>(statement),
  });
}
