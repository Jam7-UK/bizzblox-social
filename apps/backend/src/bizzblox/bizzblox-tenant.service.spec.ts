import { describe, expect, it, vi } from 'vitest';

import {
  BizzbloxTenantService,
  type BizzbloxTenantRecord,
  type BizzbloxTenantStore,
} from './bizzblox-tenant.service';

describe('BizzBLOX tenant service', () => {
  it('creates one opaque tenant and returns the same credential once after an ambiguous retry', async () => {
    let record: BizzbloxTenantRecord | null = null;
    const ensure = vi.fn<BizzbloxTenantStore['ensure']>(async (candidate) => {
      if (!record) {
        record = {
          connectorRevision: candidate.connectorRevision,
          credentialHash: candidate.credentialHash,
          credentialVersion: 1,
          externalTenantHandle: candidate.externalTenantHandle,
          organizationId: candidate.organizationId,
          organizationProvenance: candidate.organizationProvenance,
          payloadDigest: candidate.payloadDigest,
          recoveryEnvelope: candidate.recoveryEnvelope,
          recoveryConsumedAt: null,
        };
        return { created: true, record };
      }
      if (record.payloadDigest !== candidate.payloadDigest) {
        return { conflict: true, record };
      }
      if (record.recoveryConsumedAt !== null) return { created: false, record };
      const recoverable = record;
      record = { ...record, recoveryConsumedAt: 1787860860000 };
      return { created: false, record: recoverable, recoveryConsumed: true };
    });
    const read = vi.fn<BizzbloxTenantStore['read']>(async () => record);
    const service = new BizzbloxTenantService(
      { ensure, read },
      {
        generateCredential: () => 'tenant-clear-secret-000000000001',
        hashCredential: (value) => `hash:${value}`,
        sealCredential: async (value) => `sealed:${value}`,
        unsealCredential: async (value) => value.replace('sealed:', ''),
      },
      {
        createOrganization: () => ({
          apiKey: 'bbx-internal-api-key',
          id: 'postiz-org-1',
          provenance: 'orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
        }),
      }
    );
    const input = {
      connectorRevision: 7,
      externalTenantHandle: 'tenant_opaque_123',
      idempotencyKey: 'idem_opaque_1234567890',
      idempotencyVersion: 1 as const,
    };

    await expect(service.ensureTenant(input)).resolves.toEqual({
      created: true,
      credentialVersion: 1,
      organizationProvenance: 'orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
      tenantCredential: 'tenant-clear-secret-000000000001',
      tenantHandle: 'tenant_opaque_123',
    });
    await expect(service.ensureTenant(input)).resolves.toEqual({
      created: false,
      credentialVersion: 1,
      organizationProvenance: 'orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
      tenantCredential: 'tenant-clear-secret-000000000001',
      tenantHandle: 'tenant_opaque_123',
    });
    await expect(service.ensureTenant(input)).rejects.toMatchObject({
      code: 'credential_recovery_exhausted',
    });
    expect(ensure).toHaveBeenCalledTimes(3);
  });

  it('reads only the exact opaque tenant projection and never returns credential material', async () => {
    const record: BizzbloxTenantRecord = {
      connectorRevision: 7,
      credentialHash: 'credential-hash-must-stay-private',
      credentialVersion: 3,
      externalTenantHandle: 'tenant_opaque_123',
      organizationId: 'postiz-org-1',
      organizationProvenance: 'orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
      payloadDigest: 'payload-digest',
      recoveryEnvelope: 'recovery-envelope-must-stay-private',
      recoveryConsumedAt: 1787860860000,
    };
    const read = vi.fn<BizzbloxTenantStore['read']>().mockResolvedValue(record);
    const service = new BizzbloxTenantService(
      { ensure: vi.fn(), read },
      {
        generateCredential: () => 'unused',
        hashCredential: () => 'unused',
        sealCredential: async () => 'unused',
        unsealCredential: async () => 'unused',
      },
      {
        createOrganization: () => ({
          apiKey: 'unused',
          id: 'unused',
          provenance: 'unused',
        }),
      }
    );

    await expect(service.readTenant('tenant_opaque_123')).resolves.toEqual({
      found: true,
      tenantHandle: 'tenant_opaque_123',
      organizationProvenance: 'orgprov_01J6DCZP6S4XFX58GRY7H6QYJD',
    });
    expect(
      JSON.stringify(await service.readTenant('tenant_opaque_123'))
    ).not.toMatch(/credential-hash|recovery-envelope|postiz-org-1/);
  });
});
