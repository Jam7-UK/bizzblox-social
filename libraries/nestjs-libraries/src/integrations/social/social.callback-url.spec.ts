import { describe, expect, it } from 'vitest';

import { socialCallbackUrl } from './social.callback-url';

describe('managed social callback URL', () => {
  it('uses the exact branded callback when supplied and preserves legacy callers', () => {
    expect(
      socialCallbackUrl(
        'linkedin',
        'https://social.bizzblox.com/oauth/bizzblox/callback/linkedin',
        'https://postiz.example.com/integrations/social/linkedin'
      )
    ).toBe('https://social.bizzblox.com/oauth/bizzblox/callback/linkedin');
    expect(
      socialCallbackUrl(
        'linkedin',
        undefined,
        'https://postiz.example.com/integrations/social/linkedin'
      )
    ).toBe('https://postiz.example.com/integrations/social/linkedin');
  });

  it('rejects cross-provider and non-branded callback overrides', () => {
    expect(() =>
      socialCallbackUrl(
        'linkedin',
        'https://social.bizzblox.com/oauth/bizzblox/callback/facebook',
        'https://postiz.example.com/integrations/social/linkedin'
      )
    ).toThrow(/invalid managed social callback/i);
    expect(() =>
      socialCallbackUrl(
        'linkedin',
        'https://evil.example.com/oauth/bizzblox/callback/linkedin',
        'https://postiz.example.com/integrations/social/linkedin'
      )
    ).toThrow(/invalid managed social callback/i);
  });

  it('preserves TikTok Business callback registration trailing slash semantics', () => {
    expect(
      socialCallbackUrl(
        'tiktok-business',
        'https://social.bizzblox.com/oauth/bizzblox/callback/tiktok-business',
        'https://postiz.example.com/integrations/social/tiktok-business/'
      )
    ).toBe(
      'https://social.bizzblox.com/oauth/bizzblox/callback/tiktok-business/'
    );
  });
});
