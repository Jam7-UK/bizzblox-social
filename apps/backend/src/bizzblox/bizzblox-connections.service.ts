import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { JsonValue } from '@bizzblox/postiz-agent-client';

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
  completeAuthorization(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      code: string;
      codeVerifier: string;
      callbackUrl: string;
    }>
  ): Promise<BizzbloxProviderConnectionOutcome>;
  completeCustomFields(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      fields: Readonly<Record<string, string>>;
    }>
  ): Promise<BizzbloxProviderConnectionOutcome>;
  completeManual?(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      code: string;
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
}

export type BizzbloxAuthorizationState = Readonly<{
  organizationId: string;
  connectorRevision: number;
  provider: string;
  codeVerifier: string;
  ampReturnUrl: string;
  expiresAt: number;
}>;

export type BizzbloxSelectionState = Readonly<{
  organizationId: string;
  connectorRevision: number;
  provider: string;
  integrationId: string;
  ampReturnUrl: string;
  expiresAt: number;
  options: readonly BizzbloxProviderSelectionOption[];
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
    attemptHandle: string
  ): Promise<BizzbloxSelectionState | null>;
}

export type BizzbloxConnectionConfig = Readonly<{
  ampReturnUrl: string;
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

function validatedConfig(config: BizzbloxConnectionConfig) {
  const publicOrigin = new URL(config.publicOrigin);
  const ampReturnUrl = new URL(config.ampReturnUrl);
  if (
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.origin !== 'https://social.bizzblox.com' ||
    publicOrigin.pathname !== '/' ||
    publicOrigin.search ||
    publicOrigin.hash ||
    ampReturnUrl.protocol !== 'https:' ||
    !ampReturnUrl.hostname.endsWith('.bizzblox.com') ||
    !ampReturnUrl.pathname.startsWith('/settings') ||
    ampReturnUrl.username ||
    ampReturnUrl.password ||
    ampReturnUrl.search ||
    ampReturnUrl.hash
  ) {
    throw new Error('Invalid BizzBLOX connection redirect configuration.');
  }
  return Object.freeze({
    ampReturnUrl: ampReturnUrl.toString(),
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
    @Inject(BIZZBLOX_CONNECTION_CONFIG) config: BizzbloxConnectionConfig
  ) {
    this.config = validatedConfig(config);
  }

  async listProviders() {
    return await this.providers.listProviders();
  }

  async begin(
    organizationId: string,
    connectorRevision: number,
    input: Readonly<{
      provider: string;
      fields?: Readonly<Record<string, string>>;
      manualCode?: string;
    }>
  ) {
    const provider = providerIdentifier(input.provider);
    const description = await this.providers.describe(provider);
    if (description.mode === 'form') {
      if (!input.fields) return description;
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
      return Object.freeze({ mode: 'connected' as const, provider });
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
      return Object.freeze({ mode: 'connected' as const, provider });
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
    const expiresAt = this.config.clock().getTime() + 10 * 60_000;
    await this.states.saveAuthorization(authorization.providerState, {
      organizationId,
      connectorRevision,
      provider,
      codeVerifier: authorization.codeVerifier,
      ampReturnUrl: this.config.ampReturnUrl,
      expiresAt,
    });
    return Object.freeze({
      mode: 'redirect' as const,
      authorizationUrl: authorization.authorizationUrl,
      expiresAt,
    });
  }

  async completeCallback(
    input: Readonly<{
      provider: string;
      providerState: string;
      code: string;
    }>
  ) {
    const failed = Object.freeze({
      outcome: 'failed' as const,
      redirectUrl: `${this.config.ampReturnUrl}?social=failed`,
    });

    try {
      const provider = providerIdentifier(input.provider);
      const providerState = boundedCallbackValue(input.providerState);
      const code = boundedCallbackValue(input.code);
      const state = await this.states.consumeAuthorization(providerState);
      if (
        !state ||
        state.provider !== provider ||
        state.expiresAt <= this.config.clock().getTime()
      ) {
        return failed;
      }

      const callbackUrl = new URL(
        `/oauth/bizzblox/callback/${provider}`,
        this.config.publicOrigin
      ).toString();
      const connection = await this.providers.completeAuthorization({
        organizationId: state.organizationId,
        connectorRevision: state.connectorRevision,
        provider,
        code,
        codeVerifier: state.codeVerifier,
        callbackUrl,
      });
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
          provider,
          integrationId: connection.integrationId,
          ampReturnUrl: this.config.ampReturnUrl,
          expiresAt,
          options,
        });
        return Object.freeze({
          outcome: 'selection_required' as const,
          attemptHandle,
          expiresAt,
          options: options.map(({ optionRef, label, picture }) => ({
            optionRef,
            label,
            picture,
          })),
        });
      }

      const redirectUrl = new URL(this.config.ampReturnUrl);
      redirectUrl.searchParams.set('social', 'connected');
      redirectUrl.searchParams.set('provider', provider);
      return Object.freeze({
        outcome: 'connected' as const,
        redirectUrl: redirectUrl.toString(),
      });
    } catch {
      return failed;
    }
  }

  async select(
    organizationId: string,
    connectorRevision: number,
    input: Readonly<{ attemptHandle: string; optionRef: string }>
  ) {
    const failed = Object.freeze({ outcome: 'failed' as const });

    try {
      const attemptHandle = boundedCallbackValue(input.attemptHandle);
      const optionRef = boundedCallbackValue(input.optionRef);
      const state = await this.states.consumeSelection(
        organizationId,
        connectorRevision,
        attemptHandle
      );
      if (
        !state ||
        state.organizationId !== organizationId ||
        state.connectorRevision !== connectorRevision ||
        state.expiresAt <= this.config.clock().getTime()
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
      const redirectUrl = new URL(this.config.ampReturnUrl);
      redirectUrl.searchParams.set('social', 'connected');
      redirectUrl.searchParams.set('provider', state.provider);
      return Object.freeze({
        outcome: 'connected' as const,
        redirectUrl: redirectUrl.toString(),
      });
    } catch {
      return failed;
    }
  }
}
