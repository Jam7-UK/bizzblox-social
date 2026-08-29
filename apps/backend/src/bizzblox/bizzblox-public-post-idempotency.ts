import { Injectable } from '@nestjs/common';

import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

type MappedPost = Readonly<{
  group?: unknown;
  value?: readonly Readonly<{ id?: unknown }>[];
}>;

/** Enables Postiz's stable group/upsert path only for a fully pinned request. */
export function isBizzbloxIdempotentPostRequest(
  idempotencyKey: unknown,
  posts: readonly MappedPost[]
): boolean {
  return (
    typeof idempotencyKey === 'string' &&
    /^bbx_social_[a-f0-9]{48}$/.test(idempotencyKey) &&
    posts.length > 0 &&
    posts.every(
      (post) =>
        typeof post.group === 'string' &&
        post.group.length >= 8 &&
        Array.isArray(post.value) &&
        post.value.length > 0 &&
        post.value.every(
          (value) => typeof value.id === 'string' && value.id.length >= 8
        )
    )
  );
}

@Injectable()
export class BizzbloxPublicPostIdempotency {
  constructor(private readonly database: PrismaService) {}

  async verify(
    organizationId: string,
    idempotencyKey: unknown,
    posts: readonly MappedPost[]
  ): Promise<boolean> {
    if (
      process.env.BIZZBLOX_SERVICE_MODE !== '1' ||
      !isBizzbloxIdempotentPostRequest(idempotencyKey, posts) ||
      typeof idempotencyKey !== 'string' ||
      posts.length !== 1
    ) {
      return false;
    }
    const reservation = await this.database.bizzbloxPublication.findUnique({
      where: {
        organizationId_externalPublicationId: {
          organizationId,
          externalPublicationId: idempotencyKey,
        },
      },
      select: {
        remoteGroupId: true,
        remotePostIds: true,
        state: true,
      },
    });
    const [post] = posts;
    const postIds = post?.value?.map((value) => value.id);
    return Boolean(
      reservation &&
        reservation.state === 'submitting' &&
        post?.group === reservation.remoteGroupId &&
        postIds?.length === reservation.remotePostIds.length &&
        postIds.every((id, index) => id === reservation.remotePostIds[index])
    );
  }
}
