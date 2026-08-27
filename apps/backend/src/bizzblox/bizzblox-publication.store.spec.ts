import { describe, expect, it, vi } from 'vitest';

import {
  PrismaBizzbloxChannelAccess,
  PrismaBizzbloxPublicationStore,
  type BizzbloxPublicationDatabase,
} from './bizzblox-publication.store';
import type { BizzbloxPublicationRecord } from './bizzblox-publications.service';

const candidate = {
  channelHandle: 'channel_opaque_linkedin_1',
  connectorRevision: 7,
  externalPublicationId: `bbx_social_${'a'.repeat(48)}`,
  organizationId: 'postiz-org-1',
  payloadDigest: 'sha256:payload-1',
  remoteGroupId: 'group-stable-1',
  remotePostIds: ['post-stable-1'],
} as const;

const stored: Omit<BizzbloxPublicationRecord, 'providerPublishedAt'> & {
  providerPublishedAt: Date | null;
} = {
  ...candidate,
  state: 'submitting' as const,
  providerErrorCode: null,
  providerErrorMessage: null,
  providerPublishedAt: null,
  publicUrl: null,
  safeResponseDigest: null,
};

function database(
  overrides: Partial<BizzbloxPublicationDatabase> = {}
): BizzbloxPublicationDatabase {
  return {
    bizzbloxPublication: {
      create: vi.fn().mockResolvedValue(stored),
      findUnique: vi.fn().mockResolvedValue(stored),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    bizzbloxChannel: {
      findUnique: vi.fn().mockResolvedValue({
        organizationId: candidate.organizationId,
        externalChannelHandle: candidate.channelHandle,
        connectorRevision: candidate.connectorRevision,
        contractDigest: 'sha256:contract-1',
        integrationId: 'integration-linkedin-1',
        status: 'active',
      }),
    },
    ...overrides,
  };
}

describe('Prisma BizzBLOX publication boundary', () => {
  it('converts a concurrent unique insert into exact idempotent replay', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002' });
    const findUnique = vi.fn().mockResolvedValue(stored);
    const store = new PrismaBizzbloxPublicationStore(
      database({
        bizzbloxPublication: {
          create,
          findUnique,
          updateMany: vi.fn(),
        },
      })
    );

    await expect(store.reserve(candidate)).resolves.toMatchObject({
      outcome: 'existing',
      record: { externalPublicationId: candidate.externalPublicationId },
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_externalPublicationId: {
          organizationId: candidate.organizationId,
          externalPublicationId: candidate.externalPublicationId,
        },
      },
    });
  });

  it('reports a payload conflict under the same organization publication key', async () => {
    const store = new PrismaBizzbloxPublicationStore(
      database({
        bizzbloxPublication: {
          create: vi.fn().mockRejectedValue({ code: 'P2002' }),
          findUnique: vi.fn().mockResolvedValue({
            ...stored,
            payloadDigest: 'sha256:different',
          }),
          updateMany: vi.fn(),
        },
      })
    );

    await expect(store.reserve(candidate)).resolves.toMatchObject({
      outcome: 'conflict',
    });
  });

  it('resolves a channel only through the exact organization and revision', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        organizationId: candidate.organizationId,
        externalChannelHandle: candidate.channelHandle,
        connectorRevision: candidate.connectorRevision,
        contractDigest: 'sha256:contract-1',
        integrationId: 'integration-linkedin-1',
        status: 'active',
      })
      .mockResolvedValueOnce({
        organizationId: candidate.organizationId,
        externalChannelHandle: candidate.channelHandle,
        connectorRevision: candidate.connectorRevision,
        contractDigest: 'sha256:contract-1',
        integrationId: 'integration-linkedin-1',
        status: 'inactive',
      });
    const access = new PrismaBizzbloxChannelAccess(
      database({ bizzbloxChannel: { findUnique } })
    );

    await expect(
      access.resolve(
        candidate.organizationId,
        candidate.channelHandle,
        candidate.connectorRevision
      )
    ).resolves.toMatchObject({
      integrationId: 'integration-linkedin-1',
      organizationId: candidate.organizationId,
    });
    await expect(
      access.resolve(
        candidate.organizationId,
        candidate.channelHandle,
        candidate.connectorRevision
      )
    ).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_externalChannelHandle: {
          organizationId: candidate.organizationId,
          externalChannelHandle: candidate.channelHandle,
        },
      },
    });
  });
});
