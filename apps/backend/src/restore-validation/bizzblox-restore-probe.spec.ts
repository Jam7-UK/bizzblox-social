import { describe, expect, it } from 'vitest';

import {
  RestoreProbeError,
  buildDatabaseRestoreSnapshot,
  buildMediaRestoreSnapshot,
} from './bizzblox-restore-probe';

const CHECKSUM_A = Buffer.alloc(32, 1).toString('base64');
const CHECKSUM_B = Buffer.alloc(32, 2).toString('base64');

const databaseProbe = Object.freeze({
  connectionVerified: true,
  migrations: Object.freeze([
    Object.freeze({
      checksum: 'a'.repeat(64),
      finished: true,
      name: '202608280001_initial',
      rolledBack: false,
    }),
    Object.freeze({
      checksum: 'b'.repeat(64),
      finished: true,
      name: '202608280002_social',
      rolledBack: false,
    }),
  ]),
  tables: Object.freeze([
    Object.freeze({
      columns: Object.freeze([
        Object.freeze({
          name: 'id',
          nullable: false,
          ordinal: 1,
          type: 'uuid',
        }),
        Object.freeze({
          name: 'name',
          nullable: false,
          ordinal: 2,
          type: 'text',
        }),
      ]),
      name: 'Organization',
      rowCount: 2,
      schema: 'public',
    }),
    Object.freeze({
      columns: Object.freeze([
        Object.freeze({
          name: 'id',
          nullable: false,
          ordinal: 1,
          type: 'uuid',
        }),
      ]),
      name: 'BizzbloxTenant',
      rowCount: 1,
      schema: 'public',
    }),
  ]),
});

describe('BizzBLOX restore probes', () => {
  it('builds deterministic database schema, migration, and cardinality digests', () => {
    const first = buildDatabaseRestoreSnapshot(databaseProbe);
    const reordered = buildDatabaseRestoreSnapshot({
      ...databaseProbe,
      migrations: [...databaseProbe.migrations].reverse(),
      tables: [...databaseProbe.tables]
        .reverse()
        .map((table) => ({ ...table, columns: [...table.columns].reverse() })),
    });

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      connectionVerified: true,
      failedMigrationCount: 0,
      rowCount: 3,
    });
    expect(first.dataDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.migrationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('counts unfinished or rolled-back migrations so validation fails closed', () => {
    const snapshot = buildDatabaseRestoreSnapshot({
      ...databaseProbe,
      migrations: [
        ...databaseProbe.migrations,
        {
          checksum: 'c'.repeat(64),
          finished: false,
          name: '202608280003_failed',
          rolledBack: false,
        },
        {
          checksum: 'd'.repeat(64),
          finished: true,
          name: '202608280004_rolled_back',
          rolledBack: true,
        },
      ],
    });

    expect(snapshot.failedMigrationCount).toBe(2);
  });

  it('builds an order-independent media checksum inventory without returning keys', () => {
    const objects = [
      {
        byteCount: 128,
        checksumSha256: CHECKSUM_A,
        key: 'managed-media/a.png',
      },
      {
        byteCount: 256,
        checksumSha256: CHECKSUM_B,
        key: 'managed-media/b.mp4',
      },
    ];
    const first = buildMediaRestoreSnapshot(objects);
    const reordered = buildMediaRestoreSnapshot([...objects].reverse());

    expect(first).toEqual(reordered);
    expect(first).toEqual({
      byteCount: 384,
      inventoryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      objectCount: 2,
      verifiedObjectCount: 2,
    });
    expect(JSON.stringify(first)).not.toContain('managed-media');
  });

  it.each([
    [
      'disconnected database',
      () =>
        buildDatabaseRestoreSnapshot({
          ...databaseProbe,
          connectionVerified: false,
        }),
    ],
    [
      'duplicate table',
      () =>
        buildDatabaseRestoreSnapshot({
          ...databaseProbe,
          tables: [databaseProbe.tables[0], databaseProbe.tables[0]],
        }),
    ],
    [
      'foreign media prefix',
      () =>
        buildMediaRestoreSnapshot([
          { byteCount: 1, checksumSha256: CHECKSUM_A, key: 'other/a.png' },
        ]),
    ],
    [
      'missing checksum',
      () =>
        buildMediaRestoreSnapshot([
          { byteCount: 1, checksumSha256: '', key: 'managed-media/a.png' },
        ]),
    ],
    [
      'duplicate media key',
      () =>
        buildMediaRestoreSnapshot([
          {
            byteCount: 1,
            checksumSha256: CHECKSUM_A,
            key: 'managed-media/a.png',
          },
          {
            byteCount: 1,
            checksumSha256: CHECKSUM_A,
            key: 'managed-media/a.png',
          },
        ]),
    ],
  ])('rejects a %s with one generic error', (_label, operation) => {
    expect(operation).toThrow(RestoreProbeError);
    try {
      operation();
    } catch (error) {
      expect((error as Error).message).toBe('Restore probe failed.');
    }
  });
});
