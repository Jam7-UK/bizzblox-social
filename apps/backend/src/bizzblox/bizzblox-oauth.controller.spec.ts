import { describe, expect, it, vi } from 'vitest';

import { BizzbloxOAuthController } from './bizzblox-oauth.controller';

describe('BizzBLOX branded OAuth callback', () => {
  it('redirects safe two-step choices to AMP in a fragment', async () => {
    const connections = {
      completeCallback: vi.fn().mockResolvedValue({
        outcome: 'selection_required',
        attemptHandle: 'selection-attempt-1',
        expiresAt: Date.parse('2026-08-27T22:07:00.000Z'),
        options: [
          {
            optionRef: 'selection-option-1',
            label: 'BizzBLOX Company',
            picture: 'https://cdn.linkedin.com/company.png',
          },
        ],
      }),
    };
    const controller = new BizzbloxOAuthController(connections as never, {
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
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
      'https://mvp.bizzblox.com/settings/integrations/social'
    );
    expect(redirect.searchParams.get('social')).toBe('selection_required');
    const encoded = new URLSearchParams(redirect.hash.slice(1)).get(
      'selection'
    );
    expect(encoded).not.toBeNull();
    expect(
      JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))
    ).toEqual({
      attemptHandle: 'selection-attempt-1',
      expiresAt: Date.parse('2026-08-27T22:07:00.000Z'),
      options: [
        {
          optionRef: 'selection-option-1',
          label: 'BizzBLOX Company',
          picture: 'https://cdn.linkedin.com/company.png',
        },
      ],
    });
    expect(result.url).not.toContain('postiz');
    expect(result.url).not.toContain('remote-page');
  });

  it('uses the fixed safe failure redirect when the provider omits callback values', async () => {
    const connections = {
      completeCallback: vi.fn().mockResolvedValue({
        outcome: 'failed',
        redirectUrl:
          'https://mvp.bizzblox.com/settings/integrations/social?social=failed',
      }),
    };
    const controller = new BizzbloxOAuthController(connections as never, {
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
      clock: () => new Date('2026-08-27T22:02:00.000Z'),
      publicOrigin: 'https://social.bizzblox.com',
    });

    await expect(
      controller.callback('linkedin', undefined, undefined)
    ).resolves.toEqual({
      statusCode: 303,
      url: 'https://mvp.bizzblox.com/settings/integrations/social?social=failed',
    });
  });
});
