import { describe, expect, it, vi } from 'vitest';

import { PostActivity } from './post.activity';
import { IntegrationsActivity } from './integrations.activity';
import { TemporalDiscoveryService } from 'nestjs-temporal-core';

describe('Post activity provider credential boundary', () => {
  it('discovers the legacy refresh handler with its propagation delay and credential-free result', async () => {
    vi.useFakeTimers();
    try {
      const unused = {} as never;
      const refresh = vi.fn().mockResolvedValue({
        id: 'account',
        name: 'Account',
        username: '',
        accessToken: 'secret-access',
        refreshToken: 'secret-refresh',
        expiresIn: 3600,
      });
      const owner = { refresh } as never;
      const post = new PostActivity(
        unused,
        unused,
        { getSocialIntegration: () => ({ refreshWait: true }) } as never,
        unused,
        owner,
        unused,
        unused,
        unused
      );
      const integrations = new IntegrationsActivity(unused, owner);
      const discovery = new TemporalDiscoveryService(
        {
          getProviders: () => [
            { instance: post, metatype: PostActivity },
            { instance: integrations, metatype: IntegrationsActivity },
          ],
          getControllers: () => [],
        } as never,
        undefined,
        { enableLogger: false } as never
      );
      await discovery.onModuleInit();
      const handler = discovery.getActivity('refreshToken');
      expect(handler).toBeTypeOf('function');
      let completed = false;
      const result = handler!({
        id: 'integration',
        organizationId: 'org',
        providerIdentifier: 'linkedin',
      }).then((value) => {
        completed = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        accessToken: 'managed-in-activity',
        refreshToken: '',
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no credential to the workflow and decrypts only for provider execution', async () => {
    const stored = {
      id: 'integration_current',
      organizationId: 'organization_123',
      providerIdentifier: 'linkedin',
      refreshToken: 'sealed-refresh-envelope',
      token: 'sealed-access-envelope',
    };
    const opened = {
      ...stored,
      refreshToken: 'refresh-secret',
      token: 'access-secret',
    };
    const checkPostStatus = vi.fn().mockResolvedValue({ state: 'published' });
    const integrationService = {
      getIntegrationById: vi.fn().mockResolvedValue(stored),
      getIntegrationForProviderExecution: vi.fn().mockResolvedValue(opened),
    };
    const integrationManager = {
      getSocialIntegration: vi.fn().mockReturnValue({ checkPostStatus }),
    };
    const unused = {} as never;
    const activity = new PostActivity(
      unused,
      unused,
      integrationManager as never,
      integrationService as never,
      unused,
      unused,
      unused,
      unused
    );

    const workflowIntegration = await activity.getIntegrationById(
      'organization_123',
      'integration_current'
    );
    expect(workflowIntegration).toMatchObject({
      token: '',
      refreshToken: null,
    });
    expect(JSON.stringify(workflowIntegration)).not.toContain(
      'sealed-access-envelope'
    );

    await expect(
      activity.checkPostStatus(workflowIntegration as never, {
        providerReference: 'opaque',
      })
    ).resolves.toEqual({ state: 'published' });
    expect(checkPostStatus).toHaveBeenCalledWith(
      'access-secret',
      { providerReference: 'opaque' },
      opened
    );
  });
});
