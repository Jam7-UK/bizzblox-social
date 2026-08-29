import { RestoreProbeError } from './bizzblox-restore-probe';

export const RESTORE_CANARY_PAYLOAD =
  '{"purpose":"bizzblox-social-restore-canary","version":1}\n';
export const RESTORE_CANARY_CHECKSUM_HEX =
  '254ca8df293cebe8c2ac27223b56aeed467a1492d381b68a5ca80e917386614f';
export const RESTORE_CANARY_CHECKSUM_BASE64 =
  'JUyo3yk86+jCrCciO1au7UZ6FJLTgbaKXKgOkXOGYU8=';
export const RESTORE_CANARY_DATABASE_ID = 'bizzblox-social-restore-canary-v1';
export const RESTORE_CANARY_MEDIA_KEY =
  'bizzblox-validation/restore-canary-v1.json';
export const RESTORE_MANIFEST_MEDIA_KEY =
  'bizzblox-validation/restore-manifest-v2.json';

function fail(): never {
  throw new RestoreProbeError();
}

export function verifyDatabaseRestoreCanary(
  canary: Readonly<{ checksum: unknown; id: unknown }>
): true {
  if (
    canary?.id !== RESTORE_CANARY_DATABASE_ID ||
    canary?.checksum !== RESTORE_CANARY_CHECKSUM_HEX
  ) {
    return fail();
  }
  return true;
}

export function verifyMediaRestoreCanary(
  canary: Readonly<{
    byteCount: unknown;
    checksumSha256: unknown;
    key: unknown;
  }>
): true {
  if (
    canary?.key !== RESTORE_CANARY_MEDIA_KEY ||
    canary?.byteCount !== Buffer.byteLength(RESTORE_CANARY_PAYLOAD, 'utf8') ||
    canary?.checksumSha256 !== RESTORE_CANARY_CHECKSUM_BASE64
  ) {
    return fail();
  }
  return true;
}
