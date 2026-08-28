import { describe, expect, it, vi } from 'vitest';

import type { BizzbloxVerifiedRequest } from './bizzblox-auth.guard';
import { BizzbloxConnectionsController } from './bizzblox-connections.controller';

describe('BizzBLOX internal connection controller', () => {
  it('pins begin and select to the organization and revision from the guard', async () => {
    const contracts = {
      listChannels: vi.fn(),
      readContract: vi.fn(),
      executeHelper: vi.fn(),
    };
    const connections = {
      listProviders: vi
        .fn()
        .mockResolvedValue([
          {
            providerKey: 'linkedin',
            label: 'LinkedIn',
            connectionMode: 'oauth',
          },
        ]),
      begin: vi.fn().mockResolvedValue({
        mode: 'redirect',
        authorizationUrl: 'https://linkedin.com/oauth',
      }),
      select: vi.fn().mockResolvedValue({ outcome: 'connected' }),
    };
    const controller = new BizzbloxConnectionsController(
      contracts as never,
      connections as never
    );
    const beginRequest = {
      bizzbloxAuth: {
        connectorRevision: 7,
        credentialVersion: 3,
        operation: 'connection.begin',
        organizationId: 'postiz-org-1',
        tenantHandle: 'tenant_opaque_123',
      },
    } as BizzbloxVerifiedRequest;
    const providerRequest = {
      ...beginRequest,
      bizzbloxAuth: {
        ...beginRequest.bizzbloxAuth!,
        operation: 'provider.list',
      },
    } as BizzbloxVerifiedRequest;
    const selectRequest = {
      ...beginRequest,
      bizzbloxAuth: {
        ...beginRequest.bizzbloxAuth!,
        operation: 'connection.select',
      },
    } as BizzbloxVerifiedRequest;

    await expect(controller.providers(providerRequest)).resolves.toEqual([
      { providerKey: 'linkedin', label: 'LinkedIn', connectionMode: 'oauth' },
    ]);
    await controller.begin(beginRequest, { provider: 'linkedin' });
    await controller.select(selectRequest, {
      attemptHandle: 'selection-attempt-1',
      optionRef: 'selection-option-1',
    });

    expect(connections.begin).toHaveBeenCalledWith('postiz-org-1', 7, {
      provider: 'linkedin',
    });
    expect(connections.listProviders).toHaveBeenCalledOnce();
    expect(connections.select).toHaveBeenCalledWith('postiz-org-1', 7, {
      attemptHandle: 'selection-attempt-1',
      optionRef: 'selection-option-1',
    });
  });
});
