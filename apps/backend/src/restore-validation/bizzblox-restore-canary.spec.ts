import { describe, expect, it } from 'vitest';

import { RestoreProbeError } from './bizzblox-restore-probe';
import {
  RESTORE_CANARY_CHECKSUM_BASE64,
  RESTORE_CANARY_CHECKSUM_HEX,
  RESTORE_CANARY_DATABASE_ID,
  RESTORE_CANARY_MEDIA_KEY,
  RESTORE_CANARY_PAYLOAD,
  verifyDatabaseRestoreCanary,
  verifyMediaRestoreCanary,
} from './bizzblox-restore-canary';

describe('BizzBLOX durable restore canary', () => {
  it('pins the independently calculated canonical payload and SHA-256 values', () => {
    expect(RESTORE_CANARY_PAYLOAD).toBe(
      '{"purpose":"bizzblox-social-restore-canary","version":1}\n'
    );
    expect(Buffer.byteLength(RESTORE_CANARY_PAYLOAD)).toBe(57);
    expect(RESTORE_CANARY_CHECKSUM_HEX).toBe(
      '254ca8df293cebe8c2ac27223b56aeed467a1492d381b68a5ca80e917386614f'
    );
    expect(RESTORE_CANARY_CHECKSUM_BASE64).toBe(
      'JUyo3yk86+jCrCciO1au7UZ6FJLTgbaKXKgOkXOGYU8='
    );
    expect(RESTORE_CANARY_DATABASE_ID).toBe(
      'bizzblox-social-restore-canary-v1'
    );
    expect(RESTORE_CANARY_MEDIA_KEY).toBe(
      'bizzblox-validation/restore-canary-v1.json'
    );
  });

  it('verifies the exact database and media canaries', () => {
    expect(
      verifyDatabaseRestoreCanary({
        checksum: RESTORE_CANARY_CHECKSUM_HEX,
        id: RESTORE_CANARY_DATABASE_ID,
      })
    ).toBe(true);
    expect(
      verifyMediaRestoreCanary({
        byteCount: 57,
        checksumSha256: RESTORE_CANARY_CHECKSUM_BASE64,
        key: RESTORE_CANARY_MEDIA_KEY,
      })
    ).toBe(true);
  });

  it.each([
    () =>
      verifyDatabaseRestoreCanary({
        checksum: 'a'.repeat(64),
        id: RESTORE_CANARY_DATABASE_ID,
      }),
    () =>
      verifyDatabaseRestoreCanary({
        checksum: RESTORE_CANARY_CHECKSUM_HEX,
        id: 'foreign-canary',
      }),
    () =>
      verifyMediaRestoreCanary({
        byteCount: 58,
        checksumSha256: RESTORE_CANARY_CHECKSUM_BASE64,
        key: RESTORE_CANARY_MEDIA_KEY,
      }),
    () =>
      verifyMediaRestoreCanary({
        byteCount: 57,
        checksumSha256: RESTORE_CANARY_CHECKSUM_BASE64,
        key: 'managed-media/private.png',
      }),
  ])('rejects a changed canary with one value-free error', (operation) => {
    try {
      operation();
      throw new Error('expected canary verification to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreProbeError);
      expect((error as Error).message).toBe('Restore probe failed.');
    }
  });
});
