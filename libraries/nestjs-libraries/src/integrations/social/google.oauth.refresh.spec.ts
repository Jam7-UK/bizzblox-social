import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { refreshGoogleCredentials } from './google.oauth.refresh';

afterEach(() => vi.restoreAllMocks());
describe('Google refresh exchange evidence', () => {
  it.each([
    ['invalid_grant', 400, true, 'consent'],
    ['invalid_grant', 400, false, 'configuration'],
    ['invalid_client', 400, true, 'configuration'],
    ['invalid_scope', 400, true, 'configuration'],
    ['invalid_grant extra words', 400, true, 'retry'],
    ['invalid_grant', 401, true, 'retry'],
  ])(
    'classifies only exact authoritative token response %s/%s (verified=%s)',
    async (error, status, verified, kind) => {
      vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockRejectedValue({
        message: 'raw-secret',
        response: {
          config: {
            url: 'https://oauth2.googleapis.com/token',
            method: 'POST',
          },
          status,
          data: { error },
        },
      });
      await expect(
        refreshGoogleCredentials(
          'client',
          'secret',
          'refresh',
          verified as boolean
        )
      ).rejects.toMatchObject({
        kind,
        message: 'Provider credential refresh did not complete.',
      });
    }
  );
  it('cannot classify a profile response as revoked refresh consent and does not call provider with missing configuration', async () => {
    const exchange = vi
      .spyOn(OAuth2Client.prototype, 'refreshAccessToken')
      .mockRejectedValue({
        response: {
          config: {
            url: 'https://www.googleapis.com/oauth2/v2/userinfo',
            method: 'GET',
          },
          status: 400,
          data: { error: 'invalid_grant' },
        },
      });
    await expect(
      refreshGoogleCredentials('client', 'secret', 'refresh', true)
    ).rejects.toMatchObject({ kind: 'retry' });
    exchange.mockClear();
    await expect(
      refreshGoogleCredentials('', 'secret', 'refresh', true)
    ).rejects.toMatchObject({ kind: 'configuration' });
    expect(exchange).not.toHaveBeenCalled();
  });
  it('retains the stable refresh token without requiring a profile read', async () => {
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockResolvedValue({
      credentials: {
        access_token: 'fresh',
        expiry_date: Date.now() + 3600_000,
      },
    });
    await expect(
      refreshGoogleCredentials('client', 'secret', 'original', true)
    ).resolves.toMatchObject({
      accessToken: 'fresh',
      refreshToken: 'original',
      expiresIn: expect.any(Number),
    });
  });
});
