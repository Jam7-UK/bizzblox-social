import { describe, expect, it, vi } from 'vitest';

import {
  BizzbloxConnectionsService,
  type BizzbloxConnectionProviderGateway,
  type BizzbloxConnectionStateStore,
} from './bizzblox-connections.service';

describe('BizzBLOX managed social consent', () => {
  it('begins provider consent with a fixed branded callback and stores exact-tenant state', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
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
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
      clock: () => new Date('2026-08-27T22:00:00.000Z'),
      publicOrigin: 'https://social.bizzblox.com',
    });

    const result = await service.begin('postiz-org-1', 7, {
      provider: 'linkedin',
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
      provider: 'linkedin',
      codeVerifier: 'pkce-verifier-1',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
      expiresAt: Date.parse('2026-08-27T22:10:00.000Z'),
    });
    expect(JSON.stringify(result)).not.toContain('provider-state-1');
    expect(JSON.stringify(result)).not.toContain('postiz-org-1');
    expect(JSON.stringify(result)).not.toContain('pkce-verifier-1');
  });

  it('consumes callback state once and never exposes the service integration identity', async () => {
    const authorizationState = {
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'linkedin',
      codeVerifier: 'pkce-verifier-1',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
      expiresAt: Date.parse('2026-08-27T22:10:00.000Z'),
    };
    const providers: BizzbloxConnectionProviderGateway = {
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
    };
    const service = new BizzbloxConnectionsService(providers, states, {
      ampReturnUrl: authorizationState.ampReturnUrl,
      clock: () => new Date('2026-08-27T22:02:00.000Z'),
      publicOrigin: 'https://social.bizzblox.com',
    });

    const connected = await service.completeCallback({
      provider: 'linkedin',
      providerState: 'provider-state-1',
      code: 'authorization-code-1',
    });
    const replay = await service.completeCallback({
      provider: 'linkedin',
      providerState: 'provider-state-1',
      code: 'authorization-code-1',
    });

    expect(connected).toEqual({
      outcome: 'connected',
      redirectUrl:
        'https://mvp.bizzblox.com/settings/integrations/social?social=connected&provider=linkedin',
    });
    expect(replay).toEqual({
      outcome: 'failed',
      redirectUrl:
        'https://mvp.bizzblox.com/settings/integrations/social?social=failed',
    });
    expect(providers.completeAuthorization).toHaveBeenCalledOnce();
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

  it('turns provider page choices into short-lived opaque AMP selections', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
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
        provider: 'linkedin',
        codeVerifier: 'pkce-verifier-1',
        ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
        expiresAt: Date.parse('2026-08-27T22:10:00.000Z'),
      }),
      saveSelection: vi.fn().mockResolvedValue(undefined),
      consumeSelection: vi.fn(),
    };
    const createOpaqueHandle = vi
      .fn()
      .mockReturnValueOnce('selection-attempt-1')
      .mockReturnValueOnce('selection-option-1');
    const service = new BizzbloxConnectionsService(providers, states, {
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
      clock: () => new Date('2026-08-27T22:02:00.000Z'),
      createOpaqueHandle,
      publicOrigin: 'https://social.bizzblox.com',
    });

    const result = await service.completeCallback({
      provider: 'linkedin',
      providerState: 'provider-state-1',
      code: 'authorization-code-1',
    });

    expect(result).toEqual({
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
    });
    expect(states.saveSelection).toHaveBeenCalledWith('selection-attempt-1', {
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'linkedin',
      integrationId: 'integration-linkedin-1',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
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
          provider: 'linkedin',
          integrationId: 'integration-linkedin-1',
          ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
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
    const service = new BizzbloxConnectionsService(providers, states, {
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
      clock: () => new Date('2026-08-27T22:03:00.000Z'),
      publicOrigin: 'https://social.bizzblox.com',
    });

    const connected = await service.select('postiz-org-1', 7, {
      attemptHandle: 'selection-attempt-1',
      optionRef: 'selection-option-1',
    });
    const replay = await service.select('postiz-org-1', 7, {
      attemptHandle: 'selection-attempt-1',
      optionRef: 'selection-option-1',
    });

    expect(connected).toEqual({
      outcome: 'connected',
      redirectUrl:
        'https://mvp.bizzblox.com/settings/integrations/social?social=connected&provider=linkedin',
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
    const service = new BizzbloxConnectionsService(providers, states, {
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
      clock: () => new Date('2026-08-27T22:03:00.000Z'),
      publicOrigin: 'https://social.bizzblox.com',
    });

    await expect(
      service.begin('postiz-org-1', 7, { provider: 'bluesky' })
    ).resolves.toEqual({ mode: 'form', fields });
    const connected = await service.begin('postiz-org-1', 7, {
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
      provider: 'bluesky',
    });
    expect(JSON.stringify(connected)).not.toContain('app-password-secret');
    expect(JSON.stringify(connected)).not.toContain('integration-bluesky-1');
  });

  it('keeps provider-specific manual authorization behind the same AMP flow', async () => {
    const providers: BizzbloxConnectionProviderGateway = {
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
    const service = new BizzbloxConnectionsService(providers, states, {
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/integrations/social',
      clock: () => new Date('2026-08-27T22:03:00.000Z'),
      publicOrigin: 'https://social.bizzblox.com',
    });

    await expect(
      service.begin('postiz-org-1', 7, { provider: 'telegram' })
    ).resolves.toEqual({
      mode: 'manual',
      instructions: 'Complete the provider connection steps in AMP.',
    });
    const connected = await service.begin('postiz-org-1', 7, {
      provider: 'telegram',
      manualCode: '-1001234567890',
    });

    expect(providers.completeManual).toHaveBeenCalledWith({
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'telegram',
      code: '-1001234567890',
    });
    expect(connected).toEqual({ mode: 'connected', provider: 'telegram' });
    expect(JSON.stringify(connected)).not.toContain('-1001234567890');
    expect(JSON.stringify(connected)).not.toContain('integration-telegram-1');
  });
});
