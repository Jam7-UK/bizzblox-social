import { describe, expect, it, vi } from 'vitest';

import type { PostizAgentClient } from '@bizzblox/postiz-agent-client';

import {
  BizzbloxPublicationsService,
  type BizzbloxChannelRecord,
  type BizzbloxPublicationRecord,
  type BizzbloxPublicationStore,
} from './bizzblox-publications.service';

const ORGANIZATION_ID = 'postiz-org-1';
const EXTERNAL_PUBLICATION_ID = `bbx_social_${'a'.repeat(48)}`;
const CHANNEL: BizzbloxChannelRecord = {
  channelHandle: 'channel_opaque_linkedin_1',
  connectorRevision: 7,
  contractDigest:
    'sha256:3a7ab069ebaee7c235978a28398896dc8e8f7ce319e09b8c6707a31b327c6ef7',
  integrationId: 'integration-linkedin-1',
  organizationId: ORGANIZATION_ID,
};

const request = {
  document: {
    sourceCardId: 'card-1',
    sourceVersion: 3,
    title: 'Launch day',
    defaultSegments: [
      { text: 'Launch day', media: [] },
      { text: 'The follow-up', media: [] },
    ],
    destinationOverrides: [],
    primaryLink: 'https://example.com/launch',
    trackingParameters: [{ key: 'utm_source', value: 'linkedin' }],
    scheduledForUtc: Date.parse('2026-09-01T09:30:00.000Z'),
    displayTimezone: 'Europe/London',
    contentDigest: 'sha256:approved-content',
  },
  delivery: {
    deliveryId: 'delivery-1',
    deliveryVersion: 1,
    channelHandle: CHANNEL.channelHandle,
    contractDigest: CHANNEL.contractDigest,
    externalPublicationId: EXTERNAL_PUBLICATION_ID,
    required: true,
  },
} as const;

function client(overrides: Partial<PostizAgentClient> = {}): PostizAgentClient {
  return {
    listIntegrations: vi.fn(),
    getIntegrationSettings: vi.fn().mockResolvedValue({
      rules: '',
      maxLength: 3000,
      settings: {},
      tools: [],
    }),
    triggerIntegrationTool: vi.fn(),
    upload: vi.fn(),
    validatePost: vi.fn().mockResolvedValue([
      {
        identifier: 'linkedin',
        name: 'LinkedIn',
        emptyContent: false,
        valid: true,
        errors: true,
        tooLong: false,
      },
    ]),
    createPost: vi
      .fn()
      .mockResolvedValue([
        { postId: 'post-stable-1', integration: CHANNEL.integrationId },
      ]),
    listPosts: vi.fn(),
    readPost: vi.fn().mockResolvedValue({
      group: 'group-stable-1',
      posts: [
        {
          id: 'post-stable-1',
          state: 'QUEUE',
          releaseURL: null,
        },
      ],
    }),
    changePostStatus: vi.fn(),
    deletePost: vi.fn(),
    getPostAnalytics: vi.fn().mockResolvedValue([
      {
        label: 'Impressions',
        data: [
          { total: '20', date: '2026-08-26' },
          { total: '22', date: '2026-08-27' },
        ],
        percentageChange: 10,
      },
      {
        label: 'Likes',
        data: [{ total: '8', date: '2026-08-27' }],
        percentageChange: 0,
      },
    ]),
    ...overrides,
  };
}

function memoryStore() {
  const rows = new Map<string, BizzbloxPublicationRecord>();
  const key = (organizationId: string, externalPublicationId: string) =>
    `${organizationId}:${externalPublicationId}`;
  const store: BizzbloxPublicationStore = {
    reserve: vi.fn(async (candidate) => {
      const identity = key(
        candidate.organizationId,
        candidate.externalPublicationId
      );
      const existing = rows.get(identity);
      if (existing) {
        return existing.payloadDigest === candidate.payloadDigest
          ? { outcome: 'existing' as const, record: existing }
          : { outcome: 'conflict' as const, record: existing };
      }
      const record: BizzbloxPublicationRecord = {
        ...candidate,
        state: 'submitting',
        providerErrorCode: null,
        providerErrorMessage: null,
        publicUrl: null,
        providerPublishedAt: null,
        safeResponseDigest: null,
      };
      rows.set(identity, record);
      return { outcome: 'created' as const, record };
    }),
    read: vi.fn(
      async (organizationId, externalPublicationId) =>
        rows.get(key(organizationId, externalPublicationId)) ?? null
    ),
    transition: vi.fn(async (input) => {
      const identity = key(input.organizationId, input.externalPublicationId);
      const existing = rows.get(identity);
      if (!existing || existing.payloadDigest !== input.payloadDigest)
        return null;
      const updated = { ...existing, ...input.patch };
      rows.set(identity, updated);
      return updated;
    }),
  };
  return { rows, store };
}

function service(input?: {
  agent?: PostizAgentClient;
  store?: BizzbloxPublicationStore;
}) {
  const agent = input?.agent ?? client();
  const memory = input?.store ? null : memoryStore();
  const store = input?.store ?? memory!.store;
  return {
    agent,
    memory,
    service: new BizzbloxPublicationsService(
      store,
      {
        resolve: vi.fn(
          async (organizationId, channelHandle, connectorRevision) =>
            organizationId === ORGANIZATION_ID &&
            channelHandle === CHANNEL.channelHandle &&
            connectorRevision === CHANNEL.connectorRevision
              ? CHANNEL
              : null
        ),
      },
      { forOrganization: vi.fn(async () => agent) },
      {
        randomId: vi
          .fn()
          .mockReturnValueOnce('group-stable-1')
          .mockReturnValueOnce('post-stable-1')
          .mockReturnValueOnce('post-stable-2'),
      }
    ),
  };
}

describe('BizzBLOX publication service', () => {
  it('validates through the same Postiz path without reserving a publication', async () => {
    const setup = service();

    await expect(
      setup.service.validate(ORGANIZATION_ID, 7, request)
    ).resolves.toEqual({ ok: true });
    expect(setup.agent.validatePost).toHaveBeenCalledOnce();
    expect(setup.agent.getIntegrationSettings).toHaveBeenCalledWith(
      CHANNEL.integrationId
    );
    expect(setup.memory!.store.reserve).not.toHaveBeenCalled();
    expect(setup.agent.createPost).not.toHaveBeenCalled();
  });

  it('rejects a stale live provider contract before reserving or creating', async () => {
    const setup = service({
      agent: client({
        getIntegrationSettings: vi.fn().mockResolvedValue({
          rules: 'Provider changed its contract.',
          maxLength: 3000,
          settings: {},
          tools: [],
        }),
      }),
    });

    await expect(
      setup.service.schedule(ORGANIZATION_ID, 7, request)
    ).resolves.toEqual({
      outcome: 'rejected',
      code: 'validation_rejected',
      message: 'Publication channel contract changed.',
    });
    expect(setup.memory!.store.reserve).not.toHaveBeenCalled();
    expect(setup.agent.createPost).not.toHaveBeenCalled();
  });

  it('keeps a transient contract-read failure retryable and writes no terminal state', async () => {
    const setup = service({
      agent: client({
        getIntegrationSettings: vi
          .fn()
          .mockRejectedValue(new Error('service unavailable')),
      }),
    });

    await expect(
      setup.service.validate(ORGANIZATION_ID, 7, request)
    ).rejects.toThrow(/unavailable/i);
    expect(setup.memory!.store.reserve).not.toHaveBeenCalled();
    expect(setup.agent.createPost).not.toHaveBeenCalled();
  });

  it('schedules an ordered thread once and replays the exact accepted result', async () => {
    const setup = service();

    await expect(
      setup.service.schedule(ORGANIZATION_ID, 7, request)
    ).resolves.toMatchObject({
      outcome: 'accepted',
      remotePublicationId: 'post-stable-1',
    });
    await expect(
      setup.service.schedule(ORGANIZATION_ID, 7, request)
    ).resolves.toMatchObject({
      outcome: 'accepted',
      remotePublicationId: 'post-stable-1',
    });

    expect(setup.agent.createPost).toHaveBeenCalledOnce();
    expect(setup.agent.createPost).toHaveBeenCalledWith({
      type: 'schedule',
      date: '2026-09-01T09:30:00.000Z',
      idempotencyKey: EXTERNAL_PUBLICATION_ID,
      shortLink: true,
      tags: [],
      posts: [
        {
          group: 'group-stable-1',
          integration: { id: CHANNEL.integrationId },
          settings: {},
          value: [
            { id: 'post-stable-1', content: 'Launch day', image: [] },
            { id: 'post-stable-2', content: 'The follow-up', image: [] },
          ],
        },
      ],
    });
  });

  it('rejects a changed payload under the same exact publication id', async () => {
    const setup = service();
    await setup.service.schedule(ORGANIZATION_ID, 7, request);

    await expect(
      setup.service.schedule(ORGANIZATION_ID, 7, {
        ...request,
        document: { ...request.document, title: 'Changed after approval' },
      })
    ).resolves.toEqual({
      outcome: 'rejected',
      code: 'idempotency_conflict',
      message: 'Publication identity is already bound to different content.',
    });
    expect(setup.agent.createPost).toHaveBeenCalledOnce();
  });

  it('returns reconciliation state after an ambiguous create without retrying remotely', async () => {
    const failingClient = client({
      createPost: vi
        .fn()
        .mockRejectedValue(new Error('tenant-secret provider body')),
    });
    const setup = service({ agent: failingClient });

    await expect(
      setup.service.schedule(ORGANIZATION_ID, 7, request)
    ).resolves.toEqual({ outcome: 'unknown' });
    await expect(
      setup.service.schedule(ORGANIZATION_ID, 7, request)
    ).resolves.toEqual({ outcome: 'unknown' });
    expect(failingClient.createPost).toHaveBeenCalledOnce();
    expect(JSON.stringify([...setup.memory!.rows.values()])).not.toContain(
      'tenant-secret'
    );
  });

  it('reads the stable Postiz id directly and never scans a date range', async () => {
    const setup = service();
    await setup.service.schedule(ORGANIZATION_ID, 7, request);

    await expect(
      setup.service.read(
        ORGANIZATION_ID,
        7,
        request.delivery.externalPublicationId
      )
    ).resolves.toMatchObject({
      state: 'scheduled',
      remotePublicationId: 'post-stable-1',
    });
    expect(setup.agent.readPost).toHaveBeenCalledWith({ id: 'post-stable-1' });
    expect(setup.agent.listPosts).not.toHaveBeenCalled();
  });

  it('projects supported analytics and treats provider absence as unavailable', async () => {
    const setup = service();
    await setup.service.schedule(ORGANIZATION_ID, 7, request);
    await expect(
      setup.service.analytics(
        ORGANIZATION_ID,
        7,
        request.delivery.externalPublicationId
      )
    ).resolves.toEqual({
      metrics: { impressions: 42, reactions: 8 },
    });

    const unavailable = service({
      agent: client({
        getPostAnalytics: vi.fn().mockRejectedValue(new Error('not supported')),
      }),
    });
    await unavailable.service.schedule(ORGANIZATION_ID, 7, request);
    await expect(
      unavailable.service.analytics(
        ORGANIZATION_ID,
        7,
        request.delivery.externalPublicationId
      )
    ).resolves.toEqual({ metrics: {}, unavailable: true });
  });
});
