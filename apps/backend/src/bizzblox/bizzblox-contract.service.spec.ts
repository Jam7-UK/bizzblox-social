import { describe, expect, it, vi } from 'vitest';

import { createPostizAgentClient } from '@bizzblox/postiz-agent-client';
import { PublicIntegrationsController } from '../public-api/routes/v1/public.integrations.controller';
import { PrismaBizzbloxChannelDirectory } from './bizzblox-channel.directory';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import type {
  PostizAgentClient,
  ProviderContract,
} from '@bizzblox/postiz-agent-client';

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

function setup(contract: ProviderContract = linkedinContract) {
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
    getIntegrationSettings: vi.fn().mockResolvedValue(contract),
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
        settingsProjection: {
          providerSchema: { audience: { type: 'string' } },
          helpers: [
            {
              ref: 'bbx_help_choose_organization',
              label: 'Choose organization',
              description: 'Lists the organizations available to this account.',
              dataSchema: { type: 'object' },
            },
          ],
        },
        status: 'active',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('integration-linkedin-1');
    expect(JSON.stringify(result)).not.toContain('listOrganizations');
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

  it('normalizes the provider no-settings sentinel to an empty schema', async () => {
    const { service } = setup({
      ...linkedinContract,
      settings: 'No additional settings required',
    });

    const result = await service.listChannels('postiz-org-1', 7);

    expect(result.channels[0]?.settingsProjection.providerSchema).toEqual({});
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
  it('transports owner health through the public summary, real client decoder, directory and managed channel list', async () => {
    const unused = {} as never;
    const repository = new IntegrationRepository(
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused
    );
    const rows = [
      'ready',
      'recovering',
      'operator_required',
      'consent_required',
      'ready',
    ].map((healthState, index) => ({
      id: `channel-${index}`,
      name: `Channel ${index}`,
      providerIdentifier: 'test-provider',
      picture: null,
      disabled: index === 4,
      healthState,
      credentialGeneration: index,
      healthRevision: 100 + index,
      refreshNeeded: index === 2,
      token: 'private-token',
      refreshPendingAccess: 'private-pending',
      customer: null,
    }));
    vi.spyOn(repository, 'getIntegrationsList').mockResolvedValue(
      rows as never
    );
    const integrations = new IntegrationService(
      repository,
      unused,
      unused,
      unused,
      unused,
      unused
    );
    const controller = new PublicIntegrationsController(
      integrations,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused
    );
    const request = vi.fn(async ({ path }) => ({
      status: 200,
      body:
        path === '/public/v1/integrations'
          ? await controller.listIntegration({ id: 'org' } as never)
          : { output: linkedinContract },
    }));
    const client = createPostizAgentClient({
      transport: { request },
      credential: async () => ({
        apiKey: 'local',
        apiUrl: 'https://local.test',
      }),
      clock: () => new Date(),
    });
    const persisted = new Map<string, unknown>();
    const directory = new PrismaBizzbloxChannelDirectory({
      $transaction: async (fn) =>
        fn({
          bizzbloxChannel: {
            findUnique: async () => null,
            upsert: async ({ create, update }) => {
              const row = { ...create, ...update };
              persisted.set(row.integrationId, row);
              return row;
            },
            updateMany: async () => ({ count: 0 }),
          },
        }),
      bizzbloxChannel: {
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
      },
    });
    const refs = {
      channel: (_org, id) => `opaque-${id}`,
      helper: () => 'helper',
    };
    const service = new BizzbloxContractService(
      { forOrganization: async () => client },
      directory,
      refs
    );
    const result = await service.listChannels('org', 7);
    expect(result.channels.map((row) => [row.status, row.health])).toEqual([
      [
        'active',
        { version: 1, credentialGeneration: 0, revision: 100, state: 'ready' },
      ],
      [
        'disconnected',
        {
          version: 1,
          credentialGeneration: 1,
          revision: 101,
          state: 'recovering',
        },
      ],
      [
        'disconnected',
        {
          version: 1,
          credentialGeneration: 2,
          revision: 102,
          state: 'operator_required',
        },
      ],
      [
        'disconnected',
        {
          version: 1,
          credentialGeneration: 3,
          revision: 103,
          state: 'consent_required',
        },
      ],
      [
        'inactive',
        { version: 1, credentialGeneration: 4, revision: 104, state: 'ready' },
      ],
    ]);
    expect(persisted.size).toBe(5);
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it('rechecks the live owner before a helper despite a stale active directory', async () => {
    const { service, client } = setup();
    vi.mocked(client.listIntegrations).mockResolvedValue([
      {
        id: 'integration-linkedin-1',
        identifier: 'linkedin',
        name: 'Channel',
        picture: null,
        disabled: false,
        health: {
          version: 1,
          credentialGeneration: 1,
          revision: 2,
          state: 'operator_required',
        },
      },
    ]);
    await expect(
      service.executeHelper(
        'postiz-org-1',
        7,
        'bbx_ch_exact_linkedin',
        'bbx_help_choose_organization',
        {}
      )
    ).rejects.toThrow('temporarily unavailable');
    expect(client.triggerIntegrationTool).not.toHaveBeenCalled();
  });
});
