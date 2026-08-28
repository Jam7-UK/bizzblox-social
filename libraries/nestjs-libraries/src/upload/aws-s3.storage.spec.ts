import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AwsS3Storage, type AwsS3StorageConfig } from './aws-s3.storage';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Zb8AAAAASUVORK5CYII=',
  'base64'
);

const config: AwsS3StorageConfig = Object.freeze({
  bucket: 'bizzblox-social-media-test',
  keyPrefix: 'managed-media/',
  kmsKeyArn:
    'arn:aws:kms:eu-west-2:111111111111:key/11111111-1111-1111-1111-111111111111',
  region: 'eu-west-2',
  signedReadSeconds: 300,
});

describe('AwsS3Storage', () => {
  const send = vi.fn().mockResolvedValue({});
  const sign = vi
    .fn()
    .mockResolvedValue(
      'https://bizzblox-social-media-test.s3.eu-west-2.amazonaws.com/managed-media/fixed.png?signature=opaque'
    );

  beforeEach(() => {
    send.mockClear();
    sign.mockClear();
  });

  function storage() {
    return new AwsS3Storage(config, {
      client: { send },
      createId: () => 'fixed',
      sign,
    });
  }

  it('writes a private checksum-bound KMS object and signs only its exact read', async () => {
    const result = await storage().uploadFile({
      buffer: PNG,
      size: PNG.byteLength,
      mimetype: 'image/png',
      originalname: 'claimed.html',
    } as Express.Multer.File);

    const put = send.mock.calls[0]?.[0];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: config.bucket,
      BucketKeyEnabled: true,
      ContentLength: PNG.byteLength,
      ContentType: 'image/png',
      Key: 'managed-media/fixed.png',
      SSEKMSKeyId: config.kmsKeyArn,
      ServerSideEncryption: 'aws:kms',
    });
    expect(put.input).not.toHaveProperty('ACL');
    expect(put.input.ChecksumSHA256).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(
      JSON.parse(
        Buffer.from(put.input.SSEKMSEncryptionContext!, 'base64').toString(
          'utf8'
        )
      )
    ).toEqual({
      key: 'managed-media/fixed.png',
      purpose: 'bizzblox-social-media',
    });

    const get = sign.mock.calls[0]?.[1];
    expect(get).toBeInstanceOf(GetObjectCommand);
    expect(get.input).toEqual({
      Bucket: config.bucket,
      Key: 'managed-media/fixed.png',
    });
    expect(sign.mock.calls[0]?.[2]).toEqual({ expiresIn: 300 });
    expect(result).toMatchObject({
      filename: 'fixed.png',
      mimetype: 'image/png',
      size: PNG.byteLength,
      path: expect.stringContaining('/managed-media/fixed.png?'),
    });
  });

  it('uses the same bounded media validation for data URLs', async () => {
    await expect(
      storage().uploadSimple(`data:image/png;base64,${PNG.toString('base64')}`)
    ).resolves.toContain('/managed-media/fixed.png?');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported bytes, oversized objects, and foreign deletes', async () => {
    await expect(
      storage().uploadFile({
        buffer: Buffer.from('<svg onload=alert(1)>'),
        size: 21,
      } as Express.Multer.File)
    ).rejects.toThrow('Unsupported file type.');
    await expect(
      storage().uploadFile({
        buffer: Buffer.alloc(50 * 1024 * 1024 + 1),
        size: 50 * 1024 * 1024 + 1,
      } as Express.Multer.File)
    ).rejects.toThrow('Media exceeds the production size limit.');
    await expect(
      storage().removeFile(
        'https://attacker.example/managed-media/fixed.png?signature=opaque'
      )
    ).rejects.toThrow('Invalid managed media reference.');
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes only an exact signed reference from the configured prefix', async () => {
    await storage().removeFile(
      'https://bizzblox-social-media-test.s3.eu-west-2.amazonaws.com/managed-media/fixed.png?signature=opaque'
    );
    const deletion = send.mock.calls[0]?.[0];
    expect(deletion).toBeInstanceOf(DeleteObjectCommand);
    expect(deletion.input).toEqual({
      Bucket: config.bucket,
      Key: 'managed-media/fixed.png',
    });
  });
});
