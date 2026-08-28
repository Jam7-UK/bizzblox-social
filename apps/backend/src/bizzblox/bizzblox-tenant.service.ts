import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

export const BIZZBLOX_TENANT_STORE = Symbol('BIZZBLOX_TENANT_STORE');
export const BIZZBLOX_TENANT_CREDENTIALS = Symbol(
  'BIZZBLOX_TENANT_CREDENTIALS'
);
export const BIZZBLOX_ORGANIZATION_FACTORY = Symbol(
  'BIZZBLOX_ORGANIZATION_FACTORY'
);

export type EnsureTenantInput = Readonly<{
  connectorRevision: number;
  externalTenantHandle: string;
  idempotencyKey: string;
  idempotencyVersion: 1;
}>;

export type EnsureTenantResponse = Readonly<{
  created: boolean;
  credentialVersion: number;
  organizationProvenance: string;
  tenantCredential: string;
  tenantHandle: string;
}>;

export type BizzbloxTenantRecord = Readonly<{
  connectorRevision: number;
  credentialHash: string;
  credentialVersion: number;
  externalTenantHandle: string;
  organizationId: string;
  organizationProvenance: string;
  payloadDigest: string;
  recoveryEnvelope: string | null;
  recoveryConsumedAt: number | null;
}>;

export type BizzbloxTenantCandidate = Readonly<{
  connectorRevision: number;
  credentialHash: string;
  externalTenantHandle: string;
  organizationId: string;
  organizationApiKey: string;
  organizationProvenance: string;
  payloadDigest: string;
  recoveryEnvelope: string;
}>;

export type BizzbloxTenantEnsureResult =
  | Readonly<{ conflict: true; record: BizzbloxTenantRecord }>
  | Readonly<{
      created: boolean;
      record: BizzbloxTenantRecord;
      recoveryConsumed?: true;
    }>;

export interface BizzbloxTenantStore {
  ensure(
    candidate: BizzbloxTenantCandidate
  ): Promise<BizzbloxTenantEnsureResult>;
  read(externalTenantHandle: string): Promise<BizzbloxTenantRecord | null>;
  cleanupSynthetic(input: {
    externalTenantHandle: string;
    organizationId: string;
    retiredCredentialHash: string;
  }): Promise<boolean>;
}

export interface BizzbloxTenantCredentials {
  generateCredential(): string;
  hashCredential(value: string): string;
  sealCredential(value: string): Promise<string>;
  unsealCredential(value: string): Promise<string>;
}

export interface BizzbloxOrganizationFactory {
  createOrganization(): Readonly<{
    apiKey: string;
    id: string;
    provenance: string;
  }>;
}

export type BizzbloxTenantErrorCode =
  | 'credential_recovery_exhausted'
  | 'idempotency_conflict'
  | 'mapping_corrupt'
  | 'synthetic_cleanup_denied';

export class BizzbloxTenantError extends Error {
  constructor(readonly code: BizzbloxTenantErrorCode) {
    super(code);
    this.name = 'BizzbloxTenantError';
  }
}

function payloadDigest(input: EnsureTenantInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        connectorRevision: input.connectorRevision,
        externalTenantHandle: input.externalTenantHandle,
        idempotencyKey: input.idempotencyKey,
        idempotencyVersion: input.idempotencyVersion,
      })
    )
    .digest('hex');
}

function validInput(input: EnsureTenantInput): boolean {
  return (
    /^tenant_[A-Za-z0-9_-]{8,120}$/.test(input.externalTenantHandle) &&
    /^idem_[A-Za-z0-9_-]{16,120}$/.test(input.idempotencyKey) &&
    input.idempotencyVersion === 1 &&
    Number.isInteger(input.connectorRevision) &&
    input.connectorRevision > 0
  );
}

@Injectable()
export class BizzbloxTenantService {
  constructor(
    @Inject(BIZZBLOX_TENANT_STORE)
    private readonly store: BizzbloxTenantStore,
    @Inject(BIZZBLOX_TENANT_CREDENTIALS)
    private readonly credentials: BizzbloxTenantCredentials,
    @Inject(BIZZBLOX_ORGANIZATION_FACTORY)
    private readonly organizations: BizzbloxOrganizationFactory
  ) {}

  async cleanupSyntheticTenant(
    externalTenantHandle: string,
    organizationId: string
  ): Promise<Readonly<{ cleanupConfirmed: true; tenantHandle: string }>> {
    if (
      !/^tenant_synthetic_[A-Za-z0-9_-]{1,103}$/.test(externalTenantHandle) ||
      !organizationId ||
      organizationId.length > 256
    ) {
      throw new BizzbloxTenantError('synthetic_cleanup_denied');
    }
    const cleanupConfirmed = await this.store.cleanupSynthetic({
      externalTenantHandle,
      organizationId,
      retiredCredentialHash: this.credentials.hashCredential(
        this.credentials.generateCredential()
      ),
    });
    if (!cleanupConfirmed) {
      throw new BizzbloxTenantError('synthetic_cleanup_denied');
    }
    return Object.freeze({
      cleanupConfirmed: true as const,
      tenantHandle: externalTenantHandle,
    });
  }

  async ensureTenant(input: EnsureTenantInput): Promise<EnsureTenantResponse> {
    if (!validInput(input))
      throw new BizzbloxTenantError('idempotency_conflict');
    const clearCredential = this.credentials.generateCredential();
    const organization = this.organizations.createOrganization();
    const candidate = Object.freeze({
      connectorRevision: input.connectorRevision,
      credentialHash: this.credentials.hashCredential(clearCredential),
      externalTenantHandle: input.externalTenantHandle,
      organizationId: organization.id,
      organizationApiKey: organization.apiKey,
      organizationProvenance: organization.provenance,
      payloadDigest: payloadDigest(input),
      recoveryEnvelope: await this.credentials.sealCredential(clearCredential),
    });
    const result = await this.store.ensure(candidate);
    if ('conflict' in result)
      throw new BizzbloxTenantError('idempotency_conflict');

    const { record } = result;
    if (
      record.externalTenantHandle !== input.externalTenantHandle ||
      record.payloadDigest !== candidate.payloadDigest ||
      record.connectorRevision !== input.connectorRevision ||
      record.credentialVersion < 1 ||
      !record.organizationId ||
      !record.organizationProvenance ||
      !record.credentialHash
    ) {
      throw new BizzbloxTenantError('mapping_corrupt');
    }

    let tenantCredential: string;
    if (result.created) {
      if (
        record.organizationId !== candidate.organizationId ||
        record.organizationProvenance !== candidate.organizationProvenance ||
        record.credentialHash !== candidate.credentialHash
      ) {
        throw new BizzbloxTenantError('mapping_corrupt');
      }
      tenantCredential = clearCredential;
    } else if (result.recoveryConsumed && record.recoveryEnvelope) {
      tenantCredential = await this.credentials.unsealCredential(
        record.recoveryEnvelope
      );
      if (
        this.credentials.hashCredential(tenantCredential) !==
        record.credentialHash
      ) {
        throw new BizzbloxTenantError('mapping_corrupt');
      }
    } else {
      throw new BizzbloxTenantError('credential_recovery_exhausted');
    }

    return Object.freeze({
      created: result.created,
      credentialVersion: record.credentialVersion,
      organizationProvenance: record.organizationProvenance,
      tenantCredential,
      tenantHandle: record.externalTenantHandle,
    });
  }

  async readTenant(externalTenantHandle: string): Promise<
    | Readonly<{ found: false }>
    | Readonly<{
        found: true;
        organizationProvenance: string;
        tenantHandle: string;
      }>
  > {
    if (!/^tenant_[A-Za-z0-9_-]{8,120}$/.test(externalTenantHandle)) {
      return Object.freeze({ found: false });
    }
    const record = await this.store.read(externalTenantHandle);
    if (!record) return Object.freeze({ found: false });
    if (
      record.externalTenantHandle !== externalTenantHandle ||
      !record.organizationProvenance
    ) {
      throw new BizzbloxTenantError('mapping_corrupt');
    }
    return Object.freeze({
      found: true,
      organizationProvenance: record.organizationProvenance,
      tenantHandle: record.externalTenantHandle,
    });
  }
}
