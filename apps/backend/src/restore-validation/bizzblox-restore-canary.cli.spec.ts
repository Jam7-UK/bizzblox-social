import { describe, expect, it, vi } from 'vitest';

import { RestoreProbeError } from './bizzblox-restore-probe';
import {
  DATABASE_CANARY_PERSISTED_RESULT,
  MEDIA_CANARY_PERSISTED_RESULT,
} from './bizzblox-restore-canary-bootstrap';
import { runRestoreCanaryCli } from './bizzblox-restore-canary.cli';

describe('BizzBLOX restore canary CLI', () => {
  it.each(['application', 'temporal'] as const)(
    'persists the %s database canary',
    async (kind) => {
      const database = vi
        .fn()
        .mockResolvedValue(DATABASE_CANARY_PERSISTED_RESULT);
      await expect(
        runRestoreCanaryCli(['--kind', kind], {}, { database, media: vi.fn() })
      ).resolves.toBe(DATABASE_CANARY_PERSISTED_RESULT);
      expect(database).toHaveBeenCalledWith(kind);
    }
  );

  it('persists media only into the exact configured production bucket and key', async () => {
    const media = vi.fn().mockResolvedValue(MEDIA_CANARY_PERSISTED_RESULT);
    await expect(
      runRestoreCanaryCli(
        ['--kind', 'media'],
        {
          BIZZBLOX_MEDIA_BUCKET: 'bizzblox-social-production-media',
          BIZZBLOX_MEDIA_KMS_KEY_ARN:
            'arn:aws:kms:eu-west-2:111111111111:key/11111111-1111-4111-8111-111111111111',
        },
        { database: vi.fn(), media }
      )
    ).resolves.toBe(MEDIA_CANARY_PERSISTED_RESULT);
    expect(media).toHaveBeenCalledWith({
      bucket: 'bizzblox-social-production-media',
      kmsKeyArn:
        'arn:aws:kms:eu-west-2:111111111111:key/11111111-1111-4111-8111-111111111111',
    });
  });

  it.each([
    [['--kind', 'unknown'], {}],
    [['--kind', 'media'], {}],
    [['--kind', 'application', '--verbose'], {}],
  ])(
    'fails closed for unsupported or incomplete invocation',
    async (args, env) => {
      try {
        await runRestoreCanaryCli(args, env, {
          database: vi.fn(),
          media: vi.fn(),
        });
        throw new Error('expected bootstrap to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(RestoreProbeError);
        expect((error as Error).message).toBe('Restore probe failed.');
      }
    }
  );
});
