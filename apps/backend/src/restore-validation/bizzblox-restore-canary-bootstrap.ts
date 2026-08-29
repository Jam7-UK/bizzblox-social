import {
  GetObjectAttributesCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

import { RestoreProbeError } from './bizzblox-restore-probe';
import {
  RESTORE_CANARY_CHECKSUM_BASE64,
  RESTORE_CANARY_CHECKSUM_HEX,
  RESTORE_CANARY_DATABASE_ID,
  RESTORE_CANARY_MEDIA_KEY,
  RESTORE_CANARY_PAYLOAD,
  RESTORE_MANIFEST_MEDIA_KEY,
  verifyDatabaseRestoreCanary,
  verifyMediaRestoreCanary,
} from './bizzblox-restore-canary';
import type {
  DatabaseRestoreSnapshot,
  MediaRestoreSnapshot,
} from './bizzblox-restore-probe';

export const DATABASE_CANARY_PERSISTED_RESULT =
  'bizzblox-social-canary:v1;database=persisted';
export const MEDIA_CANARY_PERSISTED_RESULT =
  'bizzblox-social-canary:v1;media=persisted';

export type RestoreCanaryDatabaseClient = Readonly<{
  execute: (statement: string) => Promise<unknown>;
  query: (statement: string) => Promise<readonly unknown[]>;
}>;

export type RestoreCanaryMediaClient = Readonly<{
  send: (
    command: PutObjectCommand | GetObjectAttributesCommand
  ) => Promise<unknown>;
}>;

type MediaCanaryConfig = Readonly<{ bucket: string; kmsKeyArn: string }>;

type DatabaseManifest = Pick<
  DatabaseRestoreSnapshot,
  'dataDigest' | 'migrationDigest' | 'rowCount'
>;
type MediaManifest = Pick<
  MediaRestoreSnapshot,
  'byteCount' | 'inventoryDigest' | 'objectCount'
>;

function fail(): never {
  throw new RestoreProbeError();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail();
  }
  return value as Readonly<Record<string, unknown>>;
}

function validateMediaConfig(config: MediaCanaryConfig): MediaCanaryConfig {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config?.bucket ?? '') ||
    !/^arn:aws:kms:eu-west-2:[0-9]{12}:key\/[0-9a-f-]{36}$/.test(
      config?.kmsKeyArn ?? ''
    )
  ) {
    return fail();
  }
  return config;
}

function databaseManifest(value: DatabaseManifest): DatabaseManifest {
  if (
    !/^[a-f0-9]{64}$/.test(value?.dataDigest ?? '') ||
    !/^[a-f0-9]{64}$/.test(value?.migrationDigest ?? '') ||
    !Number.isSafeInteger(value?.rowCount) ||
    value.rowCount < 0
  ) {
    return fail();
  }
  return Object.freeze({
    dataDigest: value.dataDigest,
    migrationDigest: value.migrationDigest,
    rowCount: value.rowCount,
  });
}

function mediaManifest(value: MediaManifest): MediaManifest {
  if (
    !Number.isSafeInteger(value?.byteCount) ||
    value.byteCount < 0 ||
    !/^[a-f0-9]{64}$/.test(value?.inventoryDigest ?? '') ||
    !Number.isSafeInteger(value?.objectCount) ||
    value.objectCount < 0
  ) {
    return fail();
  }
  return Object.freeze({
    byteCount: value.byteCount,
    inventoryDigest: value.inventoryDigest,
    objectCount: value.objectCount,
  });
}

/** Creates/upserts a fixed row and verifies it before any backup can rely on it. */
export async function persistDatabaseRestoreCanary(
  client: RestoreCanaryDatabaseClient
): Promise<string> {
  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "public"."bizzblox_restore_canary" (
        "id" text PRIMARY KEY,
        "checksum" char(64) NOT NULL,
        "expected_manifest" jsonb,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.execute(`
      ALTER TABLE "public"."bizzblox_restore_canary"
      ADD COLUMN IF NOT EXISTS "expected_manifest" jsonb
    `);
    await client.execute(`
      INSERT INTO "public"."bizzblox_restore_canary" ("id", "checksum")
      VALUES ('${RESTORE_CANARY_DATABASE_ID}', '${RESTORE_CANARY_CHECKSUM_HEX}')
      ON CONFLICT ("id") DO UPDATE
      SET "checksum" = EXCLUDED."checksum", "updated_at" = now()
    `);
    const rows = await client.query(`
      SELECT "id", "checksum"
      FROM "public"."bizzblox_restore_canary"
      WHERE "id" = '${RESTORE_CANARY_DATABASE_ID}'
      LIMIT 2
    `);
    if (rows.length !== 1) return fail();
    const row = record(rows[0]);
    verifyDatabaseRestoreCanary({ checksum: row.checksum, id: row.id });
    return DATABASE_CANARY_PERSISTED_RESULT;
  } catch {
    return fail();
  }
}

/** Stores the pre-backup aggregate inside the database that AWS Backup snapshots. */
export async function persistDatabaseRestoreManifest(
  client: RestoreCanaryDatabaseClient,
  snapshot: DatabaseManifest
): Promise<string> {
  try {
    const expected = JSON.stringify(databaseManifest(snapshot));
    const result = await client.execute(`
      UPDATE "public"."bizzblox_restore_canary"
      SET "expected_manifest" = '${expected}'::jsonb, "updated_at" = now()
      WHERE "id" = '${RESTORE_CANARY_DATABASE_ID}'
        AND "checksum" = '${RESTORE_CANARY_CHECKSUM_HEX}'
    `);
    if (result !== 1 && result !== BigInt(1)) return fail();
    return DATABASE_CANARY_PERSISTED_RESULT;
  } catch {
    return fail();
  }
}

/** Writes a private checksum-bound object and verifies provider-held attributes. */
export async function persistMediaRestoreCanary(
  input: MediaCanaryConfig,
  client: RestoreCanaryMediaClient
): Promise<string> {
  try {
    const config = validateMediaConfig(input);
    const body = Buffer.from(RESTORE_CANARY_PAYLOAD, 'utf8');
    const encryptionContext = Buffer.from(
      JSON.stringify({
        key: RESTORE_CANARY_MEDIA_KEY,
        purpose: 'bizzblox-social-restore-canary',
      }),
      'utf8'
    ).toString('base64');
    await client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: config.bucket,
        BucketKeyEnabled: true,
        ChecksumSHA256: RESTORE_CANARY_CHECKSUM_BASE64,
        ContentLength: body.byteLength,
        ContentType: 'application/json',
        Key: RESTORE_CANARY_MEDIA_KEY,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: config.kmsKeyArn,
        SSEKMSEncryptionContext: encryptionContext,
      })
    );
    const response = record(
      await client.send(
        new GetObjectAttributesCommand({
          Bucket: config.bucket,
          Key: RESTORE_CANARY_MEDIA_KEY,
          ObjectAttributes: ['Checksum', 'ObjectSize'],
        })
      )
    );
    const checksum = record(response.Checksum);
    verifyMediaRestoreCanary({
      byteCount: response.ObjectSize,
      checksumSha256: checksum.ChecksumSHA256,
      key: RESTORE_CANARY_MEDIA_KEY,
    });
    return MEDIA_CANARY_PERSISTED_RESULT;
  } catch {
    return fail();
  }
}

/** Stores and reads back the value-free media manifest in the backed-up bucket. */
export async function persistMediaRestoreManifest(
  input: MediaCanaryConfig,
  snapshot: MediaManifest,
  client: RestoreCanaryMediaClient
): Promise<string> {
  try {
    const config = validateMediaConfig(input);
    const body = Buffer.from(
      `${JSON.stringify(mediaManifest(snapshot))}\n`,
      'utf8'
    );
    const checksum = createHash('sha256').update(body).digest('base64');
    await client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: config.bucket,
        BucketKeyEnabled: true,
        ChecksumSHA256: checksum,
        ContentLength: body.byteLength,
        ContentType: 'application/json',
        Key: RESTORE_MANIFEST_MEDIA_KEY,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: config.kmsKeyArn,
      })
    );
    const response = record(
      await client.send(
        new GetObjectAttributesCommand({
          Bucket: config.bucket,
          Key: RESTORE_MANIFEST_MEDIA_KEY,
          ObjectAttributes: ['Checksum', 'ObjectSize'],
        })
      )
    );
    const providerChecksum = record(response.Checksum);
    if (
      providerChecksum.ChecksumSHA256 !== checksum ||
      response.ObjectSize !== body.byteLength
    ) {
      return fail();
    }
    return MEDIA_CANARY_PERSISTED_RESULT;
  } catch {
    return fail();
  }
}
