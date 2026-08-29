import { Inject, Injectable } from '@nestjs/common';

import type {
  BizzbloxTenantCandidate,
  BizzbloxTenantEnsureResult,
  BizzbloxTenantRecord,
  BizzbloxTenantStore,
} from './bizzblox-tenant.service';

type StoredBizzbloxTenant = Omit<BizzbloxTenantRecord, 'recoveryConsumedAt'> & {
  recoveryConsumedAt: Date | null;
};

export type BizzbloxTenantTransaction = Readonly<{
  bizzbloxTenant: Readonly<{
    create(input: {
      data: Omit<BizzbloxTenantCandidate, 'organizationApiKey'>;
    }): Promise<StoredBizzbloxTenant>;
    findUnique(input: {
      where: { externalTenantHandle: string };
    }): Promise<StoredBizzbloxTenant | null>;
    updateMany(input: {
      where:
        | { externalTenantHandle: string; recoveryConsumedAt: null }
        | { externalTenantHandle: string; organizationId: string };
      data:
        | { recoveryConsumedAt: Date }
        | {
            credentialHash: string;
            recoveryConsumedAt: Date;
            recoveryEnvelope: null;
          };
    }): Promise<{ count: number }>;
  }>;
  bizzbloxChannel: Readonly<{
    deleteMany(input: { where: { organizationId: string } }): Promise<{
      count: number;
    }>;
  }>;
  bizzbloxPublication: Readonly<{
    deleteMany(input: { where: { organizationId: string } }): Promise<{
      count: number;
    }>;
  }>;
  integration: Readonly<{
    updateMany(input: {
      where: { organizationId: string };
      data: {
        additionalSettings: '[]';
        customInstanceDetails: null;
        deletedAt: Date;
        disabled: true;
        refreshToken: null;
        token: 'retired';
      };
    }): Promise<{ count: number }>;
  }>;
  post: Readonly<{
    updateMany(input: {
      where: { organizationId: string };
      data: {
        content: '';
        deletedAt: Date;
        description: null;
        error: null;
        image: null;
        releaseURL: null;
        settings: null;
        title: null;
      };
    }): Promise<{ count: number }>;
  }>;
  subscription: Readonly<{
    updateMany(input: {
      where: { organizationId: string };
      data: { deletedAt: Date };
    }): Promise<{ count: number }>;
  }>;
  organization: Readonly<{
    create(input: {
      data: {
        apiKey: string;
        id: string;
        name: string;
        subscription: {
          create: {
            identifier: string;
            isLifetime: true;
            period: 'YEARLY';
            subscriptionTier: 'ULTIMATE';
            totalChannels: number;
          };
        };
      };
      select: { id: true };
    }): Promise<{ id: string }>;
    updateMany(input: {
      where: { id: string; deletedAt: null };
      data: { apiKey: null; deletedAt: Date };
    }): Promise<{ count: number }>;
  }>;
}>;

export interface BizzbloxTenantDatabase {
  $transaction<T>(
    callback: (transaction: BizzbloxTenantTransaction) => Promise<T>
  ): Promise<T>;
}

export const BIZZBLOX_TENANT_DATABASE = Symbol('BIZZBLOX_TENANT_DATABASE');

function record(row: StoredBizzbloxTenant): BizzbloxTenantRecord {
  return Object.freeze({
    connectorRevision: row.connectorRevision,
    credentialHash: row.credentialHash,
    credentialVersion: row.credentialVersion,
    externalTenantHandle: row.externalTenantHandle,
    organizationId: row.organizationId,
    organizationProvenance: row.organizationProvenance,
    payloadDigest: row.payloadDigest,
    recoveryEnvelope: row.recoveryEnvelope,
    recoveryConsumedAt: row.recoveryConsumedAt?.getTime() ?? null,
  });
}

function retryableTransactionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'P2002' || error.code === 'P2034')
  );
}

@Injectable()
export class PrismaBizzbloxTenantStore implements BizzbloxTenantStore {
  constructor(
    @Inject(BIZZBLOX_TENANT_DATABASE)
    private readonly database: BizzbloxTenantDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async cleanupSynthetic(input: {
    externalTenantHandle: string;
    organizationId: string;
    retiredCredentialHash: string;
  }): Promise<boolean> {
    if (
      !/^tenant_synthetic_[A-Za-z0-9_-]{1,103}$/.test(
        input.externalTenantHandle
      ) ||
      !input.organizationId ||
      !input.retiredCredentialHash
    ) {
      return false;
    }
    return await this.database.$transaction(async (transaction) => {
      const existing = await transaction.bizzbloxTenant.findUnique({
        where: { externalTenantHandle: input.externalTenantHandle },
      });
      if (
        !existing ||
        existing.externalTenantHandle !== input.externalTenantHandle ||
        existing.organizationId !== input.organizationId
      ) {
        return false;
      }
      const now = this.clock();
      await transaction.post.updateMany({
        where: { organizationId: input.organizationId },
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
      await transaction.integration.updateMany({
        where: { organizationId: input.organizationId },
        data: {
          additionalSettings: '[]',
          customInstanceDetails: null,
          deletedAt: now,
          disabled: true,
          refreshToken: null,
          token: 'retired',
        },
      });
      await transaction.bizzbloxPublication.deleteMany({
        where: { organizationId: input.organizationId },
      });
      await transaction.bizzbloxChannel.deleteMany({
        where: { organizationId: input.organizationId },
      });
      await transaction.subscription.updateMany({
        where: { organizationId: input.organizationId },
        data: { deletedAt: now },
      });
      const tenant = await transaction.bizzbloxTenant.updateMany({
        where: {
          externalTenantHandle: input.externalTenantHandle,
          organizationId: input.organizationId,
        },
        data: {
          credentialHash: input.retiredCredentialHash,
          recoveryConsumedAt: now,
          recoveryEnvelope: null,
        },
      });
      const organization = await transaction.organization.updateMany({
        where: { id: input.organizationId, deletedAt: null },
        data: { apiKey: null, deletedAt: now },
      });
      if (tenant.count !== 1 || organization.count !== 1) {
        throw new Error('Synthetic tenant cleanup lost exact authority.');
      }
      return true;
    });
  }

  async ensure(
    candidate: BizzbloxTenantCandidate
  ): Promise<BizzbloxTenantEnsureResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.database.$transaction(async (transaction) => {
          const existing = await transaction.bizzbloxTenant.findUnique({
            where: { externalTenantHandle: candidate.externalTenantHandle },
          });
          if (!existing) {
            const { organizationApiKey, ...tenantCandidate } = candidate;
            await transaction.organization.create({
              data: {
                id: candidate.organizationId,
                apiKey: organizationApiKey,
                name: `Managed social tenant ${candidate.organizationProvenance}`,
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
            const created = await transaction.bizzbloxTenant.create({
              data: tenantCandidate,
            });
            return Object.freeze({ created: true, record: record(created) });
          }
          if (
            existing.payloadDigest !== candidate.payloadDigest ||
            existing.connectorRevision !== candidate.connectorRevision
          ) {
            return Object.freeze({ conflict: true, record: record(existing) });
          }
          if (existing.recoveryConsumedAt !== null) {
            return Object.freeze({ created: false, record: record(existing) });
          }
          const consumed = await transaction.bizzbloxTenant.updateMany({
            where: {
              externalTenantHandle: candidate.externalTenantHandle,
              recoveryConsumedAt: null,
            },
            data: { recoveryConsumedAt: this.clock() },
          });
          if (consumed.count !== 1) {
            return Object.freeze({ created: false, record: record(existing) });
          }
          return Object.freeze({
            created: false,
            record: record(existing),
            recoveryConsumed: true as const,
          });
        });
      } catch (error) {
        if (attempt === 2 || !retryableTransactionError(error)) throw error;
      }
    }
    throw new Error('BizzBLOX tenant transaction retry exhausted');
  }

  async read(
    externalTenantHandle: string
  ): Promise<BizzbloxTenantRecord | null> {
    return await this.database.$transaction(async (transaction) => {
      const stored = await transaction.bizzbloxTenant.findUnique({
        where: { externalTenantHandle },
      });
      return stored ? record(stored) : null;
    });
  }
}
