import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import {
  PrismaBizzbloxChannelDirectory,
  type BizzbloxChannelDatabase,
} from './bizzblox-channel.directory';

function row() {
  return {
    organizationId: 'postiz-org-1',
    externalChannelHandle: 'bbx_ch_exact_linkedin',
    connectorRevision: 7,
    contractDigest: `sha256:${'a'.repeat(64)}`,
    integrationId: 'integration-linkedin-1',
    status: 'active',
  };
}

describe('BizzBLOX exact-tenant channel directory', () => {
  it('synchronizes by exact organization and preserves the original opaque handle on update', async () => {
    const upsert = vi.fn().mockResolvedValue(row());
    const retire = vi.fn().mockResolvedValue({ count: 0 });
    const database = {
      $transaction: async (operation) =>
        await operation({
          bizzbloxChannel: {
            findUnique: async () => null,
            upsert,
            updateMany: retire,
          },
        }),
      bizzbloxChannel: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
    } as BizzbloxChannelDatabase;
    const directory = new PrismaBizzbloxChannelDirectory(database);

    await expect(
      directory.synchronize('postiz-org-1', 7, [
        {
          channelHandle: 'bbx_ch_exact_linkedin',
          connectorRevision: 7,
          contractDigest: `sha256:${'a'.repeat(64)}`,
          integrationId: 'integration-linkedin-1',
          status: 'active',
        },
      ])
    ).resolves.toEqual([
      {
        organizationId: 'postiz-org-1',
        channelHandle: 'bbx_ch_exact_linkedin',
        connectorRevision: 7,
        contractDigest: `sha256:${'a'.repeat(64)}`,
        integrationId: 'integration-linkedin-1',
        status: 'active',
      },
    ]);
    expect(upsert).toHaveBeenCalledWith({
      where: {
        organizationId_integrationId: {
          organizationId: 'postiz-org-1',
          integrationId: 'integration-linkedin-1',
        },
      },
      create: expect.objectContaining({
        organizationId: 'postiz-org-1',
        externalChannelHandle: 'bbx_ch_exact_linkedin',
      }),
      update: {
        connectorRevision: 7,
        contractDigest: `sha256:${'a'.repeat(64)}`,
        status: 'active',
      },
    });
    expect(upsert.mock.calls[0]?.[0].update).not.toHaveProperty(
      'externalChannelHandle'
    );
    expect(retire).toHaveBeenCalledWith({
      where: {
        organizationId: 'postiz-org-1',
        integrationId: { notIn: ['integration-linkedin-1'] },
      },
      data: { status: 'disconnected' },
    });
  });

  it('reads and refreshes a contract only through an exact tenant/channel fence', async () => {
    const findUnique = vi.fn().mockResolvedValue(row());
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = {
      $transaction: vi.fn(),
      bizzbloxChannel: { findUnique, updateMany },
    } as unknown as BizzbloxChannelDatabase;
    const directory = new PrismaBizzbloxChannelDirectory(database);

    await expect(
      directory.updateContract({
        organizationId: 'postiz-org-1',
        channelHandle: 'bbx_ch_exact_linkedin',
        connectorRevision: 7,
        contractDigest: `sha256:${'b'.repeat(64)}`,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        organizationId: 'postiz-org-1',
        channelHandle: 'bbx_ch_exact_linkedin',
      })
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'postiz-org-1',
        externalChannelHandle: 'bbx_ch_exact_linkedin',
        connectorRevision: 7,
      },
      data: { contractDigest: `sha256:${'b'.repeat(64)}` },
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_externalChannelHandle: {
          organizationId: 'postiz-org-1',
          externalChannelHandle: 'bbx_ch_exact_linkedin',
        },
      },
    });
  });

  it('marks a channel disconnected only through the exact tenant, handle, and revision', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      ...row(),
      status: 'disconnected',
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = {
      $transaction: vi.fn(),
      bizzbloxChannel: { findUnique, updateMany },
    } as unknown as BizzbloxChannelDatabase;
    const directory = new PrismaBizzbloxChannelDirectory(database);

    await expect(
      directory.markDisconnected({
        organizationId: 'postiz-org-1',
        channelHandle: 'bbx_ch_exact_linkedin',
        connectorRevision: 7,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        organizationId: 'postiz-org-1',
        channelHandle: 'bbx_ch_exact_linkedin',
        status: 'disconnected',
      })
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'postiz-org-1',
        externalChannelHandle: 'bbx_ch_exact_linkedin',
        connectorRevision: 7,
      },
      data: { status: 'disconnected' },
    });
  });
  it.each([
    {
      health: undefined,
      incomingStatus: 'active',
      previousStatus: 'disconnected',
      previousState: 'operator_required',
      expectedStatus: 'disconnected',
    },
    {
      health: {
        version: 1 as const,
        credentialGeneration: 1,
        revision: 4,
        state: 'ready' as const,
      },
      incomingStatus: 'active',
      previousStatus: 'disconnected',
      previousState: 'operator_required',
      expectedStatus: 'disconnected',
    },
    {
      health: {
        version: 1 as const,
        credentialGeneration: 1,
        revision: 4,
        state: 'ready' as const,
      },
      incomingStatus: 'inactive',
      previousStatus: 'active',
      previousState: 'ready',
      expectedStatus: 'active',
    },
    {
      health: undefined,
      incomingStatus: 'inactive',
      previousStatus: 'active',
      previousState: 'ready',
      expectedStatus: 'inactive',
    },
  ] as const)(
    'retains newer health while honoring explicit lifecycle: $expectedStatus',
    async ({
      health,
      incomingStatus,
      previousStatus,
      previousState,
      expectedStatus,
    }) => {
      const previous = {
        ...row(),
        status: previousStatus,
        health: {
          version: 1 as const,
          credentialGeneration: 2,
          revision: 5,
          state: previousState,
        },
      };
      const directory = new PrismaBizzbloxChannelDirectory({
        $transaction: async (fn) =>
          fn({
            bizzbloxChannel: {
              findUnique: async () => previous,
              upsert: async ({ update }) => ({ ...previous, ...update }),
              updateMany: async () => ({ count: 0 }),
            },
          }),
        bizzbloxChannel: {
          findUnique: async () => previous,
          updateMany: async () => ({ count: 0 }),
        },
      });
      const result = await directory.synchronize(previous.organizationId, 7, [
        {
          channelHandle: previous.externalChannelHandle,
          integrationId: previous.integrationId,
          connectorRevision: 7,
          contractDigest: previous.contractDigest,
          status: incomingStatus,
          health,
        },
      ]);
      expect(result[0]).toMatchObject({
        status: expectedStatus,
        health: previous.health,
      });
    }
  );

  it('retries a serialization conflict with a fresh read so newer health remains held', async () => {
    const previous = {
      ...row(),
      health: {
        version: 1 as const,
        credentialGeneration: 2,
        revision: 5,
        state: 'operator_required' as const,
      },
      status: 'disconnected',
    };
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(row())
      .mockResolvedValue(previous);
    const upsert = vi
      .fn()
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('serialization conflict', {
          code: 'P2034',
          clientVersion: '6.5.0',
        })
      )
      .mockImplementation(async ({ update }) => ({ ...previous, ...update }));
    const directory = new PrismaBizzbloxChannelDirectory({
      $transaction: async (fn) =>
        fn({
          bizzbloxChannel: {
            findUnique,
            upsert,
            updateMany: async () => ({ count: 0 }),
          },
        }),
      bizzbloxChannel: {
        findUnique: async () => previous,
        updateMany: async () => ({ count: 0 }),
      },
    });
    await expect(
      directory.synchronize(previous.organizationId, 7, [
        {
          channelHandle: previous.externalChannelHandle,
          integrationId: previous.integrationId,
          connectorRevision: 7,
          contractDigest: previous.contractDigest,
          status: 'active',
        },
      ])
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'disconnected',
        health: previous.health,
      }),
    ]);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['P2034', 5],
    ['P2002', 1],
  ] as const)(
    'bounds retries and propagates %s',
    async (code, expectedAttempts) => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'database refusal',
        { code, clientVersion: '6.5.0' }
      );
      const transaction = vi.fn().mockRejectedValue(error);
      const directory = new PrismaBizzbloxChannelDirectory({
        $transaction: transaction,
        bizzbloxChannel: {
          findUnique: async () => null,
          updateMany: async () => ({ count: 0 }),
        },
      });
      await expect(directory.synchronize('postiz-org-1', 7, [])).rejects.toBe(
        error
      );
      expect(transaction).toHaveBeenCalledTimes(expectedAttempts);
    }
  );
});
