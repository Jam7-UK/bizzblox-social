import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BizzbloxPublicPostIdempotency,
  isBizzbloxIdempotentPostRequest,
} from './bizzblox-public-post-idempotency';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('BizzBLOX public post idempotency admission', () => {
  const externalPublicationId = `bbx_social_${'a'.repeat(48)}`;

  it('requires the external publication key, stable group, and every stable segment id', () => {
    expect(
      isBizzbloxIdempotentPostRequest(externalPublicationId, [
        {
          group: 'group-stable-1',
          value: [{ id: 'post-stable-1' }, { id: 'post-stable-2' }],
        },
      ])
    ).toBe(true);
    expect(
      isBizzbloxIdempotentPostRequest(externalPublicationId, [
        { group: 'group-stable-1', value: [{ id: 'post-stable-1' }, {}] },
      ])
    ).toBe(false);
    expect(
      isBizzbloxIdempotentPostRequest(undefined, [
        { group: 'group-stable-1', value: [{ id: 'post-stable-1' }] },
      ])
    ).toBe(false);
  });

  it('authorizes stable upsert only against the exact managed reservation', async () => {
    vi.stubEnv('BIZZBLOX_SERVICE_MODE', '1');
    const findUnique = vi.fn().mockResolvedValue({
      remoteGroupId: 'group-stable-1',
      remotePostIds: ['post-stable-1', 'post-stable-2'],
      state: 'submitting',
    });
    const verifier = new BizzbloxPublicPostIdempotency({
      bizzbloxPublication: { findUnique },
    } as never);
    const posts = [
      {
        group: 'group-stable-1',
        value: [{ id: 'post-stable-1' }, { id: 'post-stable-2' }],
      },
    ];

    await expect(
      verifier.verify('postiz-org-1', externalPublicationId, posts)
    ).resolves.toBe(true);
    await expect(
      verifier.verify('postiz-org-1', externalPublicationId, [
        { ...posts[0], value: [{ id: 'foreign-post-id' }] },
      ])
    ).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_externalPublicationId: {
          organizationId: 'postiz-org-1',
          externalPublicationId,
        },
      },
      select: {
        remoteGroupId: true,
        remotePostIds: true,
        state: true,
      },
    });
  });
});
