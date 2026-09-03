import { describe, expect, it, vi } from 'vitest';

import {
  BizzbloxConnectionsService,
  type BizzbloxConnectionProviderGateway,
  type BizzbloxConnectionStateStore,
} from './bizzblox-connections.service';
import type { BizzbloxChannelDirectory } from './bizzblox-contract.service';

const AMP_RETURN_URLS = {
  dev: 'https://mvp.bizzblox.com/settings/social',
  preprod: 'https://preprod.jam7.com/settings/social',
  prod: 'https://amp.jam7.com/settings/social',
} as const;

describe('BizzBLOX managed social consent', () => {
  it('reconnects a form provider through the same exact channel claim, not generic consent', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn().mockResolvedValue({
        integrationId: 'integration-linkedin-1',
        selections: [],
      }),
      selectAccount: vi.fn(),
      describe: vi.fn().mockResolvedValue({
        mode: 'form',
        fields: [{ fieldRef: 'token', label: 'Token', type: 'password' }],
      }),
      resolveReconnectProvider: vi.fn().mockResolvedValue('linkedin'),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn(),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
    };
    const channel = {
      organizationId: 'postiz-org-1',
      channelHandle: 'bbx_ch_exact_linkedin',
      connectorRevision: 7,
      contractDigest: 'sha256:current',
      integrationId: 'integration-linkedin-1',
      status: 'disconnected' as const,
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-08-27T22:03:00.000Z'),
        createOpaqueHandle: () =>
          'outcome_opaque_reconnect_abcdefghijklmnopqrstuvwxyz',
        publicOrigin: 'https://social.bizzblox.com',
      },
      {
        synchronize: vi.fn(),
        read: vi.fn().mockResolvedValue(channel),
        updateContract: vi.fn(),
        markDisconnected: vi.fn(),
      }
    );

    await expect(
      service.reconnect('postiz-org-1', 7, 'dev', {
        channelHandle: channel.channelHandle,
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
        fields: { token: 'replacement-token' },
      })
    ).resolves.toEqual({
      mode: 'connected',
      channelHandle: 'bbx_ch_exact_linkedin',
      connectorRevision: 7,
    });
    expect(providers.completeCustomFields).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'linkedin',
      fields: { token: 'replacement-token' },
      reconnectIntegrationId: 'integration-linkedin-1',
    });
    expect(providers.beginAuthorization).not.toHaveBeenCalled();
  });

  it('starts reconnect consent only for the exact opaque channel and revision', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn(),
      describe: vi.fn().mockResolvedValue({ mode: 'oauth' }),
      resolveReconnectProvider: vi.fn().mockResolvedValue('linkedin'),
      beginAuthorization: vi.fn().mockResolvedValue({
        authorizationUrl: 'https://linkedin.example/oauth',
        providerState: 'provider-state-reconnect',
        codeVerifier: 'pkce-reconnect',
      }),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn(),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
    };
    const channel = {
      organizationId: 'postiz-org-1',
      channelHandle: 'bbx_ch_exact_linkedin',
      connectorRevision: 7,
      contractDigest: 'sha256:current',
      integrationId: 'integration-linkedin-1',
      status: 'disconnected' as const,
    };
    const channels: BizzbloxChannelDirectory = {
      synchronize: vi.fn(),
      read: vi.fn().mockResolvedValue(channel),
      updateContract: vi.fn(),
      markDisconnected: vi.fn(),
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-08-27T22:03:00.000Z'),
        publicOrigin: 'https://social.bizzblox.com',
      },
      channels
    );

    await expect(
      service.reconnect('postiz-org-1', 7, 'dev', {
        channelHandle: channel.channelHandle,
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
      })
    ).resolves.toMatchObject({
      mode: 'redirect',
      authorizationUrl: 'https://linkedin.example/oauth',
    });
    expect(providers.resolveReconnectProvider).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      integrationId: 'integration-linkedin-1',
    });
    expect(providers.beginAuthorization).toHaveBeenCalledWith(
      'linkedin',
      'https://social.bizzblox.com/oauth/bizzblox/callback/linkedin'
    );
  });

  it('disconnects one opaque channel only through its exact tenant and revision', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn(),
      disconnectAccount: vi.fn().mockResolvedValue({ outcome: 'removed' }),
      describe: vi.fn(),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn(),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
    };
    const channel = {
      organizationId: 'postiz-org-1',
      channelHandle: 'bbx_ch_exact_linkedin',
      connectorRevision: 7,
      contractDigest: 'sha256:current',
      integrationId: 'integration-linkedin-1',
      status: 'active' as const,
    };
    const channels: BizzbloxChannelDirectory = {
      synchronize: vi.fn(),
      read: vi.fn().mockResolvedValue(channel),
      updateContract: vi.fn(),
      markDisconnected: vi.fn().mockResolvedValue({
        ...channel,
        status: 'disconnected',
      }),
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-08-27T22:03:00.000Z'),
        publicOrigin: 'https://social.bizzblox.com',
      },
      channels
    );

    const result = await service.disconnect('postiz-org-1', 7, {
      channelHandle: 'bbx_ch_exact_linkedin',
    });

    expect(result).toEqual({ outcome: 'removed' });
    expect(providers.disconnectAccount).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      integrationId: 'integration-linkedin-1',
    });
    expect(channels.markDisconnected).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      channelHandle: 'bbx_ch_exact_linkedin',
      connectorRevision: 7,
    });
    expect(JSON.stringify(result)).not.toContain('postiz-org-1');
    expect(JSON.stringify(result)).not.toContain('integration-linkedin-1');
  });

  it('begins provider consent with a fixed branded callback and stores exact-tenant state', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn().mockResolvedValue({
        authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
        providerState: 'provider-state-1',
        codeVerifier: 'pkce-verifier-1',
      }),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn(),
      describe: vi.fn().mockResolvedValue({ mode: 'oauth' }),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn().mockResolvedValue(undefined),
      consumeAuthorization: vi.fn(),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
    };
    const service = new BizzbloxConnectionsService(providers, states, {
      ampReturnUrls: AMP_RETURN_URLS,
      clock: () => new Date('2026-08-27T22:00:00.000Z'),
      createOpaqueHandle: () =>
        'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
      publicOrigin: 'https://social.bizzblox.com',
    });

    const result = await service.begin('postiz-org-1', 7, 'dev', {
      provider: 'linkedin',
      userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
    });

    expect(result).toEqual({
      mode: 'redirect',
      authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
      expiresAt: Date.parse('2026-08-27T22:10:00.000Z'),
    });
    expect(providers.beginAuthorization).toHaveBeenCalledWith(
      'linkedin',
      'https://social.bizzblox.com/oauth/bizzblox/callback/linkedin'
    );
    expect(states.saveAuthorization).toHaveBeenCalledWith('provider-state-1', {
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      environment: 'dev',
      provider: 'linkedin',
      codeVerifier: 'pkce-verifier-1',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
      expiresAt: Date.parse('2026-08-27T22:10:00.000Z'),
      userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
      outcomeHandle: 'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(JSON.stringify(result)).not.toContain('provider-state-1');
    expect(JSON.stringify(result)).not.toContain('postiz-org-1');
    expect(JSON.stringify(result)).not.toContain('pkce-verifier-1');
  });

  it('consumes callback state once and never exposes the service integration identity', async () => {
    const authorizationState = {
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      environment: 'dev' as const,
      provider: 'linkedin',
      codeVerifier: 'pkce-verifier-1',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
      expiresAt: Date.parse('2026-08-27T22:10:00.000Z'),
      userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
      outcomeHandle: 'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
    };
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      completeAuthorization: vi.fn().mockResolvedValue({
        integrationId: 'integration-linkedin-1',
        selections: [],
      }),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn(),
      describe: vi.fn(),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi
        .fn()
        .mockResolvedValueOnce(authorizationState)
        .mockResolvedValueOnce(null),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
      saveOutcome: vi.fn(),
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-08-27T22:02:00.000Z'),
        publicOrigin: 'https://social.bizzblox.com',
      },
      undefined,
      {
        channel: vi.fn().mockReturnValue('bbx_ch_exact_linkedin'),
        helper: vi.fn(),
      }
    );

    const connected = await service.completeCallback({
      provider: 'linkedin',
      query: { state: 'provider-state-1', code: 'authorization-code-1' },
    });
    const replay = await service.completeCallback({
      provider: 'linkedin',
      query: { state: 'provider-state-1', code: 'authorization-code-1' },
    });

    expect(connected).toEqual({
      outcome: 'ready',
      redirectUrl:
        'https://mvp.bizzblox.com/settings/social?outcome=outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(replay).toEqual({
      outcome: 'failed',
      redirectUrl: 'https://mvp.bizzblox.com/settings/social?social=failed',
    });
    expect(providers.completeAuthorization).toHaveBeenCalledOnce();
    expect(states.saveOutcome).toHaveBeenCalledWith(
      'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
      expect.objectContaining({
        organizationId: 'postiz-org-1',
        connectorRevision: 7,
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
        result: {
          outcome: 'connected',
          channelHandle: 'bbx_ch_exact_linkedin',
          connectorRevision: 7,
        },
      })
    );
    expect(providers.completeAuthorization).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'linkedin',
      code: 'authorization-code-1',
      codeVerifier: 'pkce-verifier-1',
      callbackUrl:
        'https://social.bizzblox.com/oauth/bizzblox/callback/linkedin',
    });
    expect(JSON.stringify(connected)).not.toContain('postiz-org-1');
    expect(JSON.stringify(connected)).not.toContain('integration-linkedin-1');
  });

  it('reads OAuth 1.0a callbacks through the provider mapping and records a failed outcome for a state-only return', async () => {
    const authorizationState = {
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      environment: 'dev' as const,
      provider: 'x',
      codeVerifier: 'request-token-1:request-secret-1',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
      expiresAt: Date.parse('2026-09-03T11:10:00.000Z'),
      userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
      outcomeHandle: 'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
    };
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      readCallback: vi.fn((_provider, query: Record<string, string>) => ({
        providerState: query.oauth_token ?? query.denied ?? '',
        code: query.oauth_verifier ?? '',
      })),
      completeAuthorization: vi.fn().mockResolvedValue({
        integrationId: 'integration-x-1',
        selections: [],
      }),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn(),
      describe: vi.fn(),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn().mockResolvedValue(authorizationState),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
      saveOutcome: vi.fn(),
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-09-03T11:00:00.000Z'),
        publicOrigin: 'https://social.bizzblox.com',
      },
      undefined,
      { channel: vi.fn().mockReturnValue('bbx_ch_exact_x'), helper: vi.fn() }
    );

    const connected = await service.completeCallback({
      provider: 'x',
      query: { oauth_token: 'request-token-1', oauth_verifier: 'verifier-1' },
    });

    expect(connected).toEqual({
      outcome: 'ready',
      redirectUrl:
        'https://mvp.bizzblox.com/settings/social?outcome=outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(states.consumeAuthorization).toHaveBeenCalledWith('request-token-1');
    expect(providers.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'x',
        code: 'verifier-1',
        codeVerifier: 'request-token-1:request-secret-1',
      })
    );

    // The user cancelled on X: the state comes back as `denied`, no verifier.
    const denied = await service.completeCallback({
      provider: 'x',
      query: { denied: 'request-token-1' },
    });

    expect(denied).toEqual({
      outcome: 'ready',
      redirectUrl:
        'https://mvp.bizzblox.com/settings/social?outcome=outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(providers.completeAuthorization).toHaveBeenCalledOnce();
    expect(states.saveOutcome).toHaveBeenLastCalledWith(
      'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
      expect.objectContaining({
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
        result: { outcome: 'failed' },
      })
    );
  });

  it('records a failed outcome when an OAuth 2.0 provider returns an error with its state', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn(),
      describe: vi.fn(),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn().mockResolvedValue({
        organizationId: 'postiz-org-1',
        connectorRevision: 7,
        environment: 'dev' as const,
        provider: 'linkedin',
        codeVerifier: 'pkce-verifier-1',
        ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
        expiresAt: Date.parse('2026-09-03T11:10:00.000Z'),
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
        outcomeHandle: 'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
      }),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
      saveOutcome: vi.fn(),
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-09-03T11:00:00.000Z'),
        publicOrigin: 'https://social.bizzblox.com',
      },
      undefined,
      { channel: vi.fn(), helper: vi.fn() }
    );

    const result = await service.completeCallback({
      provider: 'linkedin',
      query: {
        state: 'provider-state-1',
        error: 'unauthorized_scope_error',
        error_description: 'Scope not authorized',
      },
    });

    expect(result).toEqual({
      outcome: 'ready',
      redirectUrl:
        'https://mvp.bizzblox.com/settings/social?outcome=outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(providers.completeAuthorization).not.toHaveBeenCalled();
    expect(states.saveOutcome).toHaveBeenCalledWith(
      'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
      expect.objectContaining({ result: { outcome: 'failed' } })
    );
    expect(JSON.stringify(result)).not.toContain('Scope not authorized');
  });

  it('turns provider page choices into short-lived opaque AMP selections', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      completeAuthorization: vi.fn().mockResolvedValue({
        integrationId: 'integration-linkedin-1',
        selections: [
          {
            optionRef: 'provider-page-1',
            label: 'BizzBLOX Company',
            picture: 'https://cdn.linkedin.com/company.png',
            selector: { pageId: 'remote-page-123' },
          },
        ],
      }),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn(),
      describe: vi.fn(),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn().mockResolvedValue({
        organizationId: 'postiz-org-1',
        connectorRevision: 7,
        environment: 'dev',
        provider: 'linkedin',
        codeVerifier: 'pkce-verifier-1',
        ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
        expiresAt: Date.parse('2026-08-27T22:10:00.000Z'),
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
        outcomeHandle: 'outcome_opaque_selection_abcdefghijklmnopqrstuvwxyz',
      }),
      saveSelection: vi.fn().mockResolvedValue(undefined),
      consumeSelection: vi.fn(),
      saveOutcome: vi.fn(),
    };
    const createOpaqueHandle = vi
      .fn()
      .mockReturnValueOnce('selection-attempt-1')
      .mockReturnValueOnce('selection-option-1');
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-08-27T22:02:00.000Z'),
        createOpaqueHandle,
        publicOrigin: 'https://social.bizzblox.com',
      },
      undefined,
      {
        channel: vi.fn().mockReturnValue('bbx_ch_exact_linkedin'),
        helper: vi.fn(),
      }
    );

    const result = await service.completeCallback({
      provider: 'linkedin',
      query: { state: 'provider-state-1', code: 'authorization-code-1' },
    });

    expect(result).toEqual({
      outcome: 'ready',
      redirectUrl:
        'https://mvp.bizzblox.com/settings/social?outcome=outcome_opaque_selection_abcdefghijklmnopqrstuvwxyz',
    });
    expect(states.saveSelection).toHaveBeenCalledWith('selection-attempt-1', {
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      environment: 'dev',
      provider: 'linkedin',
      integrationId: 'integration-linkedin-1',
      userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
      expiresAt: Date.parse('2026-08-27T22:07:00.000Z'),
      options: [
        {
          optionRef: 'selection-option-1',
          label: 'BizzBLOX Company',
          picture: 'https://cdn.linkedin.com/company.png',
          selector: { pageId: 'remote-page-123' },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('postiz-org-1');
    expect(JSON.stringify(result)).not.toContain('integration-linkedin-1');
    expect(JSON.stringify(result)).not.toContain('remote-page-123');
    expect(JSON.stringify(result)).not.toContain('provider-page-1');
  });

  it('selects one server-held page only for the exact tenant and revision', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn().mockResolvedValue(undefined),
      describe: vi.fn(),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn(),
      saveSelection: vi.fn(),
      consumeSelection: vi
        .fn()
        .mockResolvedValueOnce({
          organizationId: 'postiz-org-1',
          connectorRevision: 7,
          environment: 'dev',
          provider: 'linkedin',
          integrationId: 'integration-linkedin-1',
          userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
          ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
          expiresAt: Date.parse('2026-08-27T22:07:00.000Z'),
          options: [
            {
              optionRef: 'selection-option-1',
              label: 'BizzBLOX Company',
              picture: null,
              selector: { pageId: 'remote-page-123' },
            },
          ],
        })
        .mockResolvedValueOnce(null),
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-08-27T22:03:00.000Z'),
        publicOrigin: 'https://social.bizzblox.com',
      },
      undefined,
      {
        channel: vi.fn().mockReturnValue('bbx_ch_exact_linkedin'),
        helper: vi.fn(),
      }
    );

    const connected = await service.select('postiz-org-1', 7, 'dev', {
      attemptHandle: 'selection-attempt-1',
      optionRef: 'selection-option-1',
      userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
    });
    const replay = await service.select('postiz-org-1', 7, 'dev', {
      attemptHandle: 'selection-attempt-1',
      optionRef: 'selection-option-1',
      userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
    });

    expect(connected).toEqual({
      outcome: 'connected',
      channelHandle: 'bbx_ch_exact_linkedin',
      connectorRevision: 7,
    });
    expect(replay).toEqual({ outcome: 'failed' });
    expect(providers.selectAccount).toHaveBeenCalledOnce();
    expect(providers.selectAccount).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'linkedin',
      integrationId: 'integration-linkedin-1',
      selector: { pageId: 'remote-page-123' },
    });
    expect(JSON.stringify(connected)).not.toContain('postiz-org-1');
    expect(JSON.stringify(connected)).not.toContain('integration-linkedin-1');
    expect(JSON.stringify(connected)).not.toContain('remote-page-123');
  });

  it('returns live provider fields and completes them without exposing credentials', async () => {
    const fields = [
      {
        fieldRef: 'identifier',
        label: 'Identifier',
        type: 'text' as const,
      },
      {
        fieldRef: 'password',
        label: 'App password',
        type: 'password' as const,
      },
    ];
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn().mockResolvedValue({
        integrationId: 'integration-bluesky-1',
        selections: [],
      }),
      selectAccount: vi.fn(),
      describe: vi.fn().mockResolvedValue({ mode: 'form', fields }),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn(),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-08-27T22:03:00.000Z'),
        publicOrigin: 'https://social.bizzblox.com',
      },
      undefined,
      {
        channel: vi.fn().mockReturnValue('bbx_ch_exact_bluesky'),
        helper: vi.fn(),
      }
    );

    await expect(
      service.begin('postiz-org-1', 7, 'dev', { provider: 'bluesky' })
    ).resolves.toEqual({ mode: 'form', fields });
    const connected = await service.begin('postiz-org-1', 7, 'dev', {
      provider: 'bluesky',
      fields: {
        identifier: 'bizzblox.bsky.social',
        password: 'app-password-secret',
      },
    });

    expect(providers.completeCustomFields).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'bluesky',
      fields: {
        identifier: 'bizzblox.bsky.social',
        password: 'app-password-secret',
      },
    });
    expect(connected).toEqual({
      mode: 'connected',
      channelHandle: 'bbx_ch_exact_bluesky',
      connectorRevision: 7,
    });
    expect(JSON.stringify(connected)).not.toContain('app-password-secret');
    expect(JSON.stringify(connected)).not.toContain('integration-bluesky-1');
  });

  it('keeps provider-specific manual authorization behind the same AMP flow', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn(),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn(),
      completeManual: vi.fn().mockResolvedValue({
        integrationId: 'integration-telegram-1',
        selections: [],
      }),
      selectAccount: vi.fn(),
      describe: vi.fn().mockResolvedValue({
        mode: 'manual',
        instructions: 'Complete the provider connection steps in AMP.',
      }),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn(),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
    };
    const service = new BizzbloxConnectionsService(
      providers,
      states,
      {
        ampReturnUrls: AMP_RETURN_URLS,
        clock: () => new Date('2026-08-27T22:03:00.000Z'),
        publicOrigin: 'https://social.bizzblox.com',
      },
      undefined,
      {
        channel: vi.fn().mockReturnValue('bbx_ch_exact_telegram'),
        helper: vi.fn(),
      }
    );

    await expect(
      service.begin('postiz-org-1', 7, 'dev', { provider: 'telegram' })
    ).resolves.toEqual({
      mode: 'manual',
      instructions: 'Complete the provider connection steps in AMP.',
    });
    const connected = await service.begin('postiz-org-1', 7, 'dev', {
      provider: 'telegram',
      manualCode: '-1001234567890',
    });

    expect(providers.completeManual).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'telegram',
      code: '-1001234567890',
    });
    expect(connected).toEqual({
      mode: 'connected',
      channelHandle: 'bbx_ch_exact_telegram',
      connectorRevision: 7,
    });
    expect(JSON.stringify(connected)).not.toContain('-1001234567890');
    expect(JSON.stringify(connected)).not.toContain('integration-telegram-1');
  });

  it('binds OAuth state to the verified environment return origin', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
      listProviders: vi.fn(),
      beginAuthorization: vi.fn().mockResolvedValue({
        authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
        providerState: 'provider-state-preprod',
        codeVerifier: 'pkce-verifier-preprod',
      }),
      completeAuthorization: vi.fn(),
      completeCustomFields: vi.fn(),
      selectAccount: vi.fn(),
      describe: vi.fn().mockResolvedValue({ mode: 'oauth' }),
    };
    const states: BizzbloxConnectionStateStore = {
      saveAuthorization: vi.fn(),
      consumeAuthorization: vi.fn(),
      saveSelection: vi.fn(),
      consumeSelection: vi.fn(),
    };
    const service = new BizzbloxConnectionsService(providers, states, {
      ampReturnUrls: AMP_RETURN_URLS,
      clock: () => new Date('2026-09-01T07:00:00.000Z'),
      createOpaqueHandle: () =>
        'outcome_preprod_opaque_abcdefghijklmnopqrstuvwxyz',
      publicOrigin: 'https://social.bizzblox.com',
    });

    await service.begin('postiz-org-preprod', 7, 'preprod', {
      provider: 'linkedin',
      userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
    });

    expect(states.saveAuthorization).toHaveBeenCalledWith(
      'provider-state-preprod',
      expect.objectContaining({
        environment: 'preprod',
        ampReturnUrl: AMP_RETURN_URLS.preprod,
      })
    );
  });
});
