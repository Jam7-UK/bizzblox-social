import { describe, expect, it, vi } from 'vitest';

import { IntegrationService } from './integration.service';

describe('provider execution credential boundary', () => {
  it('keeps ordinary reads sealed and opens credentials only through the execution method', async () => {
    const stored = {
      id: 'integration_current',
      organizationId: 'organization_123',
      refreshToken: 'sealed-refresh',
      token: 'sealed-access',
    };
    const opened = {
      ...stored,
      refreshToken: 'refresh-secret',
      token: 'access-secret',
    };
    const repository = {
      getIntegrationById: vi.fn().mockResolvedValue(stored),
      openForProviderExecution: vi.fn().mockResolvedValue(opened),
    };
    const unused = {} as never;
    const service = new IntegrationService(
      repository as never,
      unused,
      unused,
      unused,
      unused,
      unused
    );

    await expect(
      service.getIntegrationById('organization_123', 'integration_current')
    ).resolves.toBe(stored);
    expect(repository.openForProviderExecution).not.toHaveBeenCalled();

    await expect(
      service.getIntegrationForProviderExecution(
        'organization_123',
        'integration_current'
      )
    ).resolves.toBe(opened);
    expect(repository.openForProviderExecution).toHaveBeenCalledWith(stored);
  });
});
