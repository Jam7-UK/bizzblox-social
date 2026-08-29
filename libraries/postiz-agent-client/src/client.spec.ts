import { describe, expect, it, vi } from 'vitest';

import {
  createPostizAgentClient,
  PostizAgentError,
  type PostizAgentTransport,
} from './index';

describe('Postiz Agent client', () => {
  it('is inert at construction and never reads process state, logs, or exits', () => {
    const credential = vi.fn(async () => ({
      apiKey: 'tenant-secret',
      apiUrl: 'https://api.social.example.test',
    }));
    const request = vi.fn();
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called');
    }) as never);
    const originalEnvironment = process.env;
    const originalArguments = process.argv;

    try {
      process.env = new Proxy(originalEnvironment, {
        get() {
          throw new Error('process.env must not be read');
        },
      });
      process.argv = new Proxy(originalArguments, {
        get() {
          throw new Error('process.argv must not be read');
        },
      });

      expect(
        createPostizAgentClient({
          transport: { request },
          credential,
          clock: () => new Date('2026-08-27T19:30:00.000Z'),
        })
      ).toBeDefined();
    } finally {
      process.env = originalEnvironment;
      process.argv = originalArguments;
      exit.mockRestore();
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }

    expect(credential).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('discovers integrations through the injected credential and transport', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: [
        {
          id: 'integration-linkedin-1',
          identifier: 'linkedin',
          name: 'Jam 7',
          picture: 'https://cdn.example.test/jam7.png',
          disabled: false,
        },
      ],
    });
    const transport: PostizAgentTransport = { request };
    const client = createPostizAgentClient({
      transport,
      credential: async () => ({
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      }),
      clock: () => new Date('2026-08-27T19:30:00.000Z'),
    });

    await expect(client.listIntegrations()).resolves.toEqual([
      {
        id: 'integration-linkedin-1',
        identifier: 'linkedin',
        name: 'Jam 7',
        picture: 'https://cdn.example.test/jam7.png',
        disabled: false,
      },
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      credential: {
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      },
      method: 'GET',
      path: '/public/v1/integrations',
    });
  });

  it('reads the live provider contract and invokes only the requested helper', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: {
          output: {
            rules: 'Choose one LinkedIn visibility.',
            maxLength: 3000,
            settings: {
              visibility: { type: 'string', enum: ['PUBLIC', 'CONNECTIONS'] },
            },
            tools: [
              { methodName: 'listOrganizations', label: 'Organizations' },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          organizations: [{ id: 'opaque-provider-value', label: 'Jam 7' }],
        },
      });
    const client = createPostizAgentClient({
      transport: { request },
      credential: async () => ({
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      }),
      clock: () => new Date('2026-08-27T19:30:00.000Z'),
    });

    await expect(
      client.getIntegrationSettings('integration-linkedin-1')
    ).resolves.toEqual({
      rules: 'Choose one LinkedIn visibility.',
      maxLength: 3000,
      settings: {
        visibility: { type: 'string', enum: ['PUBLIC', 'CONNECTIONS'] },
      },
      tools: [{ methodName: 'listOrganizations', label: 'Organizations' }],
    });
    await expect(
      client.triggerIntegrationTool({
        integrationId: 'integration-linkedin-1',
        methodName: 'listOrganizations',
        data: { query: 'Jam' },
      })
    ).resolves.toEqual({
      organizations: [{ id: 'opaque-provider-value', label: 'Jam 7' }],
    });
    expect(request).toHaveBeenNthCalledWith(1, {
      credential: {
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      },
      method: 'GET',
      path: '/public/v1/integration-settings/integration-linkedin-1',
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      body: { methodName: 'listOrganizations', data: { query: 'Jam' } },
      credential: {
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      },
      method: 'POST',
      path: '/public/v1/integration-trigger/integration-linkedin-1',
    });
  });

  it('uploads media as a typed multipart request without reading the filesystem', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 201,
      body: {
        id: 'media-1',
        path: 'https://media.social.example.test/tenant/media-1.png',
        name: 'launch.png',
      },
    });
    const client = createPostizAgentClient({
      transport: { request },
      credential: async () => ({
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      }),
      clock: () => new Date('2026-08-27T19:30:00.000Z'),
    });
    const signal = new AbortController().signal;

    await expect(
      client.upload({
        bytes: new Uint8Array([137, 80, 78, 71]),
        contentType: 'image/png',
        filename: 'launch.png',
        signal,
      })
    ).resolves.toEqual({
      id: 'media-1',
      path: 'https://media.social.example.test/tenant/media-1.png',
      name: 'launch.png',
    });
    expect(request).toHaveBeenCalledWith({
      body: {
        kind: 'multipart',
        parts: [
          {
            bytes: new Uint8Array([137, 80, 78, 71]),
            contentType: 'image/png',
            field: 'file',
            filename: 'launch.png',
          },
        ],
      },
      credential: {
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      },
      method: 'POST',
      path: '/public/v1/upload',
      signal,
    });
  });

  it('maps the complete post lifecycle onto exact public API requests', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 201,
        body: [{ postId: 'post-1', integration: 'integration-linkedin-1' }],
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { posts: [{ id: 'post-1', group: 'group-1', state: 'QUEUE' }] },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'post-1', group: 'group-1', state: 'QUEUE' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { id: 'post-1', group: 'group-1', state: 'DRAFT' },
      })
      .mockResolvedValueOnce({ status: 200, body: { deleted: true } })
      .mockResolvedValueOnce({
        status: 200,
        body: [{ name: 'impressions', value: 42 }],
      });
    const credential = {
      apiKey: 'tenant-secret',
      apiUrl: 'https://api.social.example.test',
    };
    const client = createPostizAgentClient({
      transport: { request },
      credential: async () => credential,
      clock: () => new Date('2026-08-27T19:30:00.000Z'),
    });
    const createInput = {
      type: 'schedule' as const,
      date: '2026-08-28T09:15:00.000Z',
      shortLink: true,
      tags: [],
      posts: [
        {
          integration: { id: 'integration-linkedin-1' },
          value: [
            {
              content: 'Launch day',
              delay: 0,
              image: [
                {
                  id: 'media-1',
                  path: 'https://media.example.test/media-1.png',
                },
              ],
            },
          ],
          settings: { visibility: 'PUBLIC' },
        },
      ],
    };

    await expect(client.createPost(createInput)).resolves.toEqual([
      { postId: 'post-1', integration: 'integration-linkedin-1' },
    ]);
    await expect(client.listPosts({})).resolves.toEqual([
      { id: 'post-1', group: 'group-1', state: 'QUEUE' },
    ]);
    await expect(client.readPost({ id: 'post-1' })).resolves.toEqual({
      id: 'post-1',
      group: 'group-1',
      state: 'QUEUE',
    });
    await expect(
      client.changePostStatus({ id: 'post-1', status: 'draft' })
    ).resolves.toEqual({
      id: 'post-1',
      group: 'group-1',
      state: 'DRAFT',
    });
    await expect(client.deletePost({ id: 'post-1' })).resolves.toEqual({
      deleted: true,
    });
    await expect(
      client.getPostAnalytics({ postId: 'post-1', days: 7 })
    ).resolves.toEqual([{ name: 'impressions', value: 42 }]);

    expect(request.mock.calls).toEqual([
      [
        {
          body: { ...createInput, creationMethod: 'API' },
          credential,
          method: 'POST',
          path: '/public/v1/posts',
        },
      ],
      [
        {
          credential,
          method: 'GET',
          path: '/public/v1/posts',
          query: {
            startDate: '2026-07-28T19:30:00.000Z',
            endDate: '2026-09-26T19:30:00.000Z',
          },
        },
      ],
      [{ credential, method: 'GET', path: '/public/v1/posts/post-1' }],
      [
        {
          body: { status: 'draft' },
          credential,
          method: 'PUT',
          path: '/public/v1/posts/post-1/status',
        },
      ],
      [{ credential, method: 'DELETE', path: '/public/v1/posts/post-1' }],
      [
        {
          credential,
          method: 'GET',
          path: '/public/v1/analytics/post/post-1',
          query: { date: '7' },
        },
      ],
    ]);
  });

  it('uses the side-effect-free public validation path before publication', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: [
        {
          identifier: 'linkedin',
          name: 'LinkedIn',
          emptyContent: false,
          valid: true,
          errors: true,
          tooLong: false,
        },
      ],
    });
    const client = createPostizAgentClient({
      transport: { request },
      credential: async () => ({
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      }),
      clock: () => new Date('2026-08-27T19:30:00.000Z'),
    });
    const createInput = {
      type: 'schedule' as const,
      date: '2026-08-28T09:15:00.000Z',
      shortLink: true,
      tags: [],
      posts: [
        {
          integration: { id: 'integration-linkedin-1' },
          value: [{ content: 'Launch day', image: [] }],
          settings: { visibility: 'PUBLIC' },
        },
      ],
    };

    await expect(client.validatePost(createInput)).resolves.toEqual([
      {
        identifier: 'linkedin',
        name: 'LinkedIn',
        emptyContent: false,
        valid: true,
        errors: true,
        tooLong: false,
      },
    ]);
    expect(request).toHaveBeenCalledWith({
      body: { ...createInput, creationMethod: 'API' },
      credential: {
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      },
      method: 'POST',
      path: '/public/v1/posts/validate',
    });
  });

  it('preserves bounded provider rejection text while redacting credentials and content', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 422,
      body: {
        message: 'Provider requires a title.',
        authorization: 'Bearer tenant-secret',
        content: 'customer-content'.repeat(100),
      },
    });
    const client = createPostizAgentClient({
      transport: { request },
      credential: async () => ({
        apiKey: 'tenant-secret',
        apiUrl: 'https://api.social.example.test',
      }),
      clock: () => new Date('2026-08-27T19:30:00.000Z'),
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const rejection = await client
      .deletePost({ id: 'post-1' })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(PostizAgentError);
    expect(rejection).toMatchObject({ code: 'provider_rejected', status: 422 });
    expect((rejection as Error).message).toContain(
      'Provider requires a title.'
    );
    expect((rejection as Error).message).not.toContain('tenant-secret');
    expect((rejection as Error).message).not.toContain('customer-content');
    expect((rejection as Error).message.length).toBeLessThanOrEqual(512);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
