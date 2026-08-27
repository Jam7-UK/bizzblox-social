import { Inject, Injectable } from '@nestjs/common';

import type {
  BizzbloxChannelAccess,
  BizzbloxChannelRecord,
  BizzbloxPublicationCandidate,
  BizzbloxPublicationRecord,
  BizzbloxPublicationStore,
} from './bizzblox-publications.service';

type StoredPublication = Omit<
  BizzbloxPublicationRecord,
  'providerPublishedAt' | 'state'
> & {
  providerPublishedAt: Date | null;
  state: string;
};

type PublicationIdentity = Readonly<{
  organizationId_externalPublicationId: Readonly<{
    organizationId: string;
    externalPublicationId: string;
  }>;
}>;

export interface BizzbloxPublicationDatabase {
  bizzbloxChannel: Readonly<{
    findUnique(input: {
      where: Readonly<{
        organizationId_externalChannelHandle: Readonly<{
          organizationId: string;
          externalChannelHandle: string;
        }>;
      }>;
    }): Promise<Readonly<{
      organizationId: string;
      externalChannelHandle: string;
      connectorRevision: number;
      contractDigest: string;
      integrationId: string;
      status: string;
    }> | null>;
  }>;
  bizzbloxPublication: Readonly<{
    create(input: {
      data: BizzbloxPublicationCandidate & Readonly<{ state: 'submitting' }>;
    }): Promise<StoredPublication>;
    findUnique(input: {
      where: PublicationIdentity;
    }): Promise<StoredPublication | null>;
    updateMany(input: {
      where: Readonly<{
        organizationId: string;
        externalPublicationId: string;
        payloadDigest: string;
      }>;
      data: Readonly<Record<string, unknown>>;
    }): Promise<Readonly<{ count: number }>>;
  }>;
}

export const BIZZBLOX_PUBLICATION_DATABASE = Symbol(
  'BIZZBLOX_PUBLICATION_DATABASE'
);

function record(row: StoredPublication): BizzbloxPublicationRecord {
  const state = new Set<BizzbloxPublicationRecord['state']>([
    'submitting',
    'scheduled',
    'publishing',
    'published',
    'failed',
    'rejected',
    'reconnect_required',
    'reconcile_required',
    'cancelled',
  ]).has(row.state as BizzbloxPublicationRecord['state'])
    ? (row.state as BizzbloxPublicationRecord['state'])
    : 'reconcile_required';
  return Object.freeze({
    channelHandle: row.channelHandle,
    connectorRevision: row.connectorRevision,
    externalPublicationId: row.externalPublicationId,
    organizationId: row.organizationId,
    payloadDigest: row.payloadDigest,
    providerErrorCode: row.providerErrorCode,
    providerErrorMessage: row.providerErrorMessage,
    providerPublishedAt: row.providerPublishedAt?.getTime() ?? null,
    publicUrl: row.publicUrl,
    remoteGroupId: row.remoteGroupId,
    remotePostIds: Object.freeze([...row.remotePostIds]),
    safeResponseDigest: row.safeResponseDigest,
    state,
  });
}

function identity(
  organizationId: string,
  externalPublicationId: string
): PublicationIdentity {
  return {
    organizationId_externalPublicationId: {
      organizationId,
      externalPublicationId,
    },
  };
}

function uniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class PrismaBizzbloxPublicationStore
  implements BizzbloxPublicationStore
{
  constructor(
    @Inject(BIZZBLOX_PUBLICATION_DATABASE)
    private readonly database: BizzbloxPublicationDatabase
  ) {}

  async reserve(candidate: BizzbloxPublicationCandidate) {
    try {
      const created = await this.database.bizzbloxPublication.create({
        data: { ...candidate, state: 'submitting' },
      });
      return Object.freeze({
        outcome: 'created' as const,
        record: record(created),
      });
    } catch (error) {
      if (!uniqueConstraint(error)) throw error;
      const existing = await this.database.bizzbloxPublication.findUnique({
        where: identity(
          candidate.organizationId,
          candidate.externalPublicationId
        ),
      });
      if (!existing) throw error;
      return Object.freeze({
        outcome:
          existing.payloadDigest === candidate.payloadDigest
            ? ('existing' as const)
            : ('conflict' as const),
        record: record(existing),
      });
    }
  }

  async read(organizationId: string, externalPublicationId: string) {
    const row = await this.database.bizzbloxPublication.findUnique({
      where: identity(organizationId, externalPublicationId),
    });
    return row ? record(row) : null;
  }

  async transition(
    input: Parameters<BizzbloxPublicationStore['transition']>[0]
  ) {
    const patch = {
      ...input.patch,
      ...(input.patch.providerPublishedAt !== undefined
        ? {
            providerPublishedAt:
              input.patch.providerPublishedAt === null
                ? null
                : new Date(input.patch.providerPublishedAt),
          }
        : {}),
    };
    const updated = await this.database.bizzbloxPublication.updateMany({
      where: {
        organizationId: input.organizationId,
        externalPublicationId: input.externalPublicationId,
        payloadDigest: input.payloadDigest,
      },
      data: patch,
    });
    if (updated.count !== 1) return null;
    return await this.read(input.organizationId, input.externalPublicationId);
  }
}

@Injectable()
export class PrismaBizzbloxChannelAccess implements BizzbloxChannelAccess {
  constructor(
    @Inject(BIZZBLOX_PUBLICATION_DATABASE)
    private readonly database: BizzbloxPublicationDatabase
  ) {}

  async resolve(
    organizationId: string,
    channelHandle: string,
    connectorRevision: number
  ): Promise<BizzbloxChannelRecord | null> {
    const row = await this.database.bizzbloxChannel.findUnique({
      where: {
        organizationId_externalChannelHandle: {
          organizationId,
          externalChannelHandle: channelHandle,
        },
      },
    });
    if (
      !row ||
      row.status !== 'active' ||
      row.connectorRevision !== connectorRevision
    ) {
      return null;
    }
    return Object.freeze({
      channelHandle: row.externalChannelHandle,
      connectorRevision: row.connectorRevision,
      contractDigest: row.contractDigest,
      integrationId: row.integrationId,
      organizationId: row.organizationId,
    });
  }
}
