import { describe, expect, it, vi } from 'vitest';

import { PostizBizzbloxConnectionProviderGateway } from './bizzblox-connection-provider.gateway';

describe('Postiz BizzBLOX connection provider gateway', () => {
  it('removes only the exact organization integration and proves it is gone', async () => {
    const integration = {
      id: 'integration-linkedin-1',
      organizationId: 'postiz-org-1',
    };
    const integrations = {
      deleteChannel: vi.fn().mockResolvedValue(undefined),
      getIntegrationById: vi
        .fn()
        .mockResolvedValueOnce(integration)
        .mockResolvedValueOnce(null),
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
  });

  it('projects the live configured provider catalogue without provider secrets or implementation fields', async () => {
    const manager = {
      getAllIntegrations: vi.fn().mockResolvedValue({
        social: [
          {
            identifier: 'linkedin',
            name: 'LinkedIn',
            toolTip: 'Professional network',
            editor: 'normal',
            isExternal: false,
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
    };
    const gateway = new PostizBizzbloxConnectionProviderGateway(
      manager as never,
      {} as never,
      {} as never
    );

    await expect(gateway.listProviders()).resolves.toEqual([
      { providerKey: 'bluesky', label: 'Bluesky', connectionMode: 'form' },
      { providerKey: 'linkedin', label: 'LinkedIn', connectionMode: 'oauth' },
    ]);
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
