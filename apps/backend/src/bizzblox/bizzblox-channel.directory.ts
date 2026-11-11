import {
  decodeChannelHealth,
  type ChannelHealthV1,
} from '@bizzblox/postiz-agent-client';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
  health?: unknown;
}>;

type ChannelIdentity = Readonly<{
  organizationId_externalChannelHandle: Readonly<{
    organizationId: string;
    externalChannelHandle: string;
  }>;
}>;

interface BizzbloxChannelTransaction {
  bizzbloxChannel: Readonly<{
    findUnique(input: {
      where: {
        organizationId_integrationId: {
          organizationId: string;
          integrationId: string;
        };
      };
    }): Promise<StoredChannel | null>;
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
        health?: ChannelHealthV1;
      }>;
      update: Readonly<{
        connectorRevision: number;
        contractDigest: string;
        status: BizzbloxManagedChannelStatus;
        health?: ChannelHealthV1;
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
    operation: (transaction: BizzbloxChannelTransaction) => Promise<T>,
    options?: { isolationLevel: 'Serializable' }
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
      data: Readonly<{
        contractDigest?: string;
        status?: 'disconnected';
      }>;
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
    ...(row.health == null ? {} : { health: decodeChannelHealth(row.health) }),
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
    const synchronize = async (transaction: BizzbloxChannelTransaction) => {
      const rows: StoredChannel[] = [];
      for (const candidate of candidates) {
        const previous = await transaction.bizzbloxChannel.findUnique({
          where: {
            organizationId_integrationId: {
              organizationId,
              integrationId: candidate.integrationId,
            },
          },
        });
        const previousHealth =
          previous?.health == null
            ? undefined
            : decodeChannelHealth(previous.health);
        const stale =
          previousHealth &&
          (!candidate.health ||
            candidate.health.revision < previousHealth.revision);
        const nextHealth = stale ? previousHealth : candidate.health;
        const nextStatus =
          candidate.status === 'inactive' && !candidate.health
            ? 'inactive'
            : stale
            ? status(previous!.status)
            : candidate.status;
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
              status: nextStatus,
              ...(nextHealth ? { health: nextHealth } : {}),
            },
            update: {
              connectorRevision,
              contractDigest: candidate.contractDigest,
              status: nextStatus,
              ...(nextHealth ? { health: nextHealth } : {}),
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
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.database.$transaction(synchronize, {
          isolationLevel: 'Serializable',
        });
      } catch (error) {
        if (
          attempt < 4 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034'
        )
          continue;
        throw error;
      }
    }
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

  async markDisconnected(
    input: Parameters<BizzbloxChannelDirectory['markDisconnected']>[0]
  ) {
    const updated = await this.database.bizzbloxChannel.updateMany({
      where: {
        organizationId: input.organizationId,
        externalChannelHandle: input.channelHandle,
        connectorRevision: input.connectorRevision,
      },
      data: { status: 'disconnected' },
    });
    return updated.count === 1
      ? await this.read(input.organizationId, input.channelHandle)
      : null;
  }
}
