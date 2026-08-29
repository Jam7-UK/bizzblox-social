import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  PostizAgentError,
  type PostizAgentClient,
} from '@bizzblox/postiz-agent-client';

import {
  BizzbloxPublicationsService,
  type BizzbloxChannelRecord,
  type BizzbloxPublicationRecord,
  type BizzbloxPublicationStore,
  type BizzbloxMediaStore,
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
  media?: BizzbloxMediaStore;
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
      input?.media ?? {
        reserve: vi.fn(),
        resolve: vi.fn().mockResolvedValue([]),
      },
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
  it('uploads checksum-bound media once and schedules only its exact tenant handle', async () => {
    const checksumSha256 =
      '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
    const handle = `bbx_media_${'a'.repeat(48)}`;
    const media: BizzbloxMediaStore = {
      reserve: vi.fn().mockResolvedValue({
        outcome: 'created',
        record: {
          organizationId: ORGANIZATION_ID,
          externalMediaId: handle,
          checksumSha256,
          postizMediaId: 'postiz-media-1',
          postizMediaPath: 'https://media.example.test/object.png',
        },
      }),
      resolve: vi.fn().mockResolvedValue([
        {
          organizationId: ORGANIZATION_ID,
          externalMediaId: handle,
          checksumSha256,
          postizMediaId: 'postiz-media-1',
          postizMediaPath: 'https://media.example.test/object.png',
        },
      ]),
    };
    const agent = client({
      upload: vi.fn().mockResolvedValue({
        id: 'postiz-media-1',
        name: 'object.png',
        path: 'https://media.example.test/object.png',
      }),
    });
    const setup = service({ agent, media });

    await expect(
      setup.service.uploadMedia(ORGANIZATION_ID, {
        externalMediaId: handle,
        checksumSha256,
        contentType: 'image/png',
        bytes: new Uint8Array([1, 2, 3, 4]),
      })
    ).resolves.toEqual({ mediaHandle: handle, checksumSha256 });
    await setup.service.schedule(ORGANIZATION_ID, 7, {
      ...request,
      document: {
        ...request.document,
        defaultSegments: [
          {
            text: 'Launch day',
            media: [{ mediaHandle: handle, checksumSha256 }],
          },
        ],
      },
    });

    expect(agent.createPost).toHaveBeenCalledWith(
      expect.objectContaining({
        posts: [
          expect.objectContaining({
            value: [
              expect.objectContaining({
                image: [
                  {
                    id: 'postiz-media-1',
                    path: 'https://media.example.test/object.png',
                  },
                ],
              }),
            ],
          }),
        ],
      })
    );
  });

  it('rejects media above the API Gateway payload boundary before provider upload', async () => {
    const agent = client();
    const setup = service({ agent });
    const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    await expect(
      setup.service.uploadMedia('org-1', {
        externalMediaId: `bbx_media_${'a'.repeat(48)}`,
        checksumSha256,
        contentType: 'video/mp4',
        bytes,
      })
    ).rejects.toThrow('Invalid social media upload.');
    expect(agent.upload).not.toHaveBeenCalled();
  });
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

  it('cancels an unpublished group only after exact absence readback', async () => {
    const agent = client({
      deletePost: vi.fn().mockResolvedValue({ deleted: true }),
      readPost: vi
        .fn()
        .mockRejectedValue(
          new PostizAgentError('provider_rejected', 404, 'Not found')
        ),
    });
    const setup = service({ agent });
    await setup.service.schedule(ORGANIZATION_ID, 7, request);

    await expect(
      setup.service.cancel(ORGANIZATION_ID, 7, EXTERNAL_PUBLICATION_ID)
    ).resolves.toEqual({ outcome: 'cancelled' });
    await expect(
      setup.service.cancel(ORGANIZATION_ID, 7, EXTERNAL_PUBLICATION_ID)
    ).resolves.toEqual({ outcome: 'cancelled' });
    expect(agent.deletePost).toHaveBeenCalledOnce();
    expect(agent.deletePost).toHaveBeenCalledWith({ id: 'post-stable-1' });
    expect(agent.readPost).toHaveBeenCalledWith({ id: 'post-stable-1' });
  });

  it('refuses to cancel a published post without calling the provider', async () => {
    const setup = service();
    await setup.service.schedule(ORGANIZATION_ID, 7, request);
    const identity = `${ORGANIZATION_ID}:${EXTERNAL_PUBLICATION_ID}`;
    const scheduled = setup.memory!.rows.get(identity)!;
    setup.memory!.rows.set(identity, { ...scheduled, state: 'published' });

    await expect(
      setup.service.cancel(ORGANIZATION_ID, 7, EXTERNAL_PUBLICATION_ID)
    ).resolves.toEqual({
      outcome: 'rejected',
      code: 'already_published',
      message: 'Published social content cannot be cancelled.',
    });
    expect(setup.agent.deletePost).not.toHaveBeenCalled();
  });

  it('reports reconciliation when provider cancellation cannot be proven', async () => {
    const agent = client({
      deletePost: vi.fn().mockResolvedValue({ deleted: true }),
      readPost: vi.fn().mockResolvedValue({
        group: 'group-stable-1',
        posts: [{ id: 'post-stable-1', state: 'QUEUE' }],
      }),
    });
    const setup = service({ agent });
    await setup.service.schedule(ORGANIZATION_ID, 7, request);

    await expect(
      setup.service.cancel(ORGANIZATION_ID, 7, EXTERNAL_PUBLICATION_ID)
    ).resolves.toEqual({ outcome: 'reconcile_required' });
    expect(
      setup.memory!.rows.get(`${ORGANIZATION_ID}:${EXTERNAL_PUBLICATION_ID}`)
    ).toMatchObject({
      state: 'reconcile_required',
      providerErrorCode: 'cancellation_unconfirmed',
      providerErrorMessage: null,
    });
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
