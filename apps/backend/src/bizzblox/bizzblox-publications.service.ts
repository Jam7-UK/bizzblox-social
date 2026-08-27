import { Inject, Injectable } from '@nestjs/common';

import type {
  CreatePostInput,
  JsonValue,
  PostizAgentClient,
  PostValidationResult,
} from '@bizzblox/postiz-agent-client';

import {
  bizzbloxCanonicalJson as canonicalJson,
  bizzbloxDigest as digest,
} from './bizzblox-canonical';

export const BIZZBLOX_PUBLICATION_STORE = Symbol('BIZZBLOX_PUBLICATION_STORE');
export const BIZZBLOX_CHANNEL_ACCESS = Symbol('BIZZBLOX_CHANNEL_ACCESS');
export const BIZZBLOX_POSTIZ_CLIENTS = Symbol('BIZZBLOX_POSTIZ_CLIENTS');
export const BIZZBLOX_PUBLICATION_IDS = Symbol('BIZZBLOX_PUBLICATION_IDS');

type PublicationMedia = Readonly<{
  fileVersionId: string;
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
    @Inject(BIZZBLOX_PUBLICATION_IDS)
    private readonly ids: BizzbloxPublicationIds
  ) {}

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
          segment.media.length > 0
      )
    ) {
      throw new BizzbloxPublicationInputError(
        'Publication media must be prepared before scheduling.'
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
            image: [],
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
    } catch {
      const updated = await this.publications.transition({
        organizationId,
        externalPublicationId: input.delivery.externalPublicationId,
        payloadDigest,
        patch: {
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
