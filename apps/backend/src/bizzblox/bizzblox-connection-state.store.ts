import {
  createCipheriv,
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import type { JsonValue } from '@bizzblox/postiz-agent-client';

import type {
  BizzbloxAuthorizationState,
  BizzbloxConnectionOutcomeState,
  BizzbloxConnectionStateStore,
  BizzbloxProviderSelectionOption,
  BizzbloxSelectionState,
} from './bizzblox-connections.service';
import { BIZZBLOX_CLOCK } from './bizzblox-clock';
import { BIZZBLOX_REDIS } from './bizzblox-replay.store';

export const BIZZBLOX_CONNECTION_STATE_CODEC = Symbol(
  'BIZZBLOX_CONNECTION_STATE_CODEC'
);

const STATE_AAD_PREFIX = 'bizzblox-social-connection-state-v1:';
const MAX_STATE_BYTES = 64 * 1_024;

export interface BizzbloxConnectionStateRedis {
  getdel(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMilliseconds: number,
    condition: 'NX'
  ): Promise<'OK' | null>;
}

export type BizzbloxConnectionStateCodecConfig = Readonly<{
  encryptionKey: Buffer;
  randomBytes: (size: number) => Buffer;
}>;

type StatePurpose = 'authorization' | 'selection' | 'outcome';

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid envelope');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('invalid envelope');
  }
  return decoded;
}

export class BizzbloxConnectionStateCodec {
  constructor(private readonly config: BizzbloxConnectionStateCodecConfig) {
    if (config.encryptionKey.byteLength !== 32) {
      throw new Error('Connection state encryption requires a 32-byte key.');
    }
  }

  seal(value: string, purpose: StatePurpose): string {
    if (!value || Buffer.byteLength(value, 'utf8') > MAX_STATE_BYTES) {
      throw new Error('Invalid connection state.');
    }
    const iv = this.config.randomBytes(12);
    if (iv.byteLength !== 12) throw new Error('Invalid random source.');
    const cipher = createCipheriv('aes-256-gcm', this.config.encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${STATE_AAD_PREFIX}${purpose}`, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  unseal(value: string, purpose: StatePurpose): string {
    try {
      if (!value || value.length > MAX_STATE_BYTES * 2) {
        throw new Error('invalid envelope');
      }
      const [version, encodedIv, encodedCiphertext, encodedTag, extra] =
        value.split('.');
      if (
        version !== 'v1' ||
        !encodedIv ||
        !encodedCiphertext ||
        !encodedTag ||
        extra !== undefined
      ) {
        throw new Error('invalid envelope');
      }
      const iv = decodeBase64Url(encodedIv);
      const ciphertext = decodeBase64Url(encodedCiphertext);
      const tag = decodeBase64Url(encodedTag);
      if (
        iv.byteLength !== 12 ||
        tag.byteLength !== 16 ||
        ciphertext.byteLength === 0
      ) {
        throw new Error('invalid envelope');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.config.encryptionKey,
        iv
      );
      decipher.setAAD(Buffer.from(`${STATE_AAD_PREFIX}${purpose}`, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (plaintext.byteLength > MAX_STATE_BYTES) {
        throw new Error('invalid envelope');
      }
      return plaintext.toString('utf8');
    } catch {
      throw new Error('Invalid connection state envelope.');
    }
  }
}

function stateKey(kind: StatePurpose, parts: readonly string[]): string {
  const digest = createHash('sha256')
    .update(parts.join('\u0000'), 'utf8')
    .digest('hex');
  return `bizzblox:connection:${kind}:v1:${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, label: string, maximum = 2_048): string {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function revisionValue(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error('Invalid connector revision.');
  }
  return value as number;
}

function expiryValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('Invalid connection expiry.');
  }
  return value as number;
}

function returnUrlValue(value: unknown): string {
  const parsed = new URL(stringValue(value, 'AMP return URL'));
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.bizzblox.com') ||
    !parsed.pathname.startsWith('/settings') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Invalid AMP return URL.');
  }
  return parsed.toString();
}

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 8) throw new Error('Invalid provider selector.');
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return value.map((item) => jsonValue(item, depth + 1));
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        !key ||
        key.length > 128 ||
        /(authorization|cookie|credential|password|secret|token)/i.test(key)
      ) {
        throw new Error('Invalid provider selector.');
      }
      result[key] = jsonValue(item, depth + 1);
    }
    return result;
  }
  throw new Error('Invalid provider selector.');
}

function selectionOption(value: unknown): BizzbloxProviderSelectionOption {
  if (!isRecord(value)) throw new Error('Invalid selection option.');
  const picture =
    value.picture === null
      ? null
      : stringValue(value.picture, 'selection picture');
  if (picture !== null) {
    const parsed = new URL(picture);
    if (parsed.protocol !== 'https:') {
      throw new Error('Invalid selection picture.');
    }
  }
  const selector = jsonValue(value.selector);
  if (!isRecord(selector)) throw new Error('Invalid provider selector.');
  return {
    optionRef: stringValue(value.optionRef, 'selection reference', 256),
    label: stringValue(value.label, 'selection label', 512),
    picture,
    selector,
  };
}

function authorizationState(value: string): BizzbloxAuthorizationState {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('Invalid authorization state.');
  const provider = stringValue(parsed.provider, 'provider', 100);
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(provider)) {
    throw new Error('Invalid provider.');
  }
  return {
    organizationId: stringValue(parsed.organizationId, 'organization', 256),
    connectorRevision: revisionValue(parsed.connectorRevision),
    provider,
    codeVerifier: stringValue(parsed.codeVerifier, 'code verifier'),
    ampReturnUrl: returnUrlValue(parsed.ampReturnUrl),
    expiresAt: expiryValue(parsed.expiresAt),
    ...(parsed.userBinding === undefined
      ? {}
      : { userBinding: stringValue(parsed.userBinding, 'user binding', 256) }),
    ...(parsed.outcomeHandle === undefined
      ? {}
      : {
          outcomeHandle: stringValue(
            parsed.outcomeHandle,
            'outcome handle',
            256
          ),
        }),
    ...(parsed.reconnectChannelHandle === undefined
      ? {}
      : {
          reconnectChannelHandle: stringValue(
            parsed.reconnectChannelHandle,
            'reconnect channel',
            256
          ),
        }),
  };
}

function selectionState(value: string): BizzbloxSelectionState {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || !Array.isArray(parsed.options)) {
    throw new Error('Invalid selection state.');
  }
  if (parsed.options.length < 1 || parsed.options.length > 250) {
    throw new Error('Invalid selection state.');
  }
  const provider = stringValue(parsed.provider, 'provider', 100);
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(provider)) {
    throw new Error('Invalid provider.');
  }
  return {
    organizationId: stringValue(parsed.organizationId, 'organization', 256),
    connectorRevision: revisionValue(parsed.connectorRevision),
    provider,
    integrationId: stringValue(parsed.integrationId, 'integration', 256),
    ...(parsed.userBinding === undefined
      ? {}
      : { userBinding: stringValue(parsed.userBinding, 'user binding', 256) }),
    ampReturnUrl: returnUrlValue(parsed.ampReturnUrl),
    expiresAt: expiryValue(parsed.expiresAt),
    options: parsed.options.map(selectionOption),
  };
}

function outcomeState(value: string): BizzbloxConnectionOutcomeState {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || !isRecord(parsed.result)) {
    throw new Error('Invalid connection outcome state.');
  }
  const organizationId = stringValue(
    parsed.organizationId,
    'organization',
    256
  );
  const connectorRevision = revisionValue(parsed.connectorRevision);
  const userBinding = stringValue(parsed.userBinding, 'user binding', 256);
  const expiresAt = expiryValue(parsed.expiresAt);
  const outcome = parsed.result.outcome;
  if (outcome === 'failed') {
    return {
      organizationId,
      connectorRevision,
      userBinding,
      expiresAt,
      result: { outcome: 'failed' },
    };
  }
  const channelHandle = stringValue(
    parsed.result.channelHandle,
    'channel handle',
    256
  );
  if (!/^bbx_ch_[A-Za-z0-9_-]{8,256}$/.test(channelHandle)) {
    throw new Error('Invalid channel handle.');
  }
  const resultRevision = revisionValue(parsed.result.connectorRevision);
  if (resultRevision !== connectorRevision) {
    throw new Error('Invalid connection outcome revision.');
  }
  if (outcome === 'connected') {
    return {
      organizationId,
      connectorRevision,
      userBinding,
      expiresAt,
      result: { outcome, channelHandle, connectorRevision: resultRevision },
    };
  }
  if (outcome !== 'selection_required' || !isRecord(parsed.result.selection)) {
    throw new Error('Invalid connection outcome.');
  }
  const selection = parsed.result.selection;
  if (!Array.isArray(selection.options) || selection.options.length < 1) {
    throw new Error('Invalid connection outcome selection.');
  }
  const providerKey = stringValue(selection.providerKey, 'provider', 100);
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(providerKey)) {
    throw new Error('Invalid provider.');
  }
  return {
    organizationId,
    connectorRevision,
    userBinding,
    expiresAt,
    result: {
      outcome,
      channelHandle,
      connectorRevision: resultRevision,
      selection: {
        providerKey,
        attemptHandle: stringValue(
          selection.attemptHandle,
          'selection attempt',
          256
        ),
        expiresAt: expiryValue(selection.expiresAt),
        options: selection.options.map((option) => {
          if (!isRecord(option)) throw new Error('Invalid selection option.');
          const picture =
            option.picture === undefined
              ? undefined
              : stringValue(option.picture, 'selection picture');
          return {
            optionRef: stringValue(
              option.optionRef,
              'selection reference',
              256
            ),
            label: stringValue(option.label, 'selection label', 512),
            ...(picture === undefined ? {} : { picture }),
          };
        }),
      },
    },
  };
}

@Injectable()
export class RedisBizzbloxConnectionStateStore
  implements BizzbloxConnectionStateStore
{
  constructor(
    @Inject(BIZZBLOX_REDIS)
    private readonly redis: BizzbloxConnectionStateRedis,
    @Inject(BIZZBLOX_CONNECTION_STATE_CODEC)
    private readonly codec: BizzbloxConnectionStateCodec,
    @Optional()
    @Inject(BIZZBLOX_CLOCK)
    private readonly clock: () => Date = () => new Date()
  ) {}

  private async save(
    key: string,
    purpose: StatePurpose,
    state:
      | BizzbloxAuthorizationState
      | BizzbloxSelectionState
      | BizzbloxConnectionOutcomeState
  ): Promise<void> {
    const ttl = state.expiresAt - this.clock().getTime();
    if (ttl <= 0 || ttl > 10 * 60_000) {
      throw new Error('Invalid connection state expiry.');
    }
    const envelope = this.codec.seal(JSON.stringify(state), purpose);
    const result = await this.redis.set(key, envelope, 'PX', ttl, 'NX');
    if (result !== 'OK') throw new Error('Connection state collision.');
  }

  async saveOutcome(
    outcomeHandle: string,
    state: BizzbloxConnectionOutcomeState
  ): Promise<void> {
    await this.save(
      stateKey('outcome', [
        state.organizationId,
        String(state.connectorRevision),
        state.userBinding,
        outcomeHandle,
      ]),
      'outcome',
      state
    );
  }

  async consumeOutcome(
    organizationId: string,
    connectorRevision: number,
    userBinding: string,
    outcomeHandle: string
  ): Promise<BizzbloxConnectionOutcomeState | null> {
    const envelope = await this.redis.getdel(
      stateKey('outcome', [
        organizationId,
        String(connectorRevision),
        userBinding,
        outcomeHandle,
      ])
    );
    if (!envelope) return null;
    const state = outcomeState(this.codec.unseal(envelope, 'outcome'));
    const left = Buffer.from(
      `${state.organizationId}\u0000${state.connectorRevision}\u0000${state.userBinding}`,
      'utf8'
    );
    const right = Buffer.from(
      `${organizationId}\u0000${connectorRevision}\u0000${userBinding}`,
      'utf8'
    );
    if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) {
      return null;
    }
    return state;
  }

  async saveAuthorization(
    providerState: string,
    state: BizzbloxAuthorizationState
  ): Promise<void> {
    await this.save(
      stateKey('authorization', [providerState]),
      'authorization',
      state
    );
  }

  async consumeAuthorization(
    providerState: string
  ): Promise<BizzbloxAuthorizationState | null> {
    const envelope = await this.redis.getdel(
      stateKey('authorization', [providerState])
    );
    if (!envelope) return null;
    return authorizationState(this.codec.unseal(envelope, 'authorization'));
  }

  async saveSelection(
    attemptHandle: string,
    state: BizzbloxSelectionState
  ): Promise<void> {
    await this.save(
      stateKey('selection', [
        state.organizationId,
        String(state.connectorRevision),
        attemptHandle,
      ]),
      'selection',
      state
    );
  }

  async consumeSelection(
    organizationId: string,
    connectorRevision: number,
    attemptHandle: string
  ): Promise<BizzbloxSelectionState | null> {
    const envelope = await this.redis.getdel(
      stateKey('selection', [
        organizationId,
        String(connectorRevision),
        attemptHandle,
      ])
    );
    if (!envelope) return null;
    const state = selectionState(this.codec.unseal(envelope, 'selection'));
    const left = Buffer.from(
      `${state.organizationId}\u0000${state.connectorRevision}`,
      'utf8'
    );
    const right = Buffer.from(
      `${organizationId}\u0000${connectorRevision}`,
      'utf8'
    );
    if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) {
      return null;
    }
    return state;
  }
}
