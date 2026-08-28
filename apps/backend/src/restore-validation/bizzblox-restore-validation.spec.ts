import { describe, expect, it } from 'vitest';

import {
  DATABASE_RESTORE_VALIDATION_RESULT,
  DATABASE_RESTORE_VALIDATION_RESULT_V2,
  MEDIA_RESTORE_VALIDATION_RESULT,
  MEDIA_RESTORE_VALIDATION_RESULT_V2,
  RestoreValidationError,
  validateDatabaseRestore,
  validateDatabaseRestoreV2,
  validateMediaRestore,
  validateMediaRestoreV2,
} from './bizzblox-restore-validation';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('BizzBLOX restore validation', () => {
  it('accepts v2 database evidence only with the durable canary and logical catalog proof', () => {
    expect(
      validateDatabaseRestoreV2({
        canaryVerified: true,
        catalogDigest: DIGEST_A,
        connectionVerified: true,
        failedMigrationCount: 0,
        kind: 'database',
        migrationDigest: DIGEST_B,
        rowCount: 42,
        version: 2,
      })
    ).toBe(DATABASE_RESTORE_VALIDATION_RESULT_V2);
  });

  it('accepts v2 media evidence only with the durable canary and complete checksum proof', () => {
    expect(
      validateMediaRestoreV2({
        canaryVerified: true,
        checksumFailureCount: 0,
        kind: 'media',
        restored: {
          byteCount: 2048,
          inventoryDigest: DIGEST_A,
          objectCount: 2,
          verifiedObjectCount: 2,
        },
        version: 2,
      })
    ).toBe(MEDIA_RESTORE_VALIDATION_RESULT_V2);
  });

  it('accepts only an exact, connected database restore with complete migrations', () => {
    expect(
      validateDatabaseRestore({
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
      })
    ).toBe(DATABASE_RESTORE_VALIDATION_RESULT);
  });

  it.each([
    ['disconnected', { connectionVerified: false }],
    ['failed migration', { failedMigrationCount: 1 }],
    [
      'data mismatch',
      {
        restored: {
          dataDigest: DIGEST_B,
          migrationDigest: DIGEST_B,
          rowCount: 42,
        },
      },
    ],
    [
      'migration mismatch',
      {
        restored: {
          dataDigest: DIGEST_A,
          migrationDigest: DIGEST_A,
          rowCount: 42,
        },
      },
    ],
    [
      'row-count mismatch',
      {
        restored: {
          dataDigest: DIGEST_A,
          migrationDigest: DIGEST_B,
          rowCount: 41,
        },
      },
    ],
  ])('rejects a database restore with a %s', (_label, override) => {
    const evidence = {
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
      ...override,
    };

    expect(() => validateDatabaseRestore(evidence)).toThrow(
      RestoreValidationError
    );
  });

  it('accepts an exact media inventory only after every object checksum passes', () => {
    expect(
      validateMediaRestore({
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
      })
    ).toBe(MEDIA_RESTORE_VALIDATION_RESULT);
  });

  it.each([
    [
      'inventory mismatch',
      {
        restored: {
          byteCount: 2048,
          inventoryDigest: DIGEST_B,
          objectCount: 2,
          verifiedObjectCount: 2,
        },
      },
    ],
    [
      'object-count mismatch',
      {
        restored: {
          byteCount: 2048,
          inventoryDigest: DIGEST_A,
          objectCount: 1,
          verifiedObjectCount: 1,
        },
      },
    ],
    [
      'byte-count mismatch',
      {
        restored: {
          byteCount: 1024,
          inventoryDigest: DIGEST_A,
          objectCount: 2,
          verifiedObjectCount: 2,
        },
      },
    ],
    [
      'incomplete verification',
      {
        restored: {
          byteCount: 2048,
          inventoryDigest: DIGEST_A,
          objectCount: 2,
          verifiedObjectCount: 1,
        },
      },
    ],
    ['checksum failure', { checksumFailureCount: 1 }],
  ])('rejects media evidence with an %s', (_label, override) => {
    const evidence = {
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
      ...override,
    };

    expect(() => validateMediaRestore(evidence)).toThrow(
      RestoreValidationError
    );
  });

  it.each([
    undefined,
    null,
    {},
    { kind: 'database', version: 2 },
    {
      kind: 'database',
      version: 1,
      connectionVerified: true,
      failedMigrationCount: 0,
      expected: {
        dataDigest: 'not-a-digest',
        migrationDigest: DIGEST_B,
        rowCount: 0,
      },
      restored: {
        dataDigest: DIGEST_A,
        migrationDigest: DIGEST_B,
        rowCount: 0,
      },
    },
  ])(
    'rejects malformed or unsupported evidence without echoing values',
    (evidence) => {
      try {
        validateDatabaseRestore(evidence);
        throw new Error('expected validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(RestoreValidationError);
        expect((error as Error).message).toBe('Restore validation failed.');
      }
    }
  );
});
