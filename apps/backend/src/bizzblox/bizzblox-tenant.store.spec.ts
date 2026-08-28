import { describe, expect, it, vi } from 'vitest';

import {
  PrismaBizzbloxTenantStore,
  type BizzbloxTenantTransaction,
} from './bizzblox-tenant.store';

const candidate = {
  connectorRevision: 7,
  credentialHash: `hmac-sha256:${'a'.repeat(64)}`,
  externalTenantHandle: 'tenant_opaque_123',
  organizationApiKey: 'bbx_internal_api_key_1234567890123456',
  organizationId: 'postiz-org-1',
  organizationProvenance: 'orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
  payloadDigest: 'b'.repeat(64),
  recoveryEnvelope: 'v1.recovery-envelope',
} as const;

function unusedCleanupModels() {
  return {
    bizzbloxChannel: { deleteMany: vi.fn() },
    bizzbloxPublication: { deleteMany: vi.fn() },
    integration: { updateMany: vi.fn() },
    post: { updateMany: vi.fn() },
    subscription: { updateMany: vi.fn() },
  };
}

describe('Prisma BizzBLOX tenant store', () => {
  it('atomically retires one exact synthetic tenant and scrubs provider credentials and content', async () => {
    const now = new Date('2026-08-28T10:00:00.000Z');
    const tenantUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const organizationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const integrationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const postUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const channelDelete = vi.fn().mockResolvedValue({ count: 1 });
    const publicationDelete = vi.fn().mockResolvedValue({ count: 1 });
    const subscriptionUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      bizzbloxTenant: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          ...candidate,
          externalTenantHandle: 'tenant_synthetic_release_123',
          organizationId: 'postiz-org-synthetic-1',
          credentialVersion: 1,
          recoveryConsumedAt: now,
        }),
        updateMany: tenantUpdate,
      },
      bizzbloxChannel: { deleteMany: channelDelete },
      bizzbloxPublication: { deleteMany: publicationDelete },
      integration: { updateMany: integrationUpdate },
      post: { updateMany: postUpdate },
      subscription: { updateMany: subscriptionUpdate },
      organization: {
        create: vi.fn(),
        updateMany: organizationUpdate,
      },
    } as unknown as BizzbloxTenantTransaction;
    const store = new PrismaBizzbloxTenantStore(
      { $transaction: async (callback) => await callback(transaction) },
      () => now
    );

    await expect(
      store.cleanupSynthetic({
        externalTenantHandle: 'tenant_synthetic_release_123',
        organizationId: 'postiz-org-synthetic-1',
        retiredCredentialHash: `hmac-sha256:${'f'.repeat(64)}`,
      })
    ).resolves.toBe(true);
    expect(integrationUpdate).toHaveBeenCalledWith({
      where: { organizationId: 'postiz-org-synthetic-1' },
      data: {
        additionalSettings: '[]',
        customInstanceDetails: null,
        deletedAt: now,
        disabled: true,
        refreshToken: null,
        token: 'retired',
      },
    });
    expect(postUpdate).toHaveBeenCalledWith({
      where: { organizationId: 'postiz-org-synthetic-1' },
      data: {
        content: '',
        deletedAt: now,
        description: null,
        error: null,
        image: null,
        releaseURL: null,
        settings: null,
        title: null,
      },
    });
    expect(tenantUpdate).toHaveBeenCalledWith({
      where: {
        externalTenantHandle: 'tenant_synthetic_release_123',
        organizationId: 'postiz-org-synthetic-1',
      },
      data: {
        credentialHash: `hmac-sha256:${'f'.repeat(64)}`,
        recoveryConsumedAt: now,
        recoveryEnvelope: null,
      },
    });
    expect(channelDelete).toHaveBeenCalledWith({
      where: { organizationId: 'postiz-org-synthetic-1' },
    });
    expect(publicationDelete).toHaveBeenCalledWith({
      where: { organizationId: 'postiz-org-synthetic-1' },
    });
    expect(subscriptionUpdate).toHaveBeenCalledWith({
      where: { organizationId: 'postiz-org-synthetic-1' },
      data: { deletedAt: now },
    });
    expect(organizationUpdate).toHaveBeenCalledWith({
      where: { id: 'postiz-org-synthetic-1', deletedAt: null },
      data: { apiKey: null, deletedAt: now },
    });
  });

  it('creates the organization and mapping atomically without customer identity fields', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const organizationCreate = vi
      .fn()
      .mockResolvedValue({ id: candidate.organizationId });
    const tenantCreate = vi.fn().mockImplementation(async ({ data }) => ({
      ...data,
      credentialVersion: 1,
      recoveryConsumedAt: null as Date | null,
    }));
    const transaction: BizzbloxTenantTransaction = {
      ...unusedCleanupModels(),
      bizzbloxTenant: {
        create: tenantCreate,
        findUnique,
        updateMany: vi.fn(),
      },
      organization: { create: organizationCreate, updateMany: vi.fn() },
    };
    const store = new PrismaBizzbloxTenantStore(
      { $transaction: async (callback) => await callback(transaction) },
      () => new Date('2026-08-27T20:00:00.000Z')
    );

    await expect(store.ensure(candidate)).resolves.toMatchObject({
      created: true,
      record: {
        externalTenantHandle: 'tenant_opaque_123',
        organizationId: 'postiz-org-1',
        recoveryConsumedAt: null,
      },
    });
    expect(organizationCreate).toHaveBeenCalledWith({
      data: {
        apiKey: 'bbx_internal_api_key_1234567890123456',
        id: 'postiz-org-1',
        name: 'Managed social tenant orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
        subscription: {
          create: {
            identifier: 'bizzblox-managed-service',
            isLifetime: true,
            period: 'YEARLY',
            subscriptionTier: 'ULTIMATE',
            totalChannels: 10_000,
          },
        },
      },
      select: { id: true },
    });
    expect(JSON.stringify(organizationCreate.mock.calls)).not.toMatch(
      /email|domain|workspace|customer/i
    );
  });

  it('atomically consumes an existing recovery envelope only once', async () => {
    const existing = {
      ...candidate,
      credentialVersion: 1,
      recoveryConsumedAt: null as Date | null,
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction: BizzbloxTenantTransaction = {
      ...unusedCleanupModels(),
      bizzbloxTenant: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(existing),
        updateMany,
      },
      organization: { create: vi.fn(), updateMany: vi.fn() },
    };
    const store = new PrismaBizzbloxTenantStore(
      { $transaction: async (callback) => await callback(transaction) },
      () => new Date('2026-08-27T20:00:00.000Z')
    );

    await expect(store.ensure(candidate)).resolves.toMatchObject({
      created: false,
      recoveryConsumed: true,
      record: { recoveryConsumedAt: null },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        externalTenantHandle: 'tenant_opaque_123',
        recoveryConsumedAt: null,
      },
      data: { recoveryConsumedAt: new Date('2026-08-27T20:00:00.000Z') },
    });
  });
});
