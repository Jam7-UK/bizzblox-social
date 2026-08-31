import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { PostsService } from './posts.service';

describe('PostsService exact post readback', () => {
  it('returns a provider-visible 404 when a post is missing or deleted', async () => {
    const service = Object.create(PostsService.prototype) as PostsService;
    Reflect.set(service, '_postRepository', {
      getPost: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.getPost('organization-1', 'post-1')
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
