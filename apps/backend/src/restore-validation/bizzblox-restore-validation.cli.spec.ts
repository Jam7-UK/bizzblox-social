import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  DATABASE_RESTORE_VALIDATION_RESULT,
  MEDIA_RESTORE_VALIDATION_RESULT,
  RestoreValidationError,
} from './bizzblox-restore-validation';
import { runRestoreValidationCli } from './bizzblox-restore-validation.cli';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const databaseEvidence = Object.freeze({
  kind: 'database',
  version: 1,
  connectionVerified: true,
  failedMigrationCount: 0,
  expected: {
    dataDigest: DIGEST_A,
    migrationDigest: DIGEST_B,
    rowCount: 42,
  },
  restored: {
    dataDigest: DIGEST_A,
    migrationDigest: DIGEST_B,
    rowCount: 42,
  },
});

const mediaEvidence = Object.freeze({
  kind: 'media',
  version: 1,
  checksumFailureCount: 0,
  expected: {
    byteCount: 2048,
    inventoryDigest: DIGEST_A,
    objectCount: 2,
  },
  restored: {
    byteCount: 2048,
    inventoryDigest: DIGEST_A,
    objectCount: 2,
    verifiedObjectCount: 2,
  },
});

function input(value: string): Readable {
  return Readable.from([value]);
}

describe('BizzBLOX restore validation CLI', () => {
  it('validates database evidence from bounded stdin', async () => {
    await expect(
      runRestoreValidationCli(
        ['--kind', 'database'],
        input(JSON.stringify(databaseEvidence))
      )
    ).resolves.toBe(DATABASE_RESTORE_VALIDATION_RESULT);
  });

  it('validates media evidence from bounded stdin', async () => {
    await expect(
      runRestoreValidationCli(
        ['--kind', 'media'],
        input(JSON.stringify(mediaEvidence))
      )
    ).resolves.toBe(MEDIA_RESTORE_VALIDATION_RESULT);
  });

  it.each([
    [['--kind', 'database', '--verbose'], JSON.stringify(databaseEvidence)],
    [['--kind', 'other'], JSON.stringify(databaseEvidence)],
    [['--kind', 'database'], '{"secret":"must-not-echo"'],
    [
      ['--kind', 'database'],
      JSON.stringify({ ...databaseEvidence, connectionVerified: false }),
    ],
    [['--kind', 'media'], JSON.stringify(databaseEvidence)],
  ])('fails closed without echoing input or arguments', async (args, body) => {
    try {
      await runRestoreValidationCli(args, input(body));
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreValidationError);
      expect((error as Error).message).toBe('Restore validation failed.');
    }
  });

  it('rejects evidence larger than the fixed input limit', async () => {
    await expect(
      runRestoreValidationCli(
        ['--kind', 'database'],
        input('x'.repeat(16 * 1024 + 1))
      )
    ).rejects.toBeInstanceOf(RestoreValidationError);
  });
});
