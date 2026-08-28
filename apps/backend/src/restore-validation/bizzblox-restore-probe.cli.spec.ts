import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  DATABASE_RESTORE_VALIDATION_RESULT,
  DATABASE_RESTORE_VALIDATION_RESULT_V2,
  MEDIA_RESTORE_VALIDATION_RESULT,
  MEDIA_RESTORE_VALIDATION_RESULT_V2,
  RestoreValidationError,
} from './bizzblox-restore-validation';
import { runRestoreProbeCli } from './bizzblox-restore-probe.cli';

const databaseSnapshot = Object.freeze({
  canaryVerified: true as const,
  connectionVerified: true as const,
  dataDigest: 'a'.repeat(64),
  failedMigrationCount: 0,
  migrationDigest: 'b'.repeat(64),
  rowCount: 42,
});

const mediaSnapshot = Object.freeze({
  byteCount: 2048,
  canaryVerified: true as const,
  inventoryDigest: 'a'.repeat(64),
  objectCount: 2,
  verifiedObjectCount: 2,
});

function input(value: unknown): Readable {
  return Readable.from([
    typeof value === 'string' ? value : JSON.stringify(value),
  ]);
}

describe('BizzBLOX restore probe CLI', () => {
  it.each(['application', 'temporal'] as const)(
    'probes and validates the %s database under the v2 canary contract',
    async (kind) => {
      const database = vi.fn().mockResolvedValue(databaseSnapshot);
      const result = await runRestoreProbeCli(
        ['--kind', kind, '--contract', 'v2'],
        input(''),
        {},
        { database, media: vi.fn() }
      );

      expect(result).toBe(DATABASE_RESTORE_VALIDATION_RESULT_V2);
      expect(database).toHaveBeenCalledWith(kind);
    }
  );

  it('validates restored media under the v2 canary contract without a manifest', async () => {
    const media = vi.fn().mockResolvedValue(mediaSnapshot);
    await expect(
      runRestoreProbeCli(
        ['--kind', 'media', '--contract', 'v2'],
        input(''),
        { SOCIAL_RESTORED_MEDIA_BUCKET: 'bizzblox-social-restored-media' },
        { database: vi.fn(), media }
      )
    ).resolves.toBe(MEDIA_RESTORE_VALIDATION_RESULT_V2);
  });

  it.each(['application', 'temporal'] as const)(
    'probes and validates the %s database',
    async (kind) => {
      const database = vi.fn().mockResolvedValue(databaseSnapshot);
      const result = await runRestoreProbeCli(
        ['--kind', kind],
        input({
          dataDigest: databaseSnapshot.dataDigest,
          migrationDigest: databaseSnapshot.migrationDigest,
          rowCount: databaseSnapshot.rowCount,
        }),
        {},
        { database, media: vi.fn() }
      );

      expect(result).toBe(DATABASE_RESTORE_VALIDATION_RESULT);
      expect(database).toHaveBeenCalledWith(kind);
    }
  );

  it('probes and validates the exact restored media bucket', async () => {
    const media = vi.fn().mockResolvedValue(mediaSnapshot);
    const result = await runRestoreProbeCli(
      ['--kind', 'media'],
      input({
        byteCount: mediaSnapshot.byteCount,
        inventoryDigest: mediaSnapshot.inventoryDigest,
        objectCount: mediaSnapshot.objectCount,
      }),
      { SOCIAL_RESTORED_MEDIA_BUCKET: 'bizzblox-social-restored-media' },
      { database: vi.fn(), media }
    );

    expect(result).toBe(MEDIA_RESTORE_VALIDATION_RESULT);
    expect(media).toHaveBeenCalledWith('bizzblox-social-restored-media');
  });

  it.each([
    [['--kind', 'unknown'], {}, '{}'],
    [['--kind', 'application', '--verbose'], {}, '{}'],
    [
      ['--kind', 'application'],
      {},
      JSON.stringify({ ...databaseSnapshot, dataDigest: 'c'.repeat(64) }),
    ],
    [['--kind', 'media'], {}, JSON.stringify(mediaSnapshot)],
    [['--kind', 'media'], { SOCIAL_RESTORED_MEDIA_BUCKET: 'foreign' }, '{'],
  ])(
    'fails closed without echoing arguments or manifest values',
    async (args, env, body) => {
      try {
        await runRestoreProbeCli(args, input(body), env, {
          database: vi.fn().mockResolvedValue(databaseSnapshot),
          media: vi.fn().mockResolvedValue(mediaSnapshot),
        });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(RestoreValidationError);
        expect((error as Error).message).toBe('Restore validation failed.');
      }
    }
  );

  it('rejects manifests larger than the fixed input limit', async () => {
    await expect(
      runRestoreProbeCli(
        ['--kind', 'application'],
        input('x'.repeat(4 * 1024 + 1)),
        {},
        { database: vi.fn(), media: vi.fn() }
      )
    ).rejects.toBeInstanceOf(RestoreValidationError);
  });
});
