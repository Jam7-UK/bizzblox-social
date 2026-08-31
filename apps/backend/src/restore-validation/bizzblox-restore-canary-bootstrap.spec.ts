import {
  GetObjectAttributesCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { RestoreProbeError } from './bizzblox-restore-probe';
import {
  DATABASE_CANARY_PERSISTED_RESULT,
  MEDIA_CANARY_PERSISTED_RESULT,
  persistDatabaseRestoreCanary,
  persistDatabaseRestoreManifest,
  persistMediaRestoreCanary,
  persistMediaRestoreManifest,
} from './bizzblox-restore-canary-bootstrap';

const databaseCanary = {
  checksum: '254ca8df293cebe8c2ac27223b56aeed467a1492d381b68a5ca80e917386614f',
  id: 'bizzblox-social-restore-canary-v1',
};

describe('BizzBLOX restore canary bootstrap', () => {
  it('keeps the durable canary in the Prisma schema managed by production pushes', () => {
    const schema = readFileSync(
      new URL(
        '../../../../libraries/nestjs-libraries/src/database/prisma/schema.prisma',
        import.meta.url
      ),
      'utf8'
    );
    const model = schema.match(
      /model BizzbloxRestoreCanary \{[\s\S]*?\n\}/
    )?.[0];

    expect(model).toContain('id               String   @id');
    expect(model).toContain('checksum         String   @db.Char(64)');
    expect(model).toContain(
      'expectedManifest Json?    @map("expected_manifest")'
    );
    expect(model).toContain(
      'updatedAt        DateTime @default(now()) @map("updated_at") @db.Timestamptz(6)'
    );
    expect(model).toContain('@@map("bizzblox_restore_canary")');
  });

  it('idempotently persists and reads back the fixed database canary', async () => {
    const execute = vi.fn().mockResolvedValue(1);
    const query = vi.fn().mockResolvedValue([databaseCanary]);

    await expect(
      persistDatabaseRestoreCanary({ execute, query })
    ).resolves.toBe(DATABASE_CANARY_PERSISTED_RESULT);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]?.[0]).toContain(
      'CREATE TABLE IF NOT EXISTS "public"."bizzblox_restore_canary"'
    );
    expect(execute.mock.calls[1]?.[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "expected_manifest" jsonb'
    );
    expect(execute.mock.calls[2]?.[0]).toContain(
      'ON CONFLICT ("id") DO UPDATE'
    );
    expect(execute.mock.calls[2]?.[0]).toContain(databaseCanary.checksum);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"bizzblox_restore_canary"')
    );
  });

  it('anchors a value-free database manifest in the row included by the backup', async () => {
    const execute = vi.fn().mockResolvedValue(1);
    await expect(
      persistDatabaseRestoreManifest(
        { execute, query: vi.fn() },
        {
          dataDigest: 'a'.repeat(64),
          migrationDigest: 'b'.repeat(64),
          rowCount: 42,
        }
      )
    ).resolves.toBe(DATABASE_CANARY_PERSISTED_RESULT);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toContain('"expected_manifest" =');
    expect(execute.mock.calls[0]?.[0]).toContain('"rowCount":42');
    expect(execute.mock.calls[0]?.[0]).toContain(
      `WHERE "id" = '${databaseCanary.id}'`
    );
  });

  it('persists the private checksum-bound S3 canary and reads back its attributes', async () => {
    const send = vi.fn(async (command: unknown) =>
      command instanceof PutObjectCommand
        ? {}
        : {
            Checksum: {
              ChecksumSHA256: 'JUyo3yk86+jCrCciO1au7UZ6FJLTgbaKXKgOkXOGYU8=',
            },
            ObjectSize: 57,
          }
    );

    await expect(
      persistMediaRestoreCanary(
        {
          bucket: 'bizzblox-social-production-media',
          kmsKeyArn:
            'arn:aws:kms:eu-west-2:111111111111:key/11111111-1111-4111-8111-111111111111',
        },
        { send }
      )
    ).resolves.toBe(MEDIA_CANARY_PERSISTED_RESULT);

    const put = send.mock.calls[0]?.[0];
    if (!(put instanceof PutObjectCommand)) {
      throw new Error('expected PutObjectCommand');
    }
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Body: Buffer.from(
        '{"purpose":"bizzblox-social-restore-canary","version":1}\n'
      ),
      Bucket: 'bizzblox-social-production-media',
      ChecksumSHA256: 'JUyo3yk86+jCrCciO1au7UZ6FJLTgbaKXKgOkXOGYU8=',
      ContentLength: 57,
      ContentType: 'application/json',
      Key: 'bizzblox-validation/restore-canary-v1.json',
      SSEKMSKeyId:
        'arn:aws:kms:eu-west-2:111111111111:key/11111111-1111-4111-8111-111111111111',
      ServerSideEncryption: 'aws:kms',
    });
    const readback = send.mock.calls[1]?.[0];
    expect(readback).toBeInstanceOf(GetObjectAttributesCommand);
  });

  it('anchors and checksum-verifies the media inventory manifest in the backed-up bucket', async () => {
    const send = vi.fn(async (command: unknown) =>
      command instanceof PutObjectCommand
        ? {}
        : {
            Checksum: {
              ChecksumSHA256:
                command instanceof GetObjectAttributesCommand
                  ? command.input.Key ===
                    'bizzblox-validation/restore-manifest-v2.json'
                    ? expect.any(String)
                    : 'wrong'
                  : 'wrong',
            },
          }
    );
    // Return the provider checksum that the write request asked S3 to retain.
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) return {};
      const put = send.mock.calls[0]?.[0];
      if (!(put instanceof PutObjectCommand)) throw new Error('missing put');
      return {
        Checksum: { ChecksumSHA256: put.input.ChecksumSHA256 },
        ObjectSize: put.input.ContentLength,
      };
    });
    await expect(
      persistMediaRestoreManifest(
        {
          bucket: 'bizzblox-social-production-media',
          kmsKeyArn:
            'arn:aws:kms:eu-west-2:111111111111:key/11111111-1111-4111-8111-111111111111',
        },
        {
          byteCount: 2048,
          inventoryDigest: 'a'.repeat(64),
          objectCount: 2,
        },
        { send }
      )
    ).resolves.toBe(MEDIA_CANARY_PERSISTED_RESULT);
    const put = send.mock.calls[0]?.[0];
    if (!(put instanceof PutObjectCommand)) throw new Error('expected put');
    expect(put.input).toMatchObject({
      Bucket: 'bizzblox-social-production-media',
      ContentType: 'application/json',
      Key: 'bizzblox-validation/restore-manifest-v2.json',
      ServerSideEncryption: 'aws:kms',
    });
    expect(String(put.input.Body)).not.toContain('customer');
  });

  it('fails closed when either canary cannot be read back exactly', async () => {
    await expect(
      persistDatabaseRestoreCanary({
        execute: vi.fn().mockResolvedValue(1),
        query: vi.fn().mockResolvedValue([]),
      })
    ).rejects.toBeInstanceOf(RestoreProbeError);

    await expect(
      persistMediaRestoreCanary(
        {
          bucket: 'bizzblox-social-production-media',
          kmsKeyArn:
            'arn:aws:kms:eu-west-2:111111111111:key/11111111-1111-4111-8111-111111111111',
        },
        {
          send: vi.fn().mockResolvedValue({
            Checksum: { ChecksumSHA256: 'wrong' },
            ObjectSize: 57,
          }),
        }
      )
    ).rejects.toBeInstanceOf(RestoreProbeError);
  });
});
