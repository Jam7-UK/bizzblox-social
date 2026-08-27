import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
  BizzbloxAuthGuard,
  type BizzbloxClaimVerifier,
  type BizzbloxReplayStore,
  type BizzbloxTenantAccess,
  type BizzbloxVerifiedRequest,
} from './bizzblox-auth.guard';

const requestDigest =
  '1ec0e26b3e5a3ea99987c8faf0b95b54324eb5f91d82eda29b1db74d280c4a30';
const tenantHandleHash =
  '8871aadbec53ee07ee9468cf7073562c5f58ad817a338063a2d1232f495ea003';

function executionContext(request: BizzbloxVerifiedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('BizzBLOX service authentication guard', () => {
  it('admits a request only when IAM, the signed claim, and tenant credential agree', async () => {
    const verify = vi.fn<BizzbloxClaimVerifier['verify']>().mockResolvedValue({
      audience: 'bizzblox-social',
      connectorRevision: 7,
      expiresAt: 1787860890,
      issuedAt: 1787860800,
      nonce: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      operation: 'tenant.ensure',
      requestDigest,
      tenantHandleHash,
    });
    const consume = vi
      .fn<BizzbloxReplayStore['consume']>()
      .mockResolvedValue(true);
    const verifyCredential = vi
      .fn<BizzbloxTenantAccess['verifyCredential']>()
      .mockResolvedValue({
        connectorRevision: 7,
        credentialVersion: 3,
        organizationId: 'postiz-org-1',
      });
    const request: BizzbloxVerifiedRequest = {
      body: {
        externalTenantHandle: 'tenant_opaque_123',
        idempotencyVersion: 1,
      },
      bizzbloxIam: {
        accountId: '495599735993',
        principalArn: 'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
      },
      headers: {
        'x-bizzblox-operation-claim': 'signed-claim',
        'x-bizzblox-tenant-credential': 'tenant-credential',
        'x-bizzblox-tenant-handle': 'tenant_opaque_123',
      },
      method: 'POST',
      originalUrl: '/internal/bizzblox/v1/tenants:ensure',
    };
    const guard = new BizzbloxAuthGuard(
      { verify },
      { consume },
      { verifyCredential },
      {
        accountId: '495599735993',
        audience: 'bizzblox-social',
        bridgePrincipalArn:
          'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
        clock: () => new Date('2026-08-27T20:00:00.000Z'),
      }
    );

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(
      true
    );
    expect(verify).toHaveBeenCalledWith('signed-claim');
    expect(verifyCredential).toHaveBeenCalledWith(
      'tenant_opaque_123',
      'tenant-credential'
    );
    expect(consume).toHaveBeenCalledWith(
      'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      1787860890
    );
    expect(request.bizzbloxAuth).toEqual({
      connectorRevision: 7,
      credentialVersion: 3,
      operation: 'tenant.ensure',
      organizationId: 'postiz-org-1',
      tenantHandle: 'tenant_opaque_123',
    });
  });

  it('rejects a credential bound to another connector revision without burning the nonce', async () => {
    const verify = vi.fn<BizzbloxClaimVerifier['verify']>().mockResolvedValue({
      audience: 'bizzblox-social',
      connectorRevision: 7,
      expiresAt: 1787860890,
      issuedAt: 1787860800,
      nonce: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      operation: 'tenant.ensure',
      requestDigest,
      tenantHandleHash,
    });
    const consume = vi
      .fn<BizzbloxReplayStore['consume']>()
      .mockResolvedValue(true);
    const verifyCredential = vi
      .fn<BizzbloxTenantAccess['verifyCredential']>()
      .mockResolvedValue({
        connectorRevision: 6,
        credentialVersion: 3,
        organizationId: 'postiz-org-1',
      });
    const request: BizzbloxVerifiedRequest = {
      body: {
        externalTenantHandle: 'tenant_opaque_123',
        idempotencyVersion: 1,
      },
      bizzbloxIam: {
        accountId: '495599735993',
        principalArn: 'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
      },
      headers: {
        'x-bizzblox-operation-claim': 'signed-claim',
        'x-bizzblox-tenant-credential': 'tenant-credential',
        'x-bizzblox-tenant-handle': 'tenant_opaque_123',
      },
      method: 'POST',
      originalUrl: '/internal/bizzblox/v1/tenants:ensure',
    };
    const guard = new BizzbloxAuthGuard(
      { verify },
      { consume },
      { verifyCredential },
      {
        accountId: '495599735993',
        audience: 'bizzblox-social',
        bridgePrincipalArn:
          'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
        clock: () => new Date('2026-08-27T20:00:00.000Z'),
      }
    );

    await expect(
      guard.canActivate(executionContext(request))
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(consume).not.toHaveBeenCalled();
    expect(request.bizzbloxAuth).toBeUndefined();
  });

  it('rejects a tenant path that differs from the claim-bound tenant header', async () => {
    const verify = vi.fn<BizzbloxClaimVerifier['verify']>().mockResolvedValue({
      audience: 'bizzblox-social',
      connectorRevision: 7,
      expiresAt: 1787860890,
      issuedAt: 1787860800,
      nonce: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      operation: 'tenant.read',
      requestDigest:
        '802fcfdaaa3c27e94ce3a1e8c9bb1aeed77dc122f9585f51721c131e535d922f',
      tenantHandleHash,
    });
    const consume = vi
      .fn<BizzbloxReplayStore['consume']>()
      .mockResolvedValue(true);
    const verifyCredential = vi
      .fn<BizzbloxTenantAccess['verifyCredential']>()
      .mockResolvedValue({
        connectorRevision: 7,
        credentialVersion: 3,
        organizationId: 'postiz-org-1',
      });
    const request: BizzbloxVerifiedRequest = {
      body: undefined,
      bizzbloxIam: {
        accountId: '495599735993',
        principalArn: 'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
      },
      headers: {
        'x-bizzblox-operation-claim': 'signed-claim',
        'x-bizzblox-tenant-credential': 'tenant-credential',
        'x-bizzblox-tenant-handle': 'tenant_opaque_123',
      },
      method: 'GET',
      originalUrl: '/internal/bizzblox/v1/tenants/tenant_opaque_other',
    };
    const guard = new BizzbloxAuthGuard(
      { verify },
      { consume },
      { verifyCredential },
      {
        accountId: '495599735993',
        audience: 'bizzblox-social',
        bridgePrincipalArn:
          'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
        clock: () => new Date('2026-08-27T20:00:00.000Z'),
      }
    );

    await expect(
      guard.canActivate(executionContext(request))
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(verifyCredential).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
});
