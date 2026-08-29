import {
  GetObjectCommand,
  GetObjectAttributesCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { RestoreProbeError } from './bizzblox-restore-probe';
import {
  collectMediaRestoreSnapshot,
  readMediaRestoreManifest,
} from './bizzblox-media-restore-probe';

const CHECKSUM_A = Buffer.alloc(32, 1).toString('base64');
const CHECKSUM_B = Buffer.alloc(32, 2).toString('base64');

describe('BizzBLOX media restore probe adapter', () => {
  it('reads only the strict value-free manifest included in the recovery point', async () => {
    const expected = {
      byteCount: 384,
      inventoryDigest: 'a'.repeat(64),
      objectCount: 2,
    };
    const send = vi.fn().mockResolvedValue({
      Body: Readable.from([JSON.stringify(expected)]),
      ContentLength: Buffer.byteLength(JSON.stringify(expected)),
    });
    await expect(
      readMediaRestoreManifest('bizzblox-social-restored-media', { send })
    ).resolves.toEqual(expected);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input.Key).toBe(
      'bizzblox-validation/restore-manifest-v2.json'
    );
  });

  it('paginates the fixed prefix and verifies every stored SHA-256 attribute', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return command.input.ContinuationToken
          ? {
              Contents: [{ Key: 'managed-media/b.mp4', Size: 256 }],
              IsTruncated: false,
            }
          : {
              Contents: [{ Key: 'managed-media/a.png', Size: 128 }],
              IsTruncated: true,
              NextContinuationToken: 'opaque-next-page',
            };
      }
      if (command instanceof GetObjectAttributesCommand) {
        if (
          command.input.Key === 'bizzblox-validation/restore-canary-v1.json'
        ) {
          return {
            Checksum: {
              ChecksumSHA256: 'JUyo3yk86+jCrCciO1au7UZ6FJLTgbaKXKgOkXOGYU8=',
            },
            ObjectSize: 57,
          };
        }
        return command.input.Key?.endsWith('a.png')
          ? { Checksum: { ChecksumSHA256: CHECKSUM_A }, ObjectSize: 128 }
          : { Checksum: { ChecksumSHA256: CHECKSUM_B }, ObjectSize: 256 };
      }
      throw new Error('unexpected command');
    });

    const result = await collectMediaRestoreSnapshot(
      'bizzblox-social-restored-media',
      {
        send,
      }
    );

    expect(result).toEqual({
      byteCount: 384,
      canaryVerified: true,
      inventoryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      objectCount: 2,
      verifiedObjectCount: 2,
    });
    const listCommands = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof ListObjectsV2Command);
    expect(listCommands).toHaveLength(2);
    expect(listCommands[0]?.input).toEqual({
      Bucket: 'bizzblox-social-restored-media',
      MaxKeys: 1000,
      Prefix: 'managed-media/',
    });
    expect(listCommands[1]?.input.ContinuationToken).toBe('opaque-next-page');
    const attributeCommands = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof GetObjectAttributesCommand);
    expect(attributeCommands).toHaveLength(3);
    expect(attributeCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'bizzblox-social-restored-media',
            Key: 'bizzblox-validation/restore-canary-v1.json',
            ObjectAttributes: ['Checksum', 'ObjectSize'],
          }),
        }),
      ])
    );
    expect(attributeCommands[1]?.input).toMatchObject({
      Bucket: 'bizzblox-social-restored-media',
      ObjectAttributes: ['Checksum', 'ObjectSize'],
    });
  });

  it('accepts an empty restored media prefix as a complete inventory', async () => {
    const send = vi.fn(async (command: unknown) =>
      command instanceof ListObjectsV2Command
        ? { Contents: [], IsTruncated: false }
        : {
            Checksum: {
              ChecksumSHA256: 'JUyo3yk86+jCrCciO1au7UZ6FJLTgbaKXKgOkXOGYU8=',
            },
            ObjectSize: 57,
          }
    );
    await expect(
      collectMediaRestoreSnapshot('bizzblox-social-restored-media', { send })
    ).resolves.toMatchObject({
      byteCount: 0,
      objectCount: 0,
      verifiedObjectCount: 0,
    });
  });

  it.each([
    [
      'invalid bucket',
      'arn:aws:s3:::foreign',
      vi.fn().mockResolvedValue({ Contents: [], IsTruncated: false }),
    ],
    [
      'foreign key',
      'bizzblox-social-restored-media',
      vi.fn().mockResolvedValue({
        Contents: [{ Key: 'foreign/a.png', Size: 1 }],
        IsTruncated: false,
      }),
    ],
    [
      'repeated token',
      'bizzblox-social-restored-media',
      vi.fn().mockResolvedValue({
        Contents: [],
        IsTruncated: true,
        NextContinuationToken: 'same-token',
      }),
    ],
  ])(
    'rejects %s metadata with one generic error',
    async (_label, bucket, send) => {
      try {
        await collectMediaRestoreSnapshot(bucket, { send });
        throw new Error('expected probe to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(RestoreProbeError);
        expect((error as Error).message).toBe('Restore probe failed.');
      }
    }
  );

  it('rejects a provider size/checksum mismatch without echoing the key', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [
            { Key: 'managed-media/private-customer-name.png', Size: 128 },
          ],
          IsTruncated: false,
        };
      }
      return { Checksum: { ChecksumSHA256: CHECKSUM_A }, ObjectSize: 127 };
    });
    try {
      await collectMediaRestoreSnapshot('bizzblox-social-restored-media', {
        send,
      });
      throw new Error('expected probe to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreProbeError);
      expect((error as Error).message).not.toContain('customer');
    }
  });
});
