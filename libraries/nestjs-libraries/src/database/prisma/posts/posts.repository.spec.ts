import { describe, expect, it, vi } from 'vitest';

import { PostsRepository } from './posts.repository';

describe('PostsRepository', () => {
  it('persists a supplied stable id when an upsert creates a post', async () => {
    const upsert = vi.fn(async ({ create }) => ({
      id: create.id ?? 'generated-post-id',
    }));
    const repository = new PostsRepository(
      {
        model: {
          post: {
            upsert,
            findFirst: vi.fn(),
            updateMany: vi.fn(),
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        model: {
          tagsPosts: {
            deleteMany: vi.fn(),
          },
        },
      } as never,
      {} as never
    );
    const stableId = 'post-stable-1';

    await repository.createOrUpdatePost(
      'schedule',
      'organization-1',
      '2026-09-01T09:30:00.000Z',
      {
        integration: { id: 'integration-1' },
        settings: {},
        value: [{ id: stableId, content: 'Launch day', image: [] }],
      } as never,
      [],
      'API' as never
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: stableId },
        create: expect.objectContaining({ id: stableId }),
      })
    );
  });
});
