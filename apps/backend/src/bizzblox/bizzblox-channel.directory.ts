import { Inject, Injectable } from '@nestjs/common';

import type {
  BizzbloxChannelDirectory,
  BizzbloxManagedChannelCandidate,
  BizzbloxManagedChannelRecord,
  BizzbloxManagedChannelStatus,
} from './bizzblox-contract.service';

export const BIZZBLOX_CHANNEL_DATABASE = Symbol('BIZZBLOX_CHANNEL_DATABASE');

type StoredChannel = Readonly<{
  organizationId: string;
  externalChannelHandle: string;
  connectorRevision: number;
  contractDigest: string;
  integrationId: string;
  status: string;
}>;

type ChannelIdentity = Readonly<{
  organizationId_externalChannelHandle: Readonly<{
    organizationId: string;
    externalChannelHandle: string;
  }>;
}>;

interface BizzbloxChannelTransaction {
  bizzbloxChannel: Readonly<{
    upsert(input: {
      where: Readonly<{
        organizationId_integrationId: Readonly<{
          organizationId: string;
          integrationId: string;
        }>;
      }>;
      create: Readonly<{
        organizationId: string;
        externalChannelHandle: string;
        connectorRevision: number;
        contractDigest: string;
        integrationId: string;
        status: BizzbloxManagedChannelStatus;
      }>;
      update: Readonly<{
        connectorRevision: number;
        contractDigest: string;
        status: BizzbloxManagedChannelStatus;
      }>;
    }): Promise<StoredChannel>;
    updateMany(input: {
      where: Readonly<{
        organizationId: string;
        integrationId?: Readonly<{ notIn: readonly string[] }>;
      }>;
      data: Readonly<{ status: 'disconnected' }>;
    }): Promise<Readonly<{ count: number }>>;
  }>;
}

export interface BizzbloxChannelDatabase {
  $transaction<T>(
    operation: (transaction: BizzbloxChannelTransaction) => Promise<T>
  ): Promise<T>;
  bizzbloxChannel: Readonly<{
    findUnique(input: {
      where: ChannelIdentity;
    }): Promise<StoredChannel | null>;
    updateMany(input: {
      where: Readonly<{
        organizationId: string;
        externalChannelHandle: string;
        connectorRevision: number;
      }>;
      data: Readonly<{ contractDigest: string }>;
    }): Promise<Readonly<{ count: number }>>;
  }>;
}

function status(value: string): BizzbloxManagedChannelStatus {
  return value === 'active' || value === 'inactive' ? value : 'disconnected';
}

function record(row: StoredChannel): BizzbloxManagedChannelRecord {
  return Object.freeze({
    organizationId: row.organizationId,
    channelHandle: row.externalChannelHandle,
    connectorRevision: row.connectorRevision,
    contractDigest: row.contractDigest,
    integrationId: row.integrationId,
    status: status(row.status),
  });
}

function identity(
  organizationId: string,
  channelHandle: string
): ChannelIdentity {
  return {
    organizationId_externalChannelHandle: {
      organizationId,
      externalChannelHandle: channelHandle,
    },
  };
}

@Injectable()
export class PrismaBizzbloxChannelDirectory
  implements BizzbloxChannelDirectory
{
  constructor(
    @Inject(BIZZBLOX_CHANNEL_DATABASE)
    private readonly database: BizzbloxChannelDatabase
  ) {}

  async synchronize(
    organizationId: string,
    connectorRevision: number,
    candidates: readonly BizzbloxManagedChannelCandidate[]
  ) {
    return await this.database.$transaction(async (transaction) => {
      const rows: StoredChannel[] = [];
      for (const candidate of candidates) {
        rows.push(
          await transaction.bizzbloxChannel.upsert({
            where: {
              organizationId_integrationId: {
                organizationId,
                integrationId: candidate.integrationId,
              },
            },
            create: {
              organizationId,
              externalChannelHandle: candidate.channelHandle,
              connectorRevision,
              contractDigest: candidate.contractDigest,
              integrationId: candidate.integrationId,
              status: candidate.status,
            },
            update: {
              connectorRevision,
              contractDigest: candidate.contractDigest,
              status: candidate.status,
            },
          })
        );
      }
      await transaction.bizzbloxChannel.updateMany({
        where: {
          organizationId,
          ...(candidates.length
            ? {
                integrationId: {
                  notIn: candidates.map((candidate) => candidate.integrationId),
                },
              }
            : {}),
        },
        data: { status: 'disconnected' },
      });
      return Object.freeze(rows.map(record));
    });
  }

  async read(organizationId: string, channelHandle: string) {
    const row = await this.database.bizzbloxChannel.findUnique({
      where: identity(organizationId, channelHandle),
    });
    return row ? record(row) : null;
  }

  async updateContract(
    input: Parameters<BizzbloxChannelDirectory['updateContract']>[0]
  ) {
    const updated = await this.database.bizzbloxChannel.updateMany({
      where: {
        organizationId: input.organizationId,
        externalChannelHandle: input.channelHandle,
        connectorRevision: input.connectorRevision,
      },
      data: { contractDigest: input.contractDigest },
    });
    return updated.count === 1
      ? await this.read(input.organizationId, input.channelHandle)
      : null;
  }
}
