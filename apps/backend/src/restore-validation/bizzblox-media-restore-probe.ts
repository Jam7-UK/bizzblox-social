import {
  GetObjectCommand,
  GetObjectAttributesCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  RestoreProbeError,
  buildMediaRestoreSnapshot,
  type MediaRestoreSnapshot,
} from './bizzblox-restore-probe';
import {
  RESTORE_CANARY_MEDIA_KEY,
  RESTORE_MANIFEST_MEDIA_KEY,
  verifyMediaRestoreCanary,
} from './bizzblox-restore-canary';

const MEDIA_PREFIX = 'managed-media/';
const MAX_OBJECTS = 100_000;
const MAX_PAGES = 1_000;
const ATTRIBUTE_CONCURRENCY = 16;

export type RestoreMediaCommandClient = Readonly<{
  send: (
    command:
      | ListObjectsV2Command
      | GetObjectAttributesCommand
      | GetObjectCommand
  ) => Promise<unknown>;
}>;

type ListedObject = Readonly<{ byteCount: number; key: string }>;

function fail(): never {
  throw new RestoreProbeError();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail();
  }
  return value as Readonly<Record<string, unknown>>;
}

function bucketName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) ||
    value.includes('..') ||
    value.includes('.-') ||
    value.includes('-.') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) {
    return fail();
  }
  return value;
}

function key(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(MEDIA_PREFIX) ||
    value.length === MEDIA_PREFIX.length ||
    Buffer.byteLength(value, 'utf8') > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fail();
  }
  return value;
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail();
  return value as number;
}

function checksumSha256(value: unknown): string {
  if (typeof value !== 'string') return fail();
  return value;
}

function optionalToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048)
    return fail();
  return value;
}

async function boundedBody(value: unknown): Promise<string> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !(Symbol.asyncIterator in value)
  ) {
    return fail();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of value as AsyncIterable<unknown>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.byteLength;
    if (total > 4 * 1024) return fail();
    chunks.push(bytes);
  }
  if (total === 0) return fail();
  return Buffer.concat(chunks, total).toString('utf8');
}

function manifest(value: unknown) {
  const candidate = record(value);
  const keys = Object.keys(candidate).sort();
  if (
    keys.join(',') !== 'byteCount,inventoryDigest,objectCount' ||
    !Number.isSafeInteger(candidate.byteCount) ||
    (candidate.byteCount as number) < 0 ||
    !/^[a-f0-9]{64}$/.test(String(candidate.inventoryDigest ?? '')) ||
    !Number.isSafeInteger(candidate.objectCount) ||
    (candidate.objectCount as number) < 0
  ) {
    return fail();
  }
  return Object.freeze({
    byteCount: candidate.byteCount as number,
    inventoryDigest: candidate.inventoryDigest as string,
    objectCount: candidate.objectCount as number,
  });
}

/** Reads the strict aggregate manifest that was included in the recovery point. */
export async function readMediaRestoreManifest(
  restoredBucket: string,
  client: RestoreMediaCommandClient
) {
  try {
    const bucket = bucketName(restoredBucket);
    const response = record(
      await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: RESTORE_MANIFEST_MEDIA_KEY,
        })
      )
    );
    if (
      !Number.isSafeInteger(response.ContentLength) ||
      (response.ContentLength as number) < 1 ||
      (response.ContentLength as number) > 4 * 1024
    ) {
      return fail();
    }
    const body = await boundedBody(response.Body);
    if (Buffer.byteLength(body, 'utf8') !== response.ContentLength)
      return fail();
    return manifest(JSON.parse(body) as unknown);
  } catch {
    return fail();
  }
}

async function listObjects(
  bucket: string,
  client: RestoreMediaCommandClient
): Promise<readonly ListedObject[]> {
  const objects: ListedObject[] = [];
  const tokens = new Set<string>();
  let continuationToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = record(
      await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: MEDIA_PREFIX,
          MaxKeys: 1_000,
          ...(continuationToken
            ? { ContinuationToken: continuationToken }
            : {}),
        })
      )
    );
    const contents =
      response.Contents === undefined
        ? []
        : Array.isArray(response.Contents)
        ? response.Contents
        : fail();
    for (const value of contents) {
      const object = record(value);
      objects.push(
        Object.freeze({
          byteCount: safeCount(object.Size),
          key: key(object.Key),
        })
      );
      if (objects.length > MAX_OBJECTS) return fail();
    }
    if (typeof response.IsTruncated !== 'boolean') return fail();
    if (!response.IsTruncated) return Object.freeze(objects);
    const next = optionalToken(response.NextContinuationToken);
    if (!next || tokens.has(next)) return fail();
    tokens.add(next);
    continuationToken = next;
  }
  return fail();
}

async function verifyObject(
  bucket: string,
  object: ListedObject,
  client: RestoreMediaCommandClient
) {
  const response = record(
    await client.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: object.key,
        ObjectAttributes: ['Checksum', 'ObjectSize'],
      })
    )
  );
  const checksum = record(response.Checksum);
  if (safeCount(response.ObjectSize) !== object.byteCount) return fail();
  return Object.freeze({
    byteCount: object.byteCount,
    checksumSha256: checksumSha256(checksum.ChecksumSHA256),
    key: object.key,
  });
}

async function verifyCanary(
  bucket: string,
  client: RestoreMediaCommandClient
): Promise<true> {
  const response = record(
    await client.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: RESTORE_CANARY_MEDIA_KEY,
        ObjectAttributes: ['Checksum', 'ObjectSize'],
      })
    )
  );
  const checksum = record(response.Checksum);
  return verifyMediaRestoreCanary({
    byteCount: response.ObjectSize,
    checksumSha256: checksum.ChecksumSHA256,
    key: RESTORE_CANARY_MEDIA_KEY,
  });
}

/** Lists only the managed prefix and verifies provider-held checksum metadata. */
export async function collectMediaRestoreSnapshot(
  restoredBucket: string,
  client: RestoreMediaCommandClient
): Promise<MediaRestoreSnapshot> {
  try {
    const bucket = bucketName(restoredBucket);
    const listed = await listObjects(bucket, client);
    const canaryVerified = await verifyCanary(bucket, client);
    const verified = [];
    for (
      let offset = 0;
      offset < listed.length;
      offset += ATTRIBUTE_CONCURRENCY
    ) {
      verified.push(
        ...(await Promise.all(
          listed
            .slice(offset, offset + ATTRIBUTE_CONCURRENCY)
            .map((object) => verifyObject(bucket, object, client))
        ))
      );
    }
    return buildMediaRestoreSnapshot(Object.freeze(verified), canaryVerified);
  } catch {
    return fail();
  }
}

export function s3RestoreMediaCommandClient(): RestoreMediaCommandClient {
  const client = new S3Client({ region: 'eu-west-2' });
  return Object.freeze({
    send: (
      command:
        | ListObjectsV2Command
        | GetObjectAttributesCommand
        | GetObjectCommand
    ) => {
      if (command instanceof ListObjectsV2Command) return client.send(command);
      if (command instanceof GetObjectCommand) return client.send(command);
      return client.send(command);
    },
  });
}
