import { describe, expect, it, vi } from 'vitest';

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
        await operation({ bizzbloxChannel: { upsert, updateMany: retire } }),
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
});
