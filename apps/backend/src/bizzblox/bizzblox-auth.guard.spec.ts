import { createHash } from 'node:crypto';

import { Logger, type ExecutionContext } from '@nestjs/common';
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

function digestRequest(body: unknown, method: string, path: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ body, method, path }))
    .digest('hex');
}

describe('BizzBLOX service authentication guard', () => {
  it('logs only a bounded denial stage for synthetic smoke requests', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const tenantHandle = 'tenant_synthetic_release_33326519826_2';
    const body = {
      provider: 'nostr',
      userBinding: 'user_synthetic_release_33326519826_2',
    };
    const verify = vi.fn<BizzbloxClaimVerifier['verify']>().mockResolvedValue({
      audience: 'bizzblox-social',
      connectorRevision: 1,
      expiresAt: 1787860890,
      issuedAt: 1787860800,
      nonce: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      operation: 'connection.begin',
      requestDigest: '0'.repeat(64),
      tenantHandleHash: createHash('sha256').update(tenantHandle).digest('hex'),
    });
    const request: BizzbloxVerifiedRequest = {
      body,
      bizzbloxIam: {
        accountId: '495599735993',
        principalArn: 'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
      },
      headers: {
        'x-bizzblox-operation-claim': 'sensitive-signed-claim',
        'x-bizzblox-tenant-credential': 'sensitive-tenant-credential',
        'x-bizzblox-tenant-handle': tenantHandle,
      },
      method: 'POST',
      originalUrl: '/internal/bizzblox/v1/connections:begin',
    };
    const guard = new BizzbloxAuthGuard(
      { verify },
      { consume: vi.fn().mockResolvedValue(true) },
      {
        verifyCredential: vi.fn().mockResolvedValue({
          connectorRevision: 1,
          credentialVersion: 1,
          organizationId: 'sensitive-organization-id',
        }),
      },
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
    ).rejects.toMatchObject({ status: 401 });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'BizzBLOX synthetic authorization denied at claim_request_digest.',
      BizzbloxAuthGuard.name
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /sensitive|tenant_synthetic|nostr/
    );
    warn.mockRestore();
  });

  it('binds an exact binary media body and metadata to the signed claim', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    const path = '/internal/bizzblox/v1/media:upload';
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          bodySha256: checksumSha256,
          metadata: {
            byteSize: bytes.byteLength,
            checksumSha256,
            contentType: 'image/png',
            externalMediaId: `bbx_media_${'a'.repeat(48)}`,
          },
          method: 'POST',
          path,
        })
      )
      .digest('hex');
    const verify = vi.fn<BizzbloxClaimVerifier['verify']>().mockResolvedValue({
      audience: 'bizzblox-social',
      connectorRevision: 7,
      expiresAt: 1787860890,
      issuedAt: 1787860800,
      nonce: 'nonce_media_01J6DCG5GFV2X9PPYF4D8KPWYB',
      operation: 'media.upload',
      requestDigest,
      tenantHandleHash,
    });
    const request: BizzbloxVerifiedRequest = {
      body: bytes,
      bizzbloxIam: {
        accountId: '495599735993',
        principalArn: 'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
      },
      headers: {
        'content-type': 'image/png',
        'x-bizzblox-media-byte-size': String(bytes.byteLength),
        'x-bizzblox-media-external-id': `bbx_media_${'a'.repeat(48)}`,
        'x-bizzblox-media-sha256': checksumSha256,
        'x-bizzblox-operation-claim': 'signed-media-claim',
        'x-bizzblox-tenant-credential': 'tenant-credential',
        'x-bizzblox-tenant-handle': 'tenant_opaque_123',
      },
      method: 'POST',
      originalUrl: path,
    };
    const guard = new BizzbloxAuthGuard(
      { verify },
      { consume: vi.fn().mockResolvedValue(true) },
      {
        verifyCredential: vi.fn().mockResolvedValue({
          connectorRevision: 7,
          credentialVersion: 3,
          organizationId: 'postiz-org-1',
        }),
      },
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
    expect(request.bizzbloxAuth?.operation).toBe('media.upload');
  });
  it('bootstraps a tenant only when IAM and the one-use signed claim agree', async () => {
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
    const verifyCredential = vi.fn<BizzbloxTenantAccess['verifyCredential']>();
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
    expect(verify).toHaveBeenCalledWith('signed-claim', 'tenant_opaque_123');
    expect(verifyCredential).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledWith(
      'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      1787860890
    );
    expect(request.bizzbloxAuth).toEqual({
      connectorRevision: 7,
      credentialVersion: null,
      operation: 'tenant.ensure',
      organizationId: null,
      tenantHandle: 'tenant_opaque_123',
    });
  });

  it.each([
    ['provider.list', 'GET', '/internal/bizzblox/v1/providers', undefined],
    [
      'tenant.cleanup',
      'POST',
      '/internal/bizzblox/v1/tenants/tenant_synthetic_release_123/cleanup',
      {},
      'tenant_synthetic_release_123',
    ],
    [
      'connection.begin',
      'POST',
      '/internal/bizzblox/v1/connections:begin',
      { provider: 'linkedin' },
    ],
    [
      'connection.select',
      'POST',
      '/internal/bizzblox/v1/connections:select',
      {
        attemptHandle: 'selection-attempt-1',
        optionRef: 'selection-option-1',
      },
    ],
    [
      'connection.disconnect',
      'POST',
      '/internal/bizzblox/v1/connections:disconnect',
      { channelHandle: 'bbx_ch_exact_linkedin' },
    ],
    [
      'publication.validate',
      'POST',
      '/internal/bizzblox/v1/publications:validate',
      {},
    ],
    ['publication.schedule', 'POST', '/internal/bizzblox/v1/publications', {}],
    [
      'publication.read',
      'GET',
      '/internal/bizzblox/v1/publications/by-external/post_123',
      undefined,
    ],
    [
      'publication.analytics.read',
      'GET',
      '/internal/bizzblox/v1/publications/by-external/post_123/analytics',
      undefined,
    ],
    [
      'publication.cancel',
      'POST',
      '/internal/bizzblox/v1/publications/by-external/post_123/cancel',
      {},
    ],
    ['channel.list', 'GET', '/internal/bizzblox/v1/channels', undefined],
    [
      'channel.contract.read',
      'GET',
      '/internal/bizzblox/v1/channels/bbx_ch_123/contract',
      undefined,
    ],
    [
      'channel.helper.execute',
      'POST',
      '/internal/bizzblox/v1/channels/bbx_ch_123/tools/bbx_help_123',
      { data: { query: 'jam' } },
    ],
  ])(
    'binds %s to only its exact service route',
    async (
      operation,
      method,
      path,
      body,
      tenantHandle = 'tenant_opaque_123'
    ) => {
      const verify = vi
        .fn<BizzbloxClaimVerifier['verify']>()
        .mockResolvedValue({
          audience: 'bizzblox-social',
          connectorRevision: 7,
          expiresAt: 1787860890,
          issuedAt: 1787860800,
          nonce: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
          operation,
          requestDigest: digestRequest(body ?? null, method, path),
          tenantHandleHash: createHash('sha256')
            .update(tenantHandle)
            .digest('hex'),
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
        body,
        bizzbloxIam: {
          accountId: '495599735993',
          principalArn: 'arn:aws:iam::495599735993:role/BizzbloxSocialBridge',
        },
        headers: {
          'x-bizzblox-operation-claim': 'signed-claim',
          'x-bizzblox-tenant-credential': 'tenant-credential',
          'x-bizzblox-tenant-handle': tenantHandle,
        },
        method,
        originalUrl: path,
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
      expect(request.bizzbloxAuth?.operation).toBe(operation);
      expect(verifyCredential).toHaveBeenCalledWith(
        tenantHandle,
        'tenant-credential'
      );
    }
  );

  it('rejects a credential bound to another connector revision without burning the nonce', async () => {
    const verify = vi.fn<BizzbloxClaimVerifier['verify']>().mockResolvedValue({
      audience: 'bizzblox-social',
      connectorRevision: 7,
      expiresAt: 1787860890,
      issuedAt: 1787860800,
      nonce: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      operation: 'tenant.read',
      requestDigest:
        '2fd9c057c9976535199e42e7f21d03ab268693d76f963b016f834caf76967151',
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
      originalUrl: '/internal/bizzblox/v1/tenants/tenant_opaque_123',
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
