import { describe, expect, it, vi } from 'vitest';

import { BizzbloxOAuthController } from './bizzblox-oauth.controller';

describe('BizzBLOX branded OAuth callback', () => {
  it('redirects only an opaque one-use outcome handle to AMP', async () => {
    const connections = {
      completeCallback: vi.fn().mockResolvedValue({
        outcome: 'ready',
        redirectUrl:
          'https://mvp.bizzblox.com/settings/social?outcome=outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
      }),
    };
    const controller = new BizzbloxOAuthController(connections as never, {
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
      clock: () => new Date('2026-08-27T22:02:00.000Z'),
      publicOrigin: 'https://social.bizzblox.com',
    });

    const result = await controller.callback(
      'linkedin',
      'provider-state-1',
      'authorization-code-1'
    );

    expect(connections.completeCallback).toHaveBeenCalledWith({
      provider: 'linkedin',
      providerState: 'provider-state-1',
      code: 'authorization-code-1',
    });
    expect(result.statusCode).toBe(303);
    const redirect = new URL(result.url);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(
      'https://mvp.bizzblox.com/settings/social'
    );
    expect(redirect.searchParams.get('outcome')).toBe(
      'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456'
    );
    expect(redirect.searchParams.has('social')).toBe(false);
    expect(redirect.searchParams.has('provider')).toBe(false);
    expect(redirect.hash).toBe('');
    expect(result.url).not.toContain('postiz');
    expect(result.url).not.toContain('remote-page');
  });

  it('uses the fixed safe failure redirect when the provider omits callback values', async () => {
    const connections = {
      completeCallback: vi.fn().mockResolvedValue({
        outcome: 'failed',
        redirectUrl: 'https://mvp.bizzblox.com/settings/social?social=failed',
      }),
    };
    const controller = new BizzbloxOAuthController(connections as never, {
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
      clock: () => new Date('2026-08-27T22:02:00.000Z'),
      publicOrigin: 'https://social.bizzblox.com',
    });

    await expect(
      controller.callback('linkedin', undefined, undefined)
    ).resolves.toEqual({
      statusCode: 303,
      url: 'https://mvp.bizzblox.com/settings/social?social=failed',
    });
  });
});
