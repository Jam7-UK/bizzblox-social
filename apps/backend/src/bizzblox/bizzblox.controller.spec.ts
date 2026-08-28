import { describe, expect, it, vi } from 'vitest';

import type { BizzbloxVerifiedRequest } from './bizzblox-auth.guard';
import { BizzbloxController } from './bizzblox.controller';

describe('BizzBLOX tenant controller', () => {
  it('cleans the claim-bound synthetic tenant using only the guarded organization', async () => {
    const cleanupSyntheticTenant = vi.fn().mockResolvedValue({
      cleanupConfirmed: true,
      tenantHandle: 'tenant_synthetic_release_123',
    });
    const controller = new BizzbloxController({
      cleanupSyntheticTenant,
    } as never);
    const request = {
      bizzbloxAuth: {
        connectorRevision: 7,
        credentialVersion: 1,
        operation: 'tenant.cleanup',
        organizationId: 'postiz-org-synthetic-1',
        tenantHandle: 'tenant_synthetic_release_123',
      },
    } as BizzbloxVerifiedRequest;

    await expect(
      controller.cleanupSyntheticTenant(request, 'tenant_synthetic_release_123')
    ).resolves.toEqual({
      cleanupConfirmed: true,
      tenantHandle: 'tenant_synthetic_release_123',
    });
    expect(cleanupSyntheticTenant).toHaveBeenCalledWith(
      'tenant_synthetic_release_123',
      'postiz-org-synthetic-1'
    );
  });
});
