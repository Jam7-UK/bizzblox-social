import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { JsonValue } from '@bizzblox/postiz-agent-client';

import type { BizzbloxSocialEnvironment } from './bizzblox-environment';
import {
  BIZZBLOX_CHANNEL_DIRECTORY,
  BIZZBLOX_OPAQUE_REFS,
  type BizzbloxChannelDirectory,
  type BizzbloxOpaqueRefs,
} from './bizzblox-contract.service';

export const BIZZBLOX_CONNECTION_PROVIDERS = Symbol(
  'BIZZBLOX_CONNECTION_PROVIDERS'
);
export const BIZZBLOX_CONNECTION_STATES = Symbol('BIZZBLOX_CONNECTION_STATES');
export const BIZZBLOX_CONNECTION_CONFIG = Symbol('BIZZBLOX_CONNECTION_CONFIG');

export type BizzbloxConnectionField = Readonly<{
  fieldRef: string;
  label: string;
  type: 'password' | 'text';
  defaultValue?: string;
  hint?: string;
}>;

export type BizzbloxConnectionProviderDescription =
  | Readonly<{ mode: 'oauth' }>
  | Readonly<{
      mode: 'form';
      fields: readonly BizzbloxConnectionField[];
    }>
  | Readonly<{ mode: 'manual'; instructions: string }>;

export type BizzbloxConnectionProviderSummary = Readonly<{
  providerKey: string;
  label: string;
  connectionMode: 'oauth' | 'form' | 'manual';
}>;

export type BizzbloxProviderSelectionOption = Readonly<{
  optionRef: string;
  label: string;
  picture: string | null;
  selector: Readonly<Record<string, JsonValue>>;
}>;

export type BizzbloxProviderConnectionOutcome = Readonly<{
  integrationId: string;
  selections: readonly BizzbloxProviderSelectionOption[];
}>;

export interface BizzbloxConnectionProviderGateway {
  listProviders(): Promise<readonly BizzbloxConnectionProviderSummary[]>;
  describe(provider: string): Promise<BizzbloxConnectionProviderDescription>;
  beginAuthorization(
    provider: string,
    callbackUrl: string
  ): Promise<
    Readonly<{
      authorizationUrl: string;
      providerState: string;
      codeVerifier: string;
    }>
  >;
  /**
   * Maps the provider's redirect query to the state / code pair
   * `completeAuthorization` consumes. Absent means the OAuth 2.0 names.
   */
  readCallback?(
    provider: string,
    query: Readonly<Record<string, string>>
  ): Readonly<{ providerState: string; code: string }>;
  completeAuthorization(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      code: string;
      codeVerifier: string;
      callbackUrl: string;
      reconnectIntegrationId?: string;
    }>
  ): Promise<BizzbloxProviderConnectionOutcome>;
  completeCustomFields(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      fields: Readonly<Record<string, string>>;
      reconnectIntegrationId?: string;
    }>
  ): Promise<BizzbloxProviderConnectionOutcome>;
  completeManual?(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      code: string;
      reconnectIntegrationId?: string;
    }>
  ): Promise<BizzbloxProviderConnectionOutcome>;
  selectAccount(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      integrationId: string;
      selector: Readonly<Record<string, JsonValue>>;
    }>
  ): Promise<void>;
  disconnectAccount?(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      integrationId: string;
    }>
  ): Promise<Readonly<{ outcome: 'removed' | 'reconcile_required' }>>;
  resolveReconnectProvider?(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      integrationId: string;
    }>
  ): Promise<string>;
}

export type BizzbloxAuthorizationState = Readonly<{
  organizationId: string;
  connectorRevision: number;
  environment: BizzbloxSocialEnvironment;
  provider: string;
  codeVerifier: string;
  ampReturnUrl: string;
  expiresAt: number;
  userBinding?: string;
  outcomeHandle?: string;
  reconnectChannelHandle?: string;
}>;

export type BizzbloxSelectionState = Readonly<{
  organizationId: string;
  connectorRevision: number;
  environment: BizzbloxSocialEnvironment;
  userBinding?: string;
  provider: string;
  integrationId: string;
  ampReturnUrl: string;
  expiresAt: number;
  options: readonly BizzbloxProviderSelectionOption[];
}>;

export type BizzbloxConnectionOutcomeResult =
  | Readonly<{
      outcome: 'connected';
      channelHandle: string;
      connectorRevision: number;
    }>
  | Readonly<{
      outcome: 'selection_required';
      channelHandle: string;
      connectorRevision: number;
      selection: Readonly<{
        providerKey: string;
        attemptHandle: string;
        expiresAt: number;
        options: readonly Readonly<{
          optionRef: string;
          label: string;
          picture?: string;
        }>[];
      }>;
    }>
  | Readonly<{ outcome: 'failed' }>;

export type BizzbloxConnectionOutcomeState = Readonly<{
  organizationId: string;
  connectorRevision: number;
  environment: BizzbloxSocialEnvironment;
  userBinding: string;
  expiresAt: number;
  result: BizzbloxConnectionOutcomeResult;
}>;

export interface BizzbloxConnectionStateStore {
  saveAuthorization(
    providerState: string,
    state: BizzbloxAuthorizationState
  ): Promise<void>;
  consumeAuthorization(
    providerState: string
  ): Promise<BizzbloxAuthorizationState | null>;
  saveSelection(
    attemptHandle: string,
    state: BizzbloxSelectionState
  ): Promise<void>;
  consumeSelection(
    organizationId: string,
    connectorRevision: number,
    environment: BizzbloxSocialEnvironment,
    attemptHandle: string
  ): Promise<BizzbloxSelectionState | null>;
  saveOutcome?(
    outcomeHandle: string,
    state: BizzbloxConnectionOutcomeState
  ): Promise<void>;
  consumeOutcome?(
    organizationId: string,
    connectorRevision: number,
    environment: BizzbloxSocialEnvironment,
    userBinding: string,
    outcomeHandle: string
  ): Promise<BizzbloxConnectionOutcomeState | null>;
}

export type BizzbloxConnectionConfig = Readonly<{
  ampReturnUrls: Readonly<Record<BizzbloxSocialEnvironment, string>>;
  clock: () => Date;
  createOpaqueHandle?: () => string;
  publicOrigin: string;
}>;

export class BizzbloxConnectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BizzbloxConnectionInputError';
  }
}

function providerIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(normalized)) {
    throw new BizzbloxConnectionInputError('Invalid social provider.');
  }
  return normalized;
}

function boundedCallbackValue(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) {
    throw new BizzbloxConnectionInputError(
      'Invalid social connection callback.'
    );
  }
  return normalized;
}

function opaqueChannelHandle(value: string): string {
  const normalized = value.trim();
  if (!/^bbx_ch_[A-Za-z0-9_-]{8,256}$/.test(normalized)) {
    throw new BizzbloxConnectionInputError('Invalid social channel.');
  }
  return normalized;
}

function opaqueUserBinding(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!/^[A-Za-z0-9:_-]{16,256}$/.test(normalized)) {
    throw new BizzbloxConnectionInputError('Invalid connection user binding.');
  }
  return normalized;
}

function opaqueOutcomeHandle(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(normalized)) {
    throw new BizzbloxConnectionInputError('Invalid connection outcome.');
  }
  return normalized;
}

function validatedConfig(config: BizzbloxConnectionConfig) {
  const publicOrigin = new URL(config.publicOrigin);
  if (
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.origin !== 'https://social.bizzblox.com' ||
    publicOrigin.pathname !== '/' ||
    publicOrigin.search ||
    publicOrigin.hash
  ) {
    throw new Error('Invalid BizzBLOX connection redirect configuration.');
  }
  const ampReturnUrls = Object.fromEntries(
    Object.entries(config.ampReturnUrls).map(([environment, value]) => {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        (!url.hostname.endsWith('.bizzblox.com') &&
          !url.hostname.endsWith('.jam7.com')) ||
        url.pathname !== '/settings/social' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error('Invalid BizzBLOX connection redirect configuration.');
      }
      return [environment, url.toString()];
    })
  ) as Record<BizzbloxSocialEnvironment, string>;
  return Object.freeze({
    ampReturnUrls: Object.freeze(ampReturnUrls),
    clock: config.clock,
    createOpaqueHandle: config.createOpaqueHandle ?? randomUUID,
    publicOrigin: publicOrigin.origin,
  });
}

@Injectable()
export class BizzbloxConnectionsService {
  private readonly config: ReturnType<typeof validatedConfig>;

  constructor(
    @Inject(BIZZBLOX_CONNECTION_PROVIDERS)
    private readonly providers: BizzbloxConnectionProviderGateway,
    @Inject(BIZZBLOX_CONNECTION_STATES)
    private readonly states: BizzbloxConnectionStateStore,
    @Inject(BIZZBLOX_CONNECTION_CONFIG) config: BizzbloxConnectionConfig,
    @Optional()
    @Inject(BIZZBLOX_CHANNEL_DIRECTORY)
    private readonly channels?: BizzbloxChannelDirectory,
    @Optional()
    @Inject(BIZZBLOX_OPAQUE_REFS)
    private readonly refs?: BizzbloxOpaqueRefs
  ) {
    this.config = validatedConfig(config);
  }

  async listProviders() {
    return await this.providers.listProviders();
  }

  async disconnect(
    organizationId: string,
    connectorRevision: number,
    input: Readonly<{ channelHandle: string }>
  ) {
    const channelHandle = opaqueChannelHandle(input.channelHandle);
    if (!this.channels || !this.providers.disconnectAccount) {
      throw new Error('Social channel recovery is unavailable.');
    }
    const channel = await this.channels.read(organizationId, channelHandle);
    if (!channel || channel.organizationId !== organizationId) {
      throw new BizzbloxConnectionInputError('Social channel was not found.');
    }
    if (channel.connectorRevision !== connectorRevision) {
      throw new BizzbloxConnectionInputError(
        'Social channel revision is stale.'
      );
    }
    if (channel.status === 'disconnected') {
      return Object.freeze({ outcome: 'disconnected' as const });
    }
    const removal = await this.providers.disconnectAccount({
      organizationId,
      connectorRevision,
      integrationId: channel.integrationId,
    });
    if (removal.outcome !== 'removed') {
      return Object.freeze({ outcome: 'reconcile_required' as const });
    }
    const disconnected = await this.channels.markDisconnected({
      organizationId,
      channelHandle,
      connectorRevision,
    });
    if (!disconnected || disconnected.status !== 'disconnected') {
      return Object.freeze({ outcome: 'reconcile_required' as const });
    }
    return Object.freeze({ outcome: 'removed' as const });
  }

  async reconnect(
    organizationId: string,
    connectorRevision: number,
    environment: BizzbloxSocialEnvironment,
    input: Readonly<{
      channelHandle: string;
      userBinding?: string;
      fields?: Readonly<Record<string, string>>;
      manualCode?: string;
    }>
  ) {
    const channelHandle = opaqueChannelHandle(input.channelHandle);
    if (!this.channels || !this.providers.resolveReconnectProvider) {
      throw new Error('Social channel recovery is unavailable.');
    }
    const channel = await this.channels.read(organizationId, channelHandle);
    if (
      !channel ||
      channel.organizationId !== organizationId ||
      channel.connectorRevision !== connectorRevision
    ) {
      throw new BizzbloxConnectionInputError(
        'Social channel is stale or foreign.'
      );
    }
    const provider = providerIdentifier(
      await this.providers.resolveReconnectProvider({
        organizationId,
        connectorRevision,
        integrationId: channel.integrationId,
      })
    );
    const description = await this.providers.describe(provider);
    if (description.mode === 'form') {
      if (!input.fields) return description;
      const connection = await this.providers.completeCustomFields({
        organizationId,
        connectorRevision,
        provider,
        fields: input.fields,
        reconnectIntegrationId: channel.integrationId,
      });
      if (
        connection.integrationId !== channel.integrationId ||
        connection.selections.length > 0
      ) {
        throw new BizzbloxConnectionInputError(
          'This provider requires account selection.'
        );
      }
      return Object.freeze({
        mode: 'connected' as const,
        channelHandle,
        connectorRevision,
      });
    }
    if (description.mode === 'manual') {
      if (input.fields) {
        throw new BizzbloxConnectionInputError(
          'Invalid manual provider connection.'
        );
      }
      if (input.manualCode === undefined) return description;
      if (!this.providers.completeManual) {
        throw new BizzbloxConnectionInputError(
          'This provider connection is unavailable.'
        );
      }
      const connection = await this.providers.completeManual({
        organizationId,
        connectorRevision,
        provider,
        code: boundedCallbackValue(input.manualCode),
        reconnectIntegrationId: channel.integrationId,
      });
      if (
        connection.integrationId !== channel.integrationId ||
        connection.selections.length > 0
      ) {
        throw new BizzbloxConnectionInputError(
          'This provider requires account selection.'
        );
      }
      return Object.freeze({
        mode: 'connected' as const,
        channelHandle,
        connectorRevision,
      });
    }
    if (input.fields || input.manualCode !== undefined) {
      throw new BizzbloxConnectionInputError(
        'OAuth providers do not accept connection fields.'
      );
    }
    const callbackUrl = new URL(
      `/oauth/bizzblox/callback/${provider}`,
      this.config.publicOrigin
    ).toString();
    const authorization = await this.providers.beginAuthorization(
      provider,
      callbackUrl
    );
    const userBinding = opaqueUserBinding(input.userBinding);
    const outcomeHandle = opaqueOutcomeHandle(this.config.createOpaqueHandle());
    const expiresAt = this.config.clock().getTime() + 10 * 60_000;
    await this.states.saveAuthorization(authorization.providerState, {
      organizationId,
      connectorRevision,
      environment,
      provider,
      codeVerifier: authorization.codeVerifier,
      ampReturnUrl: this.config.ampReturnUrls[environment],
      expiresAt,
      userBinding,
      outcomeHandle,
      reconnectChannelHandle: channelHandle,
    });
    return Object.freeze({
      mode: 'redirect' as const,
      authorizationUrl: authorization.authorizationUrl,
      expiresAt,
    });
  }

  async begin(
    organizationId: string,
    connectorRevision: number,
    environment: BizzbloxSocialEnvironment,
    input: Readonly<{
      provider: string;
      userBinding?: string;
      fields?: Readonly<Record<string, string>>;
      manualCode?: string;
    }>
  ) {
    const provider = providerIdentifier(input.provider);
    const description = await this.providers.describe(provider);
    if (description.mode === 'form') {
      if (!input.fields) return description;
      if (!this.refs) {
        throw new Error('Social channel references are unavailable.');
      }
      const connection = await this.providers.completeCustomFields({
        organizationId,
        connectorRevision,
        provider,
        fields: input.fields,
      });
      if (connection.selections.length > 0) {
        throw new BizzbloxConnectionInputError(
          'This provider requires account selection.'
        );
      }
      return Object.freeze({
        mode: 'connected' as const,
        channelHandle: this.refs.channel(
          organizationId,
          connection.integrationId
        ),
        connectorRevision,
      });
    }
    if (description.mode === 'manual') {
      if (input.fields) {
        throw new BizzbloxConnectionInputError(
          'Invalid manual provider connection.'
        );
      }
      if (input.manualCode === undefined) return description;
      const code = boundedCallbackValue(input.manualCode);
      if (!this.providers.completeManual) {
        throw new BizzbloxConnectionInputError(
          'This provider connection is unavailable.'
        );
      }
      if (!this.refs) {
        throw new Error('Social channel references are unavailable.');
      }
      const connection = await this.providers.completeManual({
        organizationId,
        connectorRevision,
        provider,
        code,
      });
      if (connection.selections.length > 0) {
        throw new BizzbloxConnectionInputError(
          'This provider requires account selection.'
        );
      }
      return Object.freeze({
        mode: 'connected' as const,
        channelHandle: this.refs.channel(
          organizationId,
          connection.integrationId
        ),
        connectorRevision,
      });
    }
    if (input.fields || input.manualCode !== undefined) {
      throw new BizzbloxConnectionInputError(
        'OAuth providers do not accept connection fields.'
      );
    }
    const callbackUrl = new URL(
      `/oauth/bizzblox/callback/${provider}`,
      this.config.publicOrigin
    ).toString();
    const authorization = await this.providers.beginAuthorization(
      provider,
      callbackUrl
    );
    const userBinding = opaqueUserBinding(input.userBinding);
    const outcomeHandle = opaqueOutcomeHandle(this.config.createOpaqueHandle());
    const expiresAt = this.config.clock().getTime() + 10 * 60_000;
    await this.states.saveAuthorization(authorization.providerState, {
      organizationId,
      connectorRevision,
      environment,
      provider,
      codeVerifier: authorization.codeVerifier,
      ampReturnUrl: this.config.ampReturnUrls[environment],
      expiresAt,
      userBinding,
      outcomeHandle,
    });
    return Object.freeze({
      mode: 'redirect' as const,
      authorizationUrl: authorization.authorizationUrl,
      expiresAt,
    });
  }

  /**
   * Finishes provider consent from the raw redirect query. The provider gateway
   * decides which query names carry the state and code (X is OAuth 1.0a and
   * returns `oauth_token` / `oauth_verifier`). A redirect that names the state
   * but no code (denied scopes, cancelled sign-in) records a failed outcome on
   * the caller's handle so AMP can say the account could not be connected; only
   * an unrecognised state falls to the generic failure redirect.
   */
  async completeCallback(
    input: Readonly<{
      provider: string;
      query: Readonly<Record<string, string>>;
    }>
  ) {
    let state: BizzbloxAuthorizationState | null = null;
    const failedRedirectUrl = new URL(this.config.ampReturnUrls.dev);
    failedRedirectUrl.searchParams.set('social', 'failed');
    const failed = Object.freeze({
      outcome: 'failed' as const,
      redirectUrl: failedRedirectUrl.toString(),
    });
    try {
      const provider = providerIdentifier(input.provider);
      const callback = this.providers.readCallback
        ? this.providers.readCallback(provider, input.query)
        : {
            providerState: input.query.state ?? '',
            code: input.query.code ?? '',
          };
      const providerState = boundedCallbackValue(callback.providerState);
      state = await this.states.consumeAuthorization(providerState);
      if (
        !state ||
        state.provider !== provider ||
        state.ampReturnUrl !== this.config.ampReturnUrls[state.environment] ||
        !state.userBinding ||
        !state.outcomeHandle ||
        state.expiresAt <= this.config.clock().getTime()
      ) {
        return failed;
      }
      const userBinding = opaqueUserBinding(state.userBinding);
      const outcomeHandle = opaqueOutcomeHandle(state.outcomeHandle);
      if (!this.states.saveOutcome || !this.refs) return failed;
      const code = boundedCallbackValue(callback.code);

      const callbackUrl = new URL(
        `/oauth/bizzblox/callback/${provider}`,
        this.config.publicOrigin
      ).toString();
      const reconnectChannel = state.reconnectChannelHandle
        ? await this.channels?.read(
            state.organizationId,
            state.reconnectChannelHandle
          )
        : undefined;
      if (
        state.reconnectChannelHandle &&
        (!reconnectChannel ||
          reconnectChannel.connectorRevision !== state.connectorRevision ||
          reconnectChannel.organizationId !== state.organizationId)
      ) {
        return failed;
      }
      const connection = await this.providers.completeAuthorization({
        organizationId: state.organizationId,
        connectorRevision: state.connectorRevision,
        provider,
        code,
        codeVerifier: state.codeVerifier,
        callbackUrl,
        ...(reconnectChannel
          ? { reconnectIntegrationId: reconnectChannel.integrationId }
          : {}),
      });
      if (
        reconnectChannel &&
        connection.integrationId !== reconnectChannel.integrationId
      ) {
        throw new Error('Reconnect integration changed.');
      }
      const channelHandle =
        reconnectChannel?.channelHandle ??
        this.refs.channel(state.organizationId, connection.integrationId);
      if (connection.selections.length > 0) {
        const attemptHandle = this.config.createOpaqueHandle();
        const expiresAt = this.config.clock().getTime() + 5 * 60_000;
        const options = connection.selections.map((selection) => ({
          optionRef: this.config.createOpaqueHandle(),
          label: selection.label,
          picture: selection.picture,
          selector: selection.selector,
        }));
        await this.states.saveSelection(attemptHandle, {
          organizationId: state.organizationId,
          connectorRevision: state.connectorRevision,
          environment: state.environment,
          provider,
          integrationId: connection.integrationId,
          userBinding,
          ampReturnUrl: state.ampReturnUrl,
          expiresAt,
          options,
        });
        await this.states.saveOutcome(outcomeHandle, {
          organizationId: state.organizationId,
          connectorRevision: state.connectorRevision,
          environment: state.environment,
          userBinding,
          expiresAt: state.expiresAt,
          result: {
            outcome: 'selection_required',
            channelHandle,
            connectorRevision: state.connectorRevision,
            selection: {
              providerKey: provider,
              attemptHandle,
              expiresAt,
              options: options.map(({ optionRef, label, picture }) => ({
                optionRef,
                label,
                ...(picture === null ? {} : { picture }),
              })),
            },
          },
        });
        const redirectUrl = new URL(state.ampReturnUrl);
        redirectUrl.searchParams.set('outcome', outcomeHandle);
        return Object.freeze({
          outcome: 'ready' as const,
          redirectUrl: redirectUrl.toString(),
        });
      }

      await this.states.saveOutcome(outcomeHandle, {
        organizationId: state.organizationId,
        connectorRevision: state.connectorRevision,
        environment: state.environment,
        userBinding,
        expiresAt: state.expiresAt,
        result: {
          outcome: 'connected',
          channelHandle,
          connectorRevision: state.connectorRevision,
        },
      });
      const redirectUrl = new URL(state.ampReturnUrl);
      redirectUrl.searchParams.set('outcome', outcomeHandle);
      return Object.freeze({
        outcome: 'ready' as const,
        redirectUrl: redirectUrl.toString(),
      });
    } catch {
      if (
        state?.userBinding &&
        state.outcomeHandle &&
        state.expiresAt > this.config.clock().getTime() &&
        this.states.saveOutcome
      ) {
        try {
          const userBinding = opaqueUserBinding(state.userBinding);
          const outcomeHandle = opaqueOutcomeHandle(state.outcomeHandle);
          await this.states.saveOutcome(outcomeHandle, {
            organizationId: state.organizationId,
            connectorRevision: state.connectorRevision,
            environment: state.environment,
            userBinding,
            expiresAt: state.expiresAt,
            result: { outcome: 'failed' },
          });
          const redirectUrl = new URL(state.ampReturnUrl);
          redirectUrl.searchParams.set('outcome', outcomeHandle);
          return Object.freeze({
            outcome: 'ready' as const,
            redirectUrl: redirectUrl.toString(),
          });
        } catch {
          return failed;
        }
      }
      return failed;
    }
  }

  async redeemOutcome(
    organizationId: string,
    connectorRevision: number,
    environment: BizzbloxSocialEnvironment,
    input: Readonly<{ userBinding: string; outcomeHandle: string }>
  ): Promise<BizzbloxConnectionOutcomeResult> {
    if (!this.states.consumeOutcome) {
      throw new Error('Connection outcome redemption is unavailable.');
    }
    const userBinding = opaqueUserBinding(input.userBinding);
    const outcomeHandle = opaqueOutcomeHandle(input.outcomeHandle);
    const state = await this.states.consumeOutcome(
      organizationId,
      connectorRevision,
      environment,
      userBinding,
      outcomeHandle
    );
    if (
      !state ||
      state.organizationId !== organizationId ||
      state.connectorRevision !== connectorRevision ||
      state.environment !== environment ||
      state.userBinding !== userBinding ||
      state.expiresAt <= this.config.clock().getTime()
    ) {
      throw new BizzbloxConnectionInputError(
        'Connection outcome is stale or already used.'
      );
    }
    return state.result;
  }

  async select(
    organizationId: string,
    connectorRevision: number,
    environment: BizzbloxSocialEnvironment,
    input: Readonly<{
      attemptHandle: string;
      optionRef: string;
      userBinding?: string;
    }>
  ) {
    const failed = Object.freeze({ outcome: 'failed' as const });

    try {
      const attemptHandle = boundedCallbackValue(input.attemptHandle);
      const optionRef = boundedCallbackValue(input.optionRef);
      const state = await this.states.consumeSelection(
        organizationId,
        connectorRevision,
        environment,
        attemptHandle
      );
      if (
        !state ||
        state.organizationId !== organizationId ||
        state.connectorRevision !== connectorRevision ||
        state.environment !== environment ||
        state.expiresAt <= this.config.clock().getTime() ||
        !state.userBinding ||
        state.userBinding !== opaqueUserBinding(input.userBinding)
      ) {
        return failed;
      }
      const option = state.options.find(
        (candidate) => candidate.optionRef === optionRef
      );
      if (!option) {
        return failed;
      }

      await this.providers.selectAccount({
        organizationId,
        connectorRevision,
        provider: state.provider,
        integrationId: state.integrationId,
        selector: option.selector,
      });
      if (!this.refs) return failed;
      return Object.freeze({
        outcome: 'connected' as const,
        channelHandle: this.refs.channel(organizationId, state.integrationId),
        connectorRevision,
      });
    } catch {
      return failed;
    }
  }
}
