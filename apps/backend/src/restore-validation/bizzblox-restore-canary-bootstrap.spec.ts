import {
  GetObjectAttributesCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { RestoreProbeError } from './bizzblox-restore-probe';
import {
  DATABASE_CANARY_PERSISTED_RESULT,
  MEDIA_CANARY_PERSISTED_RESULT,
  persistDatabaseRestoreCanary,
  persistMediaRestoreCanary,
} from './bizzblox-restore-canary-bootstrap';

const databaseCanary = {
  checksum: '254ca8df293cebe8c2ac27223b56aeed467a1492d381b68a5ca80e917386614f',
  id: 'bizzblox-social-restore-canary-v1',
};

describe('BizzBLOX restore canary bootstrap', () => {
  it('idempotently persists and reads back the fixed database canary', async () => {
    const execute = vi.fn().mockResolvedValue(1);
    const query = vi.fn().mockResolvedValue([databaseCanary]);

    await expect(
      persistDatabaseRestoreCanary({ execute, query })
    ).resolves.toBe(DATABASE_CANARY_PERSISTED_RESULT);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toContain(
      'CREATE TABLE IF NOT EXISTS "public"."bizzblox_restore_canary"'
    );
    expect(execute.mock.calls[1]?.[0]).toContain(
      'ON CONFLICT ("id") DO UPDATE'
    );
    expect(execute.mock.calls[1]?.[0]).toContain(databaseCanary.checksum);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"bizzblox_restore_canary"')
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
