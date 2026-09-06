import { afterEach, describe, expect, it, vi } from 'vitest';

import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { LinkedinPageProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.page.provider';
import { LinkedinProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.provider';
import { XProvider } from '@gitroom/nestjs-libraries/integrations/social/x.provider';

import { PostizBizzbloxConnectionProviderGateway } from './bizzblox-connection-provider.gateway';

afterEach(() => vi.unstubAllEnvs());

class DefaultReadinessProvider extends SocialAbstract {
  identifier = 'default-readiness';
}

describe('Postiz BizzBLOX connection provider gateway', () => {
  it('keeps an unaudited provider inactive for new connections by default', () => {
    expect(new DefaultReadinessProvider().newConnectionStatus()).toBe(
      'inactive'
    );
  });

  it('activates LinkedIn and its page variant only with both non-blank prerequisites', () => {
    const linkedin = new LinkedinProvider();
    const linkedinPage = new LinkedinPageProvider();

    vi.stubEnv('LINKEDIN_CLIENT_ID', undefined);
    vi.stubEnv('LINKEDIN_CLIENT_SECRET', 'secret');
    expect(linkedin.newConnectionStatus()).toBe('inactive');
    expect(linkedinPage.newConnectionStatus()).toBe('inactive');

    vi.stubEnv('LINKEDIN_CLIENT_ID', 'client-id');
    vi.stubEnv('LINKEDIN_CLIENT_SECRET', undefined);
    expect(linkedin.newConnectionStatus()).toBe('inactive');
    expect(linkedinPage.newConnectionStatus()).toBe('inactive');

    vi.stubEnv('LINKEDIN_CLIENT_ID', '   ');
    vi.stubEnv('LINKEDIN_CLIENT_SECRET', 'secret');
    expect(linkedin.newConnectionStatus()).toBe('inactive');
    expect(linkedinPage.newConnectionStatus()).toBe('inactive');

    vi.stubEnv('LINKEDIN_CLIENT_ID', 'client-id');
    vi.stubEnv('LINKEDIN_CLIENT_SECRET', '   ');
    expect(linkedin.newConnectionStatus()).toBe('inactive');
    expect(linkedinPage.newConnectionStatus()).toBe('inactive');

    vi.stubEnv('LINKEDIN_CLIENT_SECRET', 'secret');
    expect(linkedin.newConnectionStatus()).toBe('active');
    expect(linkedinPage.newConnectionStatus()).toBe('active');
  });

  it('activates X only with both non-blank OAuth 1.0a prerequisites', () => {
    const provider = new XProvider();

    vi.stubEnv('X_API_KEY', undefined);
    vi.stubEnv('X_API_SECRET', 'secret');
    expect(provider.newConnectionStatus()).toBe('inactive');

    vi.stubEnv('X_API_KEY', 'api-key');
    vi.stubEnv('X_API_SECRET', undefined);
    expect(provider.newConnectionStatus()).toBe('inactive');

    vi.stubEnv('X_API_KEY', '   ');
    vi.stubEnv('X_API_SECRET', 'secret');
    expect(provider.newConnectionStatus()).toBe('inactive');

    vi.stubEnv('X_API_KEY', 'api-key');
    vi.stubEnv('X_API_SECRET', '   ');
    expect(provider.newConnectionStatus()).toBe('inactive');

    vi.stubEnv('X_API_SECRET', 'secret');
    expect(provider.newConnectionStatus()).toBe('active');
  });

  it('maps each provider redirect query to the state and code its authenticate expects', () => {
    const providers: Record<string, unknown> = {
      x: new XProvider(),
      linkedin: { identifier: 'linkedin' },
    };
    const manager = {
      getAllowedSocialsIntegrations: vi.fn().mockReturnValue(['x', 'linkedin']),
      isHiddenProvider: vi.fn().mockReturnValue(false),
      getSocialIntegration: vi.fn(
        (identifier: string) => providers[identifier]
      ),
    };
    const gateway = new PostizBizzbloxConnectionProviderGateway(
      manager as never,
      {} as never,
      {} as never
    );

    // X is OAuth 1.0a: the request token names the state, the verifier is the code.
    expect(
      gateway.readCallback('x', {
        oauth_token: 'request-token-1',
        oauth_verifier: 'verifier-1',
      })
    ).toEqual({ providerState: 'request-token-1', code: 'verifier-1' });
    expect(gateway.readCallback('x', { denied: 'request-token-1' })).toEqual({
      providerState: 'request-token-1',
      code: '',
    });
    expect(
      gateway.readCallback('linkedin', { state: 'state-1', code: 'code-1' })
    ).toEqual({ providerState: 'state-1', code: 'code-1' });
    expect(
      gateway.readCallback('linkedin', {
        state: 'state-1',
        error: 'unauthorized_scope_error',
      })
    ).toEqual({ providerState: 'state-1', code: '' });
    expect(() => gateway.readCallback('bluesky', { state: 's' })).toThrow(
      'Social provider is unavailable.'
    );
  });

  it('removes only the exact organization integration and proves it is gone', async () => {
    let integration = {
      id: 'integration-linkedin-1',
      organizationId: 'postiz-org-1',
      deletedAt: null as Date | null,
    };
    const integrations = {
      deleteChannel: vi.fn(async () => {
        integration = { ...integration, deletedAt: new Date() };
      }),
      getIntegrationById: vi.fn(async () => integration),
      hasLivePostsForChannel: vi.fn().mockResolvedValue(false),
    };
    const gateway = new PostizBizzbloxConnectionProviderGateway(
      {} as never,
      integrations as never,
      {} as never
    );

    await expect(
      gateway.disconnectAccount({
        organizationId: 'postiz-org-1',
        connectorRevision: 7,
        integrationId: 'integration-linkedin-1',
      })
    ).resolves.toEqual({ outcome: 'removed' });

    expect(integrations.getIntegrationById).toHaveBeenCalledWith(
      'postiz-org-1',
      'integration-linkedin-1'
    );
    expect(integrations.deleteChannel).toHaveBeenCalledWith(
      'postiz-org-1',
      'integration-linkedin-1'
    );
    expect(integrations.hasLivePostsForChannel).toHaveBeenCalledWith(
      'postiz-org-1',
      'integration-linkedin-1'
    );
  });

  it('refuses destructive removal while Postiz retains live posts', async () => {
    const integrations = {
      getIntegrationById: vi.fn().mockResolvedValue({
        id: 'integration-linkedin-1',
        organizationId: 'postiz-org-1',
        deletedAt: null,
      }),
      hasLivePostsForChannel: vi.fn().mockResolvedValue(true),
      deleteChannel: vi.fn(),
    };
    const gateway = new PostizBizzbloxConnectionProviderGateway(
      {} as never,
      integrations as never,
      {} as never
    );

    await expect(
      gateway.disconnectAccount({
        organizationId: 'postiz-org-1',
        connectorRevision: 7,
        integrationId: 'integration-linkedin-1',
      })
    ).resolves.toEqual({ outcome: 'reconcile_required' });
    expect(integrations.deleteChannel).not.toHaveBeenCalled();
  });

  it('projects only active providers with the compatibility marker and no provider secrets', async () => {
    const manager = {
      getAllIntegrations: vi.fn().mockResolvedValue({
        social: [
          {
            identifier: 'linkedin',
            name: 'LinkedIn',
            toolTip: 'Professional network',
            editor: 'normal',
            isExternal: false,
            runtimeSecret: 'linkedin-secret-never-returned',
            credentialVariable: 'LINKEDIN_CLIENT_SECRET',
          },
          {
            identifier: 'bluesky',
            name: 'Bluesky',
            customFields: [
              {
                key: 'password',
                label: 'App password',
                defaultValue: 'hidden',
              },
            ],
          },
        ],
        article: [],
      }),
      getNewConnectionStatus: vi.fn((identifier: string) =>
        identifier === 'linkedin' ? 'active' : 'inactive'
      ),
    };
    const gateway = new PostizBizzbloxConnectionProviderGateway(
      manager as never,
      {} as never,
      {} as never
    );

    const providers = await gateway.listProviders();
    expect(providers).toEqual([
      {
        providerKey: 'linkedin',
        label: 'LinkedIn',
        connectionMode: 'oauth',
        newConnectionStatus: 'active',
      },
    ]);
    expect(JSON.stringify(providers)).not.toContain(
      'linkedin-secret-never-returned'
    );
    expect(JSON.stringify(providers)).not.toContain('LINKEDIN_CLIENT_SECRET');
  });

  it('uses the fixed callback, stores credentials in the exact organization, and hides page secrets', async () => {
    const provider = {
      identifier: 'facebook',
      isBetweenSteps: true,
      oneTimeToken: false,
      generateAuthUrl: vi.fn().mockResolvedValue({
        url: 'https://facebook.com/oauth',
        codeVerifier: 'verifier-1',
        state: 'provider-state-1',
      }),
      authenticate: vi.fn().mockResolvedValue({
        id: 'facebook-user-1',
        name: 'Nathan',
        accessToken: 'user-access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3_600,
        picture: 'https://cdn.facebook.com/user.png',
        username: 'nathan',
      }),
      pages: vi.fn().mockResolvedValue([
        {
          id: 'remote-page-123',
          name: 'BizzBLOX Company',
          access_token: 'page-access-token',
          picture: { data: { url: 'https://cdn.facebook.com/page.png' } },
        },
      ]),
    };
    const manager = {
      getAllowedSocialsIntegrations: vi.fn().mockReturnValue(['facebook']),
      getSocialIntegration: vi.fn().mockReturnValue(provider),
      isHiddenProvider: vi.fn().mockReturnValue(false),
    };
    const integrations = {
      createOrUpdateIntegration: vi.fn().mockResolvedValue({
        id: 'integration-facebook-1',
      }),
      saveProviderPage: vi.fn(),
    };
    const refresh = {
      startRefreshWorkflow: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new PostizBizzbloxConnectionProviderGateway(
      manager as never,
      integrations as never,
      refresh as never
    );
    const callbackUrl =
      'https://social.bizzblox.com/oauth/bizzblox/callback/facebook';

    await expect(
      gateway.beginAuthorization('facebook', callbackUrl)
    ).resolves.toEqual({
      authorizationUrl: 'https://facebook.com/oauth',
      codeVerifier: 'verifier-1',
      providerState: 'provider-state-1',
    });
    expect(provider.generateAuthUrl).toHaveBeenCalledWith(
      undefined,
      callbackUrl
    );

    const result = await gateway.completeAuthorization({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'facebook',
      code: 'authorization-code-1',
      codeVerifier: 'verifier-1',
      callbackUrl,
    });

    expect(provider.authenticate).toHaveBeenCalledWith({
      code: 'authorization-code-1',
      codeVerifier: 'verifier-1',
      callbackUrl,
    });
    expect(integrations.createOrUpdateIntegration).toHaveBeenCalledWith(
      undefined,
      false,
      'postiz-org-1',
      'Nathan',
      'https://cdn.facebook.com/user.png',
      'social',
      'facebook-user-1',
      'facebook',
      'user-access-token',
      'refresh-token',
      3_600,
      'nathan',
      true,
      undefined,
      undefined,
      undefined
    );
    expect(result).toEqual({
      integrationId: 'integration-facebook-1',
      selections: [
        {
          optionRef: 'remote-page-123',
          label: 'BizzBLOX Company',
          picture: 'https://cdn.facebook.com/page.png',
          selector: {
            id: 'remote-page-123',
            name: 'BizzBLOX Company',
            picture: {
              data: { url: 'https://cdn.facebook.com/page.png' },
            },
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('page-access-token');
    expect(JSON.stringify(result)).not.toContain('user-access-token');
    expect(refresh.startRefreshWorkflow).toHaveBeenCalledWith(
      'postiz-org-1',
      'integration-facebook-1',
      provider
    );
  });

  it('uses provider-owned custom fields without returning submitted credentials', async () => {
    const provider = {
      identifier: 'bluesky',
      isBetweenSteps: false,
      customFields: vi.fn().mockResolvedValue([
        {
          key: 'identifier',
          label: 'Identifier',
          type: 'text',
          validation: '/^.+$/',
        },
        {
          key: 'password',
          label: 'App password',
          type: 'password',
          validation: '/^.{3,}$/',
          hint: 'Create this in Bluesky settings.',
        },
      ]),
      authenticate: vi.fn().mockResolvedValue({
        id: 'did:plc:bizzblox',
        name: 'BizzBLOX',
        accessToken: 'bluesky-access-token',
        refreshToken: 'bluesky-refresh-token',
        expiresIn: 3_600,
        picture: '',
        username: 'bizzblox.bsky.social',
      }),
    };
    const manager = {
      getAllowedSocialsIntegrations: vi.fn().mockReturnValue(['bluesky']),
      getSocialIntegration: vi.fn().mockReturnValue(provider),
      isHiddenProvider: vi.fn().mockReturnValue(false),
    };
    const integrations = {
      createOrUpdateIntegration: vi.fn().mockResolvedValue({
        id: 'integration-bluesky-1',
      }),
      saveProviderPage: vi.fn(),
    };
    const refresh = {
      startRefreshWorkflow: vi.fn().mockResolvedValue(undefined),
    };
    const fieldSealer = {
      seal: vi.fn().mockReturnValue('sealed-custom-fields'),
    };
    const gateway = new PostizBizzbloxConnectionProviderGateway(
      manager as never,
      integrations as never,
      refresh as never,
      fieldSealer
    );
    const fields = {
      identifier: 'bizzblox.bsky.social',
      password: 'app-password-secret',
    };

    await expect(gateway.describe('bluesky')).resolves.toEqual({
      mode: 'form',
      fields: [
        {
          fieldRef: 'identifier',
          label: 'Identifier',
          type: 'text',
        },
        {
          fieldRef: 'password',
          label: 'App password',
          type: 'password',
          hint: 'Create this in Bluesky settings.',
        },
      ],
    });
    const result = await gateway.completeCustomFields({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'bluesky',
      fields,
    });

    expect(provider.authenticate).toHaveBeenCalledWith({
      code: Buffer.from(JSON.stringify(fields)).toString('base64'),
      codeVerifier: 'none',
    });
    expect(fieldSealer.seal).toHaveBeenCalledWith(fields);
    const write = integrations.createOrUpdateIntegration.mock.calls[0]!;
    expect(write[2]).toBe('postiz-org-1');
    expect(write[7]).toBe('bluesky');
    expect(write[8]).toBe('bluesky-access-token');
    expect(write[15]).toBe('sealed-custom-fields');
    expect(result).toEqual({
      integrationId: 'integration-bluesky-1',
      selections: [],
    });
    expect(JSON.stringify(result)).not.toContain('app-password-secret');
    expect(JSON.stringify(result)).not.toContain('bluesky-access-token');
  });

  it('completes provider-owned manual connection codes inside the exact tenant', async () => {
    const provider = {
      identifier: 'telegram',
      isBetweenSteps: false,
      isWeb3: true,
      authenticate: vi.fn().mockResolvedValue({
        id: 'bizzblox_updates',
        name: 'BizzBLOX Updates',
        accessToken: '-1001234567890',
        refreshToken: '',
        expiresIn: 3_600,
        picture: '',
        username: 'bizzblox_updates',
      }),
    };
    const manager = {
      getAllowedSocialsIntegrations: vi.fn().mockReturnValue(['telegram']),
      getSocialIntegration: vi.fn().mockReturnValue(provider),
      isHiddenProvider: vi.fn().mockReturnValue(false),
    };
    const integrations = {
      createOrUpdateIntegration: vi.fn().mockResolvedValue({
        id: 'integration-telegram-1',
      }),
      saveProviderPage: vi.fn(),
    };
    const refresh = {
      startRefreshWorkflow: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new PostizBizzbloxConnectionProviderGateway(
      manager as never,
      integrations as never,
      refresh as never
    );

    const result = await gateway.completeManual({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'telegram',
      code: '-1001234567890',
    });

    expect(provider.authenticate).toHaveBeenCalledWith({
      code: '-1001234567890',
      codeVerifier: 'none',
    });
    expect(result).toEqual({
      integrationId: 'integration-telegram-1',
      selections: [],
    });
    expect(JSON.stringify(result)).not.toContain('-1001234567890');
  });
});
