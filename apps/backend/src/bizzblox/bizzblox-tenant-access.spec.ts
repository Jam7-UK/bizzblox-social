import { describe, expect, it, vi } from 'vitest';

import { PrismaBizzbloxTenantAccess } from './bizzblox-tenant-access';

describe('BizzBLOX tenant credential access', () => {
  it('projects an organization only when the exact tenant credential matches', async () => {
    const read = vi.fn().mockResolvedValue({
      connectorRevision: 7,
      credentialHash: `hmac-sha256:${'a'.repeat(64)}`,
      credentialVersion: 3,
      externalTenantHandle: 'tenant_opaque_123',
      organizationId: 'postiz-org-1',
      organizationProvenance: 'orgprov_1',
      payloadDigest: 'b'.repeat(64),
      recoveryEnvelope: null,
      recoveryConsumedAt: null,
    });
    const access = new PrismaBizzbloxTenantAccess(
      { ensure: vi.fn(), read },
      {
        generateCredential: vi.fn(),
        hashCredential: (value) =>
          value === 'correct-secret'
            ? `hmac-sha256:${'a'.repeat(64)}`
            : `hmac-sha256:${'c'.repeat(64)}`,
        sealCredential: vi.fn(),
        unsealCredential: vi.fn(),
      }
    );

    await expect(
      access.verifyCredential('tenant_opaque_123', 'correct-secret')
    ).resolves.toEqual({
      connectorRevision: 7,
      credentialVersion: 3,
      organizationId: 'postiz-org-1',
    });
    await expect(
      access.verifyCredential('tenant_opaque_123', 'wrong-secret')
    ).resolves.toBeNull();
  });
});
