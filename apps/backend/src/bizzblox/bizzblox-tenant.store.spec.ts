import { describe, expect, it, vi } from 'vitest';

import {
  PrismaBizzbloxTenantStore,
  type BizzbloxTenantTransaction,
} from './bizzblox-tenant.store';

const candidate = {
  connectorRevision: 7,
  credentialHash: `hmac-sha256:${'a'.repeat(64)}`,
  externalTenantHandle: 'tenant_opaque_123',
  organizationId: 'postiz-org-1',
  organizationProvenance: 'orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
  payloadDigest: 'b'.repeat(64),
  recoveryEnvelope: 'v1.recovery-envelope',
} as const;

describe('Prisma BizzBLOX tenant store', () => {
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
      bizzbloxTenant: {
        create: tenantCreate,
        findUnique,
        updateMany: vi.fn(),
      },
      organization: { create: organizationCreate },
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
        id: 'postiz-org-1',
        name: 'Managed social tenant orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
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
      bizzbloxTenant: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(existing),
        updateMany,
      },
      organization: { create: vi.fn() },
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
