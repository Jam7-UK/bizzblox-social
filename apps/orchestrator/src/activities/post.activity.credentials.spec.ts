import { describe, expect, it, vi } from 'vitest';

import { PostActivity } from './post.activity';

describe('Post activity provider credential boundary', () => {
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
