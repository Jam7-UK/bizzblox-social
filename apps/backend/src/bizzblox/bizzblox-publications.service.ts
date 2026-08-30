import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  PostizAgentError,
  type CreatePostInput,
  type JsonValue,
  type PostizAgentClient,
  type PostValidationResult,
} from '@bizzblox/postiz-agent-client';

import {
  bizzbloxCanonicalJson as canonicalJson,
  bizzbloxDigest as digest,
} from './bizzblox-canonical';

export const BIZZBLOX_PUBLICATION_STORE = Symbol('BIZZBLOX_PUBLICATION_STORE');
export const BIZZBLOX_CHANNEL_ACCESS = Symbol('BIZZBLOX_CHANNEL_ACCESS');
export const BIZZBLOX_POSTIZ_CLIENTS = Symbol('BIZZBLOX_POSTIZ_CLIENTS');
export const BIZZBLOX_PUBLICATION_IDS = Symbol('BIZZBLOX_PUBLICATION_IDS');
export const BIZZBLOX_MEDIA_STORE = Symbol('BIZZBLOX_MEDIA_STORE');

type PublicationMedia = Readonly<{
  mediaHandle: string;
  checksumSha256: string;
  altText?: string;
}>;

type PublicationSegment = Readonly<{
  text: string;
  media: readonly PublicationMedia[];
}>;

export type BizzbloxPublicationRequest = Readonly<{
  document: Readonly<{
    sourceCardId: string;
    sourceVersion: number;
    title: string;
    defaultSegments: readonly PublicationSegment[];
    destinationOverrides: readonly Readonly<{
      channelHandle: string;
      segments: readonly PublicationSegment[];
      contractDigest: string;
      providerSettingsJson?: string;
      providerSettingsDigest?: string;
    }>[];
    primaryLink?: string;
    trackingParameters: readonly Readonly<{ key: string; value: string }>[];
    scheduledForUtc: number;
    displayTimezone: string;
    contentDigest: string;
  }>;
  delivery: Readonly<{
    deliveryId: string;
    deliveryVersion: number;
    channelHandle: string;
    contractDigest: string;
    externalPublicationId: string;
    required: boolean;
  }>;
}>;

export type BizzbloxChannelRecord = Readonly<{
  channelHandle: string;
  connectorRevision: number;
  contractDigest: string;
  integrationId: string;
  organizationId: string;
}>;

export interface BizzbloxChannelAccess {
  resolve(
    organizationId: string,
    channelHandle: string,
    connectorRevision: number
  ): Promise<BizzbloxChannelRecord | null>;
}

export type BizzbloxPublicationState =
  | 'submitting'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'rejected'
  | 'reconnect_required'
  | 'reconcile_required'
  | 'cancelled';

export type BizzbloxPublicationCandidate = Readonly<{
  channelHandle: string;
  connectorRevision: number;
  externalPublicationId: string;
  organizationId: string;
  payloadDigest: string;
  remoteGroupId: string;
  remotePostIds: readonly string[];
}>;

export type BizzbloxPublicationRecord = BizzbloxPublicationCandidate &
  Readonly<{
    state: BizzbloxPublicationState;
    providerErrorCode: string | null;
    providerErrorMessage: string | null;
    publicUrl: string | null;
    providerPublishedAt: number | null;
    safeResponseDigest: string | null;
  }>;

export interface BizzbloxPublicationStore {
  reserve(candidate: BizzbloxPublicationCandidate): Promise<
    | Readonly<{
        outcome: 'conflict';
        record: BizzbloxPublicationRecord;
      }>
    | Readonly<{
        outcome: 'created' | 'existing';
        record: BizzbloxPublicationRecord;
      }>
  >;
  read(
    organizationId: string,
    externalPublicationId: string
  ): Promise<BizzbloxPublicationRecord | null>;
  transition(
    input: Readonly<{
      organizationId: string;
      externalPublicationId: string;
      payloadDigest: string;
      patch: Partial<
        Pick<
          BizzbloxPublicationRecord,
          | 'state'
          | 'providerErrorCode'
          | 'providerErrorMessage'
          | 'publicUrl'
          | 'providerPublishedAt'
          | 'safeResponseDigest'
        >
      >;
    }>
  ): Promise<BizzbloxPublicationRecord | null>;
}

export interface BizzbloxPostizClientFactory {
  forOrganization(organizationId: string): Promise<PostizAgentClient>;
}

export type BizzbloxMediaRecord = Readonly<{
  organizationId: string;
  externalMediaId: string;
  checksumSha256: string;
  postizMediaId: string;
  postizMediaPath: string;
}>;

export interface BizzbloxMediaStore {
  reserve(candidate: BizzbloxMediaRecord): Promise<
    Readonly<{
      outcome: 'created' | 'existing' | 'conflict';
      record: BizzbloxMediaRecord;
    }>
  >;
  resolve(
    organizationId: string,
    mediaHandles: readonly string[]
  ): Promise<readonly BizzbloxMediaRecord[]>;
}

export interface BizzbloxPublicationIds {
  randomId(): string;
}

type PreparedPublication = Readonly<{
  channel: BizzbloxChannelRecord;
  post: CreatePostInput;
  segments: readonly PublicationSegment[];
}>;

class BizzbloxPublicationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BizzbloxPublicationInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 500)
    : fallback;
}

function isDefinitiveProviderRejection(
  error: unknown
): error is PostizAgentError & { status: number } {
  return (
    error instanceof PostizAgentError &&
    error.code === 'provider_rejected' &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 425 &&
    error.status !== 429
  );
}

function safeSettings(value: string | undefined): JsonValue {
  if (!value) return {};
  if (value.length > 32_000) {
    throw new BizzbloxPublicationInputError('Provider settings are too large.');
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new BizzbloxPublicationInputError(
        'Provider settings must be an object.'
      );
    }
    canonicalJson(parsed);
    return parsed as JsonValue;
  } catch (error) {
    if (error instanceof BizzbloxPublicationInputError) throw error;
    throw new BizzbloxPublicationInputError(
      'Provider settings must be valid JSON.'
    );
  }
}

function validRequest(input: BizzbloxPublicationRequest): boolean {
  const { delivery, document } = input;
  return (
    /^bbx_social_[a-f0-9]{48}$/.test(delivery.externalPublicationId) &&
    /^[A-Za-z0-9_-]{8,200}$/.test(delivery.channelHandle) &&
    delivery.deliveryId.length > 0 &&
    delivery.deliveryId.length <= 256 &&
    Number.isSafeInteger(delivery.deliveryVersion) &&
    delivery.deliveryVersion > 0 &&
    Number.isSafeInteger(document.sourceVersion) &&
    document.sourceVersion > 0 &&
    Number.isSafeInteger(document.scheduledForUtc) &&
    document.scheduledForUtc > 0 &&
    document.title.length <= 500 &&
    document.defaultSegments.length > 0 &&
    document.defaultSegments.length <= 50 &&
    document.destinationOverrides.length <= 100 &&
    document.trackingParameters.length <= 50 &&
    document.contentDigest.length > 0 &&
    document.contentDigest.length <= 200
  );
}

function validationErrors(results: readonly PostValidationResult[]): string[] {
  const errors: string[] = [];
  for (const result of results.slice(0, 20)) {
    if (result.emptyContent) {
      errors.push(`${result.name}: content is empty.`);
    } else if (!result.valid) {
      errors.push(
        `${result.name}: ${bounded(
          result.settingsError,
          'provider settings are invalid.'
        )}`
      );
    } else if (result.errors !== true) {
      errors.push(
        `${result.name}: ${bounded(result.errors, 'validation failed.')}`
      );
    } else if (result.tooLong) {
      errors.push(`${result.name}: content is too long.`);
    }
  }
  return errors.map((error) => error.slice(0, 500));
}

async function assertLiveContract(
  client: PostizAgentClient,
  channel: BizzbloxChannelRecord
): Promise<void> {
  const live = await client.getIntegrationSettings(channel.integrationId);
  if (digest(live) !== channel.contractDigest) {
    throw new BizzbloxPublicationInputError(
      'Publication channel contract changed.'
    );
  }
}

function storedScheduleOutcome(record: BizzbloxPublicationRecord) {
  const remotePublicationId = record.remotePostIds[0];
  if (
    remotePublicationId &&
    (record.state === 'scheduled' ||
      record.state === 'publishing' ||
      record.state === 'published')
  ) {
    return Object.freeze({
      outcome: 'accepted' as const,
      remotePublicationId,
      safeRequestDigest: record.payloadDigest,
      ...(record.safeResponseDigest
        ? { safeResponseDigest: record.safeResponseDigest }
        : {}),
    });
  }
  if (record.state === 'rejected' || record.state === 'failed') {
    return Object.freeze({
      outcome: 'rejected' as const,
      code: record.providerErrorCode ?? 'provider_rejected',
      message:
        record.providerErrorMessage ?? 'The provider rejected the publication.',
    });
  }
  return Object.freeze({ outcome: 'unknown' as const });
}

function postState(value: unknown): BizzbloxPublicationState {
  if (!isRecord(value) || typeof value.state !== 'string') {
    return 'reconcile_required';
  }
  switch (value.state) {
    case 'QUEUE':
      return 'scheduled';
    case 'PUBLISHED':
      return 'published';
    case 'ERROR':
      return 'failed';
    case 'DRAFT':
      return 'scheduled';
    default:
      return 'reconcile_required';
  }
}

function rootPost(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.posts)) {
    const first = value.posts[0];
    return isRecord(first) ? first : null;
  }
  return value;
}

const ANALYTICS_NAMES = Object.freeze({
  impressions: 'impressions',
  reach: 'reach',
  engagements: 'engagements',
  engagement: 'engagements',
  likes: 'reactions',
  reactions: 'reactions',
  comments: 'comments',
  shares: 'shares',
  clicks: 'clicks',
  views: 'video_views',
  video_views: 'video_views',
  'video views': 'video_views',
} as const);

function analyticsValue(item: Record<string, unknown>): number | null {
  if (
    typeof item.value === 'number' &&
    Number.isFinite(item.value) &&
    item.value >= 0
  ) {
    return item.value;
  }
  if (!Array.isArray(item.data)) return null;
  let total = 0;
  let found = false;
  for (const point of item.data) {
    if (!isRecord(point)) continue;
    const value =
      typeof point.total === 'number'
        ? point.total
        : typeof point.total === 'string'
        ? Number(point.total)
        : Number.NaN;
    if (!Number.isFinite(value) || value < 0) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

@Injectable()
export class BizzbloxPublicationsService {
  constructor(
    @Inject(BIZZBLOX_PUBLICATION_STORE)
    private readonly publications: BizzbloxPublicationStore,
    @Inject(BIZZBLOX_CHANNEL_ACCESS)
    private readonly channels: BizzbloxChannelAccess,
    @Inject(BIZZBLOX_POSTIZ_CLIENTS)
    private readonly clients: BizzbloxPostizClientFactory,
    @Inject(BIZZBLOX_MEDIA_STORE)
    private readonly media: BizzbloxMediaStore,
    @Inject(BIZZBLOX_PUBLICATION_IDS)
    private readonly ids: BizzbloxPublicationIds
  ) {}

  async uploadMedia(
    organizationId: string,
    input: Readonly<{
      externalMediaId: string;
      checksumSha256: string;
      contentType: string;
      bytes: Uint8Array;
    }>
  ) {
    if (
      !/^bbx_media_[a-f0-9]{48}$/.test(input.externalMediaId) ||
      !/^[a-f0-9]{64}$/.test(input.checksumSha256) ||
      !/^[\w.+-]+\/[\w.+-]+(?:;[\x20-\x7e]+)?$/.test(input.contentType) ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > MAX_SOCIAL_MEDIA_UPLOAD_BYTES ||
      createHash('sha256').update(input.bytes).digest('hex') !==
        input.checksumSha256
    ) {
      throw new BizzbloxPublicationInputError('Invalid social media upload.');
    }
    const client = await this.clients.forOrganization(organizationId);
    const uploaded = await client.upload({
      bytes: input.bytes,
      contentType: input.contentType,
      filename: input.externalMediaId,
    });
    const reserved = await this.media.reserve({
      organizationId,
      externalMediaId: input.externalMediaId,
      checksumSha256: input.checksumSha256,
      postizMediaId: uploaded.id,
      postizMediaPath: uploaded.path,
    });
    if (
      reserved.outcome === 'conflict' ||
      reserved.record.checksumSha256 !== input.checksumSha256
    ) {
      throw new BizzbloxPublicationInputError(
        'Social media identity is already bound to different bytes.'
      );
    }
    return Object.freeze({
      mediaHandle: input.externalMediaId,
      checksumSha256: input.checksumSha256,
    });
  }

  private async prepare(
    organizationId: string,
    connectorRevision: number,
    input: BizzbloxPublicationRequest,
    stableIds?: Readonly<{ groupId: string; postIds: readonly string[] }>
  ): Promise<PreparedPublication> {
    if (!validRequest(input)) {
      throw new BizzbloxPublicationInputError('Invalid publication request.');
    }
    const channel = await this.channels.resolve(
      organizationId,
      input.delivery.channelHandle,
      connectorRevision
    );
    if (
      !channel ||
      channel.organizationId !== organizationId ||
      channel.connectorRevision !== connectorRevision ||
      channel.channelHandle !== input.delivery.channelHandle ||
      channel.contractDigest !== input.delivery.contractDigest
    ) {
      throw new BizzbloxPublicationInputError(
        'Publication channel or contract is stale.'
      );
    }
    const overrides = input.document.destinationOverrides.filter(
      (candidate) => candidate.channelHandle === input.delivery.channelHandle
    );
    if (overrides.length > 1) {
      throw new BizzbloxPublicationInputError(
        'Publication has duplicate destination overrides.'
      );
    }
    const override = overrides[0];
    if (override && override.contractDigest !== channel.contractDigest) {
      throw new BizzbloxPublicationInputError(
        'Publication override contract is stale.'
      );
    }
    const segments = override?.segments.length
      ? override.segments
      : input.document.defaultSegments;
    if (
      segments.length === 0 ||
      segments.length > 50 ||
      segments.some(
        (segment) =>
          segment.text.length > 100_000 ||
          segment.media.length > 20 ||
          segment.media.some(
            (media) =>
              !/^bbx_media_[a-f0-9]{48}$/.test(media.mediaHandle) ||
              !/^[a-f0-9]{64}$/.test(media.checksumSha256) ||
              (media.altText?.length ?? 0) > 2_000
          )
      )
    ) {
      throw new BizzbloxPublicationInputError(
        'Publication content or media is invalid.'
      );
    }
    const mediaHandles = [
      ...new Set(
        segments.flatMap((segment) =>
          segment.media.map((media) => media.mediaHandle)
        )
      ),
    ];
    const storedMedia = await this.media.resolve(organizationId, mediaHandles);
    const mediaByHandle = new Map(
      storedMedia.map((record) => [record.externalMediaId, record])
    );
    if (
      mediaHandles.length !== storedMedia.length ||
      segments.some((segment) =>
        segment.media.some(
          (media) =>
            mediaByHandle.get(media.mediaHandle)?.organizationId !==
              organizationId ||
            mediaByHandle.get(media.mediaHandle)?.checksumSha256 !==
              media.checksumSha256
        )
      )
    ) {
      throw new BizzbloxPublicationInputError(
        'Publication media is unavailable.'
      );
    }
    const settings = safeSettings(override?.providerSettingsJson);
    const post: CreatePostInput = {
      type: 'schedule',
      date: new Date(input.document.scheduledForUtc).toISOString(),
      idempotencyKey: input.delivery.externalPublicationId,
      shortLink: input.document.trackingParameters.length > 0,
      tags: [],
      posts: [
        {
          ...(stableIds ? { group: stableIds.groupId } : {}),
          integration: { id: channel.integrationId },
          settings,
          value: segments.map((segment, index) => ({
            ...(stableIds ? { id: stableIds.postIds[index] } : {}),
            content: segment.text,
            image: segment.media.map((media) => {
              const stored = mediaByHandle.get(media.mediaHandle)!;
              return { id: stored.postizMediaId, path: stored.postizMediaPath };
            }),
          })),
        },
      ],
    };
    return Object.freeze({ channel, post, segments });
  }

  async validate(
    organizationId: string,
    connectorRevision: number,
    input: BizzbloxPublicationRequest
  ): Promise<
    Readonly<{ ok: true } | { ok: false; errors: readonly string[] }>
  > {
    try {
      const prepared = await this.prepare(
        organizationId,
        connectorRevision,
        input
      );
      const client = await this.clients.forOrganization(organizationId);
      await assertLiveContract(client, prepared.channel);
      const errors = validationErrors(await client.validatePost(prepared.post));
      return errors.length
        ? Object.freeze({ ok: false as const, errors: Object.freeze(errors) })
        : Object.freeze({ ok: true as const });
    } catch (error) {
      if (!(error instanceof BizzbloxPublicationInputError)) throw error;
      return Object.freeze({
        ok: false as const,
        errors: Object.freeze([
          bounded(
            error instanceof Error ? error.message : null,
            'Validation failed.'
          ),
        ]),
      });
    }
  }

  async schedule(
    organizationId: string,
    connectorRevision: number,
    input: BizzbloxPublicationRequest
  ) {
    let base: PreparedPublication;
    try {
      base = await this.prepare(organizationId, connectorRevision, input);
    } catch (error) {
      if (!(error instanceof BizzbloxPublicationInputError)) throw error;
      return Object.freeze({
        outcome: 'rejected' as const,
        code: 'validation_rejected',
        message: bounded(
          error instanceof Error ? error.message : null,
          'Publication validation failed.'
        ),
      });
    }
    let client: PostizAgentClient;
    try {
      client = await this.clients.forOrganization(organizationId);
      await assertLiveContract(client, base.channel);
    } catch (error) {
      if (!(error instanceof BizzbloxPublicationInputError)) throw error;
      return Object.freeze({
        outcome: 'rejected' as const,
        code: 'validation_rejected',
        message: bounded(
          error instanceof Error ? error.message : null,
          'Publication validation failed.'
        ),
      });
    }
    const payloadDigest = digest(input);
    const candidate: BizzbloxPublicationCandidate = Object.freeze({
      channelHandle: input.delivery.channelHandle,
      connectorRevision,
      externalPublicationId: input.delivery.externalPublicationId,
      organizationId,
      payloadDigest,
      remoteGroupId: this.ids.randomId(),
      remotePostIds: Object.freeze(
        base.segments.map(() => this.ids.randomId())
      ),
    });
    const reservation = await this.publications.reserve(candidate);
    if (reservation.outcome === 'conflict') {
      return Object.freeze({
        outcome: 'rejected' as const,
        code: 'idempotency_conflict',
        message: 'Publication identity is already bound to different content.',
      });
    }
    if (reservation.outcome === 'existing') {
      return storedScheduleOutcome(reservation.record);
    }

    const prepared = await this.prepare(
      organizationId,
      connectorRevision,
      input,
      {
        groupId: reservation.record.remoteGroupId,
        postIds: reservation.record.remotePostIds,
      }
    );
    const errors = validationErrors(await client.validatePost(prepared.post));
    if (errors.length) {
      const rejected = await this.publications.transition({
        organizationId,
        externalPublicationId: input.delivery.externalPublicationId,
        payloadDigest,
        patch: {
          state: 'rejected',
          providerErrorCode: 'validation_rejected',
          providerErrorMessage: errors.join('; ').slice(0, 500),
        },
      });
      return storedScheduleOutcome(rejected ?? reservation.record);
    }

    try {
      const created = await client.createPost(prepared.post);
      const expected = reservation.record.remotePostIds;
      if (
        created.length !== 1 ||
        created[0]?.postId !== expected[0] ||
        created[0]?.integration !== prepared.channel.integrationId
      ) {
        throw new Error(
          'Postiz create response did not match the reservation.'
        );
      }
      const updated = await this.publications.transition({
        organizationId,
        externalPublicationId: input.delivery.externalPublicationId,
        payloadDigest,
        patch: {
          state: 'scheduled',
          providerErrorCode: null,
          providerErrorMessage: null,
          safeResponseDigest: digest(created),
        },
      });
      return storedScheduleOutcome(updated ?? reservation.record);
    } catch (error) {
      const definitiveProviderRejection = isDefinitiveProviderRejection(error);
      const updated = await this.publications.transition({
        organizationId,
        externalPublicationId: input.delivery.externalPublicationId,
        payloadDigest,
        patch: definitiveProviderRejection
          ? {
              state: 'rejected',
              providerErrorCode: `provider_rejected_${error.status}`,
              providerErrorMessage: bounded(
                error.message,
                'The provider rejected the publication.'
              ),
            }
          : {
              state: 'reconcile_required',
              providerErrorCode: 'provider_acceptance_unknown',
              providerErrorMessage: null,
            },
      });
      return storedScheduleOutcome(updated ?? reservation.record);
    }
  }

  async read(
    organizationId: string,
    connectorRevision: number,
    externalPublicationId: string
  ) {
    const record = await this.publications.read(
      organizationId,
      externalPublicationId
    );
    if (!record) return Object.freeze({ state: 'reconcile_required' as const });
    if (record.connectorRevision !== connectorRevision) {
      return Object.freeze({ state: 'reconnect_required' as const });
    }
    const postId = record.remotePostIds[0];
    if (!postId) return Object.freeze({ state: 'reconcile_required' as const });
    try {
      const client = await this.clients.forOrganization(organizationId);
      const post = await client.readPost({ id: postId });
      const root = rootPost(post);
      const state = postState(root);
      const publicUrl =
        root && typeof root.releaseURL === 'string'
          ? root.releaseURL.slice(0, 2_000)
          : null;
      const providerPublishedAt =
        root && typeof root.publishDate === 'string'
          ? Date.parse(root.publishDate)
          : null;
      await this.publications.transition({
        organizationId,
        externalPublicationId,
        payloadDigest: record.payloadDigest,
        patch: {
          state,
          publicUrl,
          providerPublishedAt:
            providerPublishedAt !== null && Number.isFinite(providerPublishedAt)
              ? providerPublishedAt
              : null,
          safeResponseDigest: digest(post),
        },
      });
      return Object.freeze({
        state,
        remotePublicationId: postId,
        ...(publicUrl ? { publicUrl } : {}),
        ...(providerPublishedAt !== null && Number.isFinite(providerPublishedAt)
          ? { providerPublishedAt }
          : {}),
        safeResponseDigest: digest(post),
      });
    } catch {
      return Object.freeze({
        state:
          record.state === 'submitting'
            ? ('reconcile_required' as const)
            : record.state,
        remotePublicationId: postId,
        ...(record.publicUrl ? { publicUrl: record.publicUrl } : {}),
        ...(record.providerErrorCode
          ? { providerErrorCode: record.providerErrorCode }
          : {}),
        ...(record.providerErrorMessage
          ? { providerErrorMessage: record.providerErrorMessage }
          : {}),
      });
    }
  }

  async cancel(
    organizationId: string,
    connectorRevision: number,
    externalPublicationId: string
  ) {
    const record = await this.publications.read(
      organizationId,
      externalPublicationId
    );
    if (!record || record.connectorRevision !== connectorRevision) {
      return Object.freeze({
        outcome: 'rejected' as const,
        code: 'publication_not_found',
        message: 'Social publication was not found.',
      });
    }
    if (record.state === 'cancelled') {
      return Object.freeze({ outcome: 'cancelled' as const });
    }
    if (record.state === 'published') {
      return Object.freeze({
        outcome: 'rejected' as const,
        code: 'already_published',
        message: 'Published social content cannot be cancelled.',
      });
    }
    const postId = record.remotePostIds[0];
    if (!postId) {
      return Object.freeze({ outcome: 'reconcile_required' as const });
    }
    const client = await this.clients.forOrganization(organizationId);
    try {
      await client.deletePost({ id: postId });
    } catch {
      // An unknown delete result is resolved by the exact read below. A retry
      // may also observe a provider 404 after the first delete succeeded.
    }
    try {
      const post = await client.readPost({ id: postId });
      if (postState(rootPost(post)) === 'published') {
        await this.publications.transition({
          organizationId,
          externalPublicationId,
          payloadDigest: record.payloadDigest,
          patch: {
            state: 'published',
            providerErrorCode: null,
            providerErrorMessage: null,
            safeResponseDigest: digest(post),
          },
        });
        return Object.freeze({
          outcome: 'rejected' as const,
          code: 'already_published',
          message: 'Published social content cannot be cancelled.',
        });
      }
    } catch (error) {
      if (error instanceof PostizAgentError && error.status === 404) {
        const cancelled = await this.publications.transition({
          organizationId,
          externalPublicationId,
          payloadDigest: record.payloadDigest,
          patch: {
            state: 'cancelled',
            providerErrorCode: null,
            providerErrorMessage: null,
          },
        });
        return cancelled?.state === 'cancelled'
          ? Object.freeze({ outcome: 'cancelled' as const })
          : Object.freeze({ outcome: 'reconcile_required' as const });
      }
    }
    await this.publications.transition({
      organizationId,
      externalPublicationId,
      payloadDigest: record.payloadDigest,
      patch: {
        state: 'reconcile_required',
        providerErrorCode: 'cancellation_unconfirmed',
        providerErrorMessage: null,
      },
    });
    return Object.freeze({ outcome: 'reconcile_required' as const });
  }

  async analytics(
    organizationId: string,
    connectorRevision: number,
    externalPublicationId: string
  ) {
    const record = await this.publications.read(
      organizationId,
      externalPublicationId
    );
    const postId = record?.remotePostIds[0];
    if (!record || !postId || record.connectorRevision !== connectorRevision) {
      return Object.freeze({ metrics: {}, unavailable: true as const });
    }
    try {
      const client = await this.clients.forOrganization(organizationId);
      const result = await client.getPostAnalytics({ postId, days: 30 });
      const metrics: Record<string, number> = {};
      const source = Array.isArray(result)
        ? result
        : isRecord(result) && Array.isArray(result.metrics)
        ? result.metrics
        : [];
      for (const item of source) {
        if (!isRecord(item)) continue;
        const name =
          typeof item.name === 'string'
            ? item.name
            : typeof item.label === 'string'
            ? item.label
            : '';
        const value = analyticsValue(item);
        if (!name || value === null) continue;
        const key =
          ANALYTICS_NAMES[name.toLowerCase() as keyof typeof ANALYTICS_NAMES];
        if (key) metrics[key] = value;
      }
      return Object.keys(metrics).length
        ? Object.freeze({ metrics: Object.freeze(metrics) })
        : Object.freeze({ metrics: {}, unavailable: true as const });
    } catch {
      return Object.freeze({ metrics: {}, unavailable: true as const });
    }
  }
}
const MAX_SOCIAL_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024;
