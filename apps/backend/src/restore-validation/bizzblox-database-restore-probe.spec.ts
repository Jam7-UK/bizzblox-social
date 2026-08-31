import { describe, expect, it, vi } from 'vitest';

import { RestoreProbeError } from './bizzblox-restore-probe';
import {
  collectDatabaseRestoreSnapshot,
  readDatabaseRestoreManifest,
  type RestoreDatabaseQueryClient,
} from './bizzblox-database-restore-probe';

function queryClient(
  options?: Readonly<{
    columnDefault?: string | null;
    failCount?: boolean;
    schemaDefinition?: string;
  }>
) {
  const connect = vi.fn().mockResolvedValue(undefined);
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn(async (statement: string) => {
    if (statement.includes('"information_schema"."columns"')) {
      return [
        {
          name: 'id',
          nullable: false,
          ordinal: 1,
          schemaName: 'public',
          tableName: 'Organization',
          type: 'text',
          defaultValue: options?.columnDefault ?? null,
          generated: false,
          generationExpression: null,
          identity: false,
          identityGeneration: null,
          udtName: 'text',
          udtSchema: 'pg_catalog',
        },
        {
          name: 'name',
          nullable: false,
          ordinal: 2,
          schemaName: 'public',
          tableName: 'Organization',
          type: 'text',
          defaultValue: null,
          generated: false,
          generationExpression: null,
          identity: false,
          identityGeneration: null,
          udtName: 'text',
          udtSchema: 'pg_catalog',
        },
      ];
    }
    if (statement.includes('"pg_constraint"')) {
      return [
        {
          definition: options?.schemaDefinition ?? 'PRIMARY KEY (id)',
          kind: 'constraint',
          objectName: 'Organization_pkey',
          relationName: 'Organization',
          schemaName: 'public',
        },
      ];
    }
    if (statement.includes('COUNT(*)')) {
      if (options?.failCount) throw new Error('sensitive database endpoint');
      return [{ rowCount: '2' }];
    }
    if (statement.includes('"bizzblox_restore_canary"')) {
      return [
        {
          checksum:
            '254ca8df293cebe8c2ac27223b56aeed467a1492d381b68a5ca80e917386614f',
          id: 'bizzblox-social-restore-canary-v1',
        },
      ];
    }
    if (statement.includes('"_prisma_migrations"')) {
      throw new Error('prisma db push does not create a migration ledger');
    }
    if (statement.includes('"schema_version"')) {
      return [
        {
          compatibility: '1.0',
          createdAt: '2026-08-28T00:00:00.000Z',
          current: '1.2',
          database: 'temporal',
          partition: '0',
        },
      ];
    }
    throw new Error('unexpected query');
  });
  return { client: { connect, disconnect, query }, connect, disconnect, query };
}

describe('BizzBLOX database restore probe adapter', () => {
  it('reads only the strict value-free manifest included in the restored database', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue([
      {
        expectedManifest: {
          dataDigest: 'a'.repeat(64),
          migrationDigest: 'b'.repeat(64),
          rowCount: 42,
        },
      },
    ]);
    await expect(
      readDatabaseRestoreManifest({ connect, disconnect, query })
    ).resolves.toEqual({
      dataDigest: 'a'.repeat(64),
      migrationDigest: 'b'.repeat(64),
      rowCount: 42,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"expected_manifest" AS "expectedManifest"')
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the restored database has no anchored manifest', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    await expect(
      readDatabaseRestoreManifest({
        connect,
        disconnect,
        query: vi.fn().mockResolvedValue([{ expectedManifest: null }]),
      })
    ).rejects.toBeInstanceOf(RestoreProbeError);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('derives db-push schema state without querying a nonexistent migration ledger', async () => {
    const { client, connect, disconnect, query } = queryClient();

    const result = await collectDatabaseRestoreSnapshot('application', client);

    expect(result).toMatchObject({
      canaryVerified: true,
      connectionVerified: true,
      failedMigrationCount: 0,
      rowCount: 2,
    });
    expect(result.dataDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.migrationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    const statements = query.mock.calls.map(([statement]) => statement);
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"information_schema"."columns"'),
        expect.stringContaining('COUNT(*)'),
        expect.stringContaining('"bizzblox_restore_canary"'),
        expect.stringContaining('"pg_catalog"."pg_constraint"'),
        expect.stringContaining('"pg_catalog"."pg_enum"'),
        expect.stringContaining('"pg_catalog"."pg_indexes"'),
      ])
    );
    expect(statements.join('\n')).not.toContain('"_prisma_migrations"');
  });

  it('rejects a restored database with a missing durable canary', async () => {
    const { client } = queryClient();
    client.query.mockImplementation(async (statement: string) => {
      if (statement.includes('"bizzblox_restore_canary"')) return [];
      if (statement.includes('"information_schema"."columns"')) {
        return [
          {
            defaultValue: null,
            generated: false,
            generationExpression: null,
            identity: false,
            identityGeneration: null,
            name: 'id',
            nullable: false,
            ordinal: 1,
            schemaName: 'public',
            tableName: 'Organization',
            type: 'text',
            udtName: 'text',
            udtSchema: 'pg_catalog',
          },
        ];
      }
      if (statement.includes('COUNT(*)')) return [{ rowCount: '2' }];
      if (statement.includes('"_prisma_migrations"')) {
        return [
          {
            checksum: 'a'.repeat(64),
            finished: true,
            name: '202608280001_initial',
            rolledBack: false,
          },
        ];
      }
      throw new Error('unexpected query');
    });

    await expect(
      collectDatabaseRestoreSnapshot('application', client)
    ).rejects.toBeInstanceOf(RestoreProbeError);
  });

  it('changes db-push evidence for defaults, enums, constraints, or indexes', async () => {
    const baseline = await collectDatabaseRestoreSnapshot(
      'application',
      queryClient().client
    );
    const changedDefault = await collectDatabaseRestoreSnapshot(
      'application',
      queryClient({ columnDefault: "'draft'::text" }).client
    );
    const changedSchemaObject = await collectDatabaseRestoreSnapshot(
      'application',
      queryClient({
        schemaDefinition: 'UNIQUE (name)',
      }).client
    );

    expect(
      new Set([
        baseline.migrationDigest,
        changedDefault.migrationDigest,
        changedSchemaObject.migrationDigest,
      ])
    ).toHaveLength(3);
  });

  it('derives Temporal migration evidence from its schema-version record', async () => {
    const { client } = queryClient();

    const result = await collectDatabaseRestoreSnapshot('temporal', client);

    expect(result).toMatchObject({
      connectionVerified: true,
      failedMigrationCount: 0,
      rowCount: 2,
    });
    expect(result.migrationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('quotes only catalog-validated table identifiers', async () => {
    const { client } = queryClient();
    client.query.mockImplementationOnce(async () => [
      {
        defaultValue: null,
        generated: false,
        generationExpression: null,
        identity: false,
        identityGeneration: null,
        name: 'id',
        nullable: false,
        ordinal: 1,
        schemaName: 'public',
        tableName: 'unsafe"; DROP TABLE x; --',
        type: 'text',
        udtName: 'text',
        udtSchema: 'pg_catalog',
      },
    ]);

    await expect(
      collectDatabaseRestoreSnapshot('application', client)
    ).rejects.toBeInstanceOf(RestoreProbeError);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('disconnects and returns one generic failure for provider errors', async () => {
    const { client, disconnect } = queryClient({ failCount: true });

    try {
      await collectDatabaseRestoreSnapshot('application', client);
      throw new Error('expected probe to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreProbeError);
      expect((error as Error).message).toBe('Restore probe failed.');
      expect((error as Error).message).not.toContain('endpoint');
    }
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', '', undefined])(
    'rejects unsupported database kind %s',
    async (kind) => {
      const { client, connect } = queryClient();
      await expect(
        collectDatabaseRestoreSnapshot(
          kind as 'application',
          client as RestoreDatabaseQueryClient
        )
      ).rejects.toBeInstanceOf(RestoreProbeError);
      expect(connect).not.toHaveBeenCalled();
    }
  );
});
