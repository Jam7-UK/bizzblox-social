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
      where: { externalTenantHandle: string; recoveryConsumedAt: null };
      data: { recoveryConsumedAt: Date };
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
