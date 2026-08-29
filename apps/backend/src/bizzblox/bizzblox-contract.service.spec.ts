import { describe, expect, it, vi } from 'vitest';

import type { PostizAgentClient } from '@bizzblox/postiz-agent-client';

import {
  BizzbloxContractService,
  type BizzbloxChannelDirectory,
  type BizzbloxManagedChannelCandidate,
  type BizzbloxOpaqueRefs,
} from './bizzblox-contract.service';

const linkedinContract = Object.freeze({
  rules: 'Keep the post clear.',
  maxLength: 3000,
  settings: { audience: { type: 'string' } },
  tools: Object.freeze([
    {
      methodName: 'listOrganizations',
      label: 'Choose organization',
      description: 'Lists the organizations available to this account.',
      dataSchema: { type: 'object' },
    },
  ]),
});

function setup() {
  const client = {
    listIntegrations: vi.fn().mockResolvedValue([
      {
        id: 'integration-linkedin-1',
        identifier: 'linkedin-page',
        name: 'Jam 7',
        picture: 'https://cdn.example.test/jam7.png',
        disabled: false,
      },
    ]),
    getIntegrationSettings: vi.fn().mockResolvedValue(linkedinContract),
    triggerIntegrationTool: vi.fn().mockResolvedValue({
      organizations: [{ id: 'provider-page-1', name: 'Jam 7' }],
      access_token: 'must-never-leak',
      sessionToken: 'must-never-leak-either',
      nested: { clientSecret: 'also-private', jwt: 'private-jwt' },
    }),
  } as unknown as PostizAgentClient;
  const stored = {
    organizationId: 'postiz-org-1',
    channelHandle: 'bbx_ch_exact_linkedin',
    connectorRevision: 7,
    contractDigest: '',
    integrationId: 'integration-linkedin-1',
    status: 'active' as const,
  };
  const directory: BizzbloxChannelDirectory = {
    synchronize: vi.fn(
      async (
        _organizationId,
        _revision,
        candidates: readonly BizzbloxManagedChannelCandidate[]
      ) =>
        candidates.map((candidate) => ({
          ...stored,
          channelHandle: candidate.channelHandle,
          connectorRevision: candidate.connectorRevision,
          contractDigest: candidate.contractDigest,
          integrationId: candidate.integrationId,
          status: candidate.status,
        }))
    ),
    read: vi.fn().mockResolvedValue(stored),
    markDisconnected: vi.fn(),
    updateContract: vi.fn(async (input) => ({
      ...stored,
      connectorRevision: input.connectorRevision,
      contractDigest: input.contractDigest,
    })),
  };
  const refs: BizzbloxOpaqueRefs = {
    channel: vi.fn().mockReturnValue('bbx_ch_exact_linkedin'),
    helper: vi.fn().mockReturnValue('bbx_help_choose_organization'),
  };
  return {
    client,
    directory,
    refs,
    service: new BizzbloxContractService(
      { forOrganization: vi.fn().mockResolvedValue(client) },
      directory,
      refs
    ),
  };
}

describe('BizzBLOX live social contracts', () => {
  it('synchronizes live channels into opaque exact-tenant handles', async () => {
    const { directory, service } = setup();

    const result = await service.listChannels('postiz-org-1', 7);

    expect(result.channels).toEqual([
      expect.objectContaining({
        channelHandle: 'bbx_ch_exact_linkedin',
        connectorRevision: 7,
        displayName: 'Jam 7',
        provider: 'linkedin-page',
        status: 'active',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('integration-linkedin-1');
    expect(directory.synchronize).toHaveBeenCalledWith('postiz-org-1', 7, [
      expect.objectContaining({
        channelHandle: 'bbx_ch_exact_linkedin',
        integrationId: 'integration-linkedin-1',
        status: 'active',
      }),
    ]);
  });

  it('returns the current provider contract with opaque helper references', async () => {
    const { directory, service } = setup();

    const result = await service.readContract(
      'postiz-org-1',
      7,
      'bbx_ch_exact_linkedin'
    );

    expect(result).toEqual(
      expect.objectContaining({
        channelHandle: 'bbx_ch_exact_linkedin',
        contractDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        maxLength: 3000,
        rules: 'Keep the post clear.',
        helpers: [
          {
            helperRef: 'bbx_help_choose_organization',
            label: 'Choose organization',
            description: 'Lists the organizations available to this account.',
            dataSchema: { type: 'object' },
          },
        ],
      })
    );
    expect(JSON.stringify(result)).not.toContain('listOrganizations');
    expect(directory.updateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'postiz-org-1',
        channelHandle: 'bbx_ch_exact_linkedin',
        connectorRevision: 7,
      })
    );
  });

  it('executes only a helper from the current contract and scrubs secret-shaped output', async () => {
    const { client, service } = setup();

    const result = await service.executeHelper(
      'postiz-org-1',
      7,
      'bbx_ch_exact_linkedin',
      'bbx_help_choose_organization',
      { query: 'jam' }
    );

    expect(client.triggerIntegrationTool).toHaveBeenCalledWith({
      integrationId: 'integration-linkedin-1',
      methodName: 'listOrganizations',
      data: { query: 'jam' },
    });
    expect(result).toEqual({
      output: {
        organizations: [{ id: 'provider-page-1', name: 'Jam 7' }],
        access_token: '[redacted]',
        sessionToken: '[redacted]',
        nested: { clientSecret: '[redacted]', jwt: '[redacted]' },
      },
    });
  });

  it('rejects stale revisions, foreign channels, and invented helper references', async () => {
    const { directory, service } = setup();
    vi.mocked(directory.read)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        organizationId: 'postiz-org-1',
        channelHandle: 'bbx_ch_exact_linkedin',
        connectorRevision: 6,
        contractDigest: 'sha256:old',
        integrationId: 'integration-linkedin-1',
        status: 'active',
      });

    await expect(
      service.readContract('postiz-org-2', 7, 'bbx_ch_exact_linkedin')
    ).rejects.toThrow(/channel/i);
    await expect(
      service.readContract('postiz-org-1', 7, 'bbx_ch_exact_linkedin')
    ).rejects.toThrow(/stale/i);
    await expect(
      setup().service.executeHelper(
        'postiz-org-1',
        7,
        'bbx_ch_exact_linkedin',
        'bbx_help_invented',
        {}
      )
    ).rejects.toThrow(/helper/i);
  });
});
