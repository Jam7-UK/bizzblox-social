import { Inject, Injectable, Optional } from '@nestjs/common';

import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import type {
  AuthTokenDetails,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

import type { JsonValue } from '@bizzblox/postiz-agent-client';

import type {
  BizzbloxConnectionField,
  BizzbloxConnectionProviderDescription,
  BizzbloxConnectionProviderGateway,
  BizzbloxConnectionProviderSummary,
  BizzbloxProviderConnectionOutcome,
  BizzbloxProviderSelectionOption,
} from './bizzblox-connections.service';

export const BIZZBLOX_CUSTOM_FIELD_SEALER = Symbol(
  'BIZZBLOX_CUSTOM_FIELD_SEALER'
);

export interface BizzbloxCustomFieldSealer {
  seal(fields: Readonly<Record<string, string>>): string;
}

type SelectableProvider = SocialProvider & {
  companies?: (
    accessToken: string,
    params?: Readonly<Record<string, never>>,
    id?: string
  ) => Promise<unknown[]>;
  pages?: (accessToken: string) => Promise<unknown[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function safePicture(value: unknown): string | null {
  const candidate =
    boundedText(value, 2_048) ??
    (isRecord(value) && isRecord(value.data)
      ? boundedText(value.data.url, 2_048)
      : null);
  if (!candidate) return null;
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

function safeJson(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 8) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') {
    return value.length <= 16_384 ? value : undefined;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 250) return undefined;
    const items = value.map((item) => safeJson(item, depth + 1));
    return items.some((item) => item === undefined)
      ? undefined
      : (items as JsonValue[]);
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    const entries = Object.entries(value);
    if (entries.length > 250) return undefined;
    for (const [key, item] of entries) {
      if (
        !key ||
        key.length > 128 ||
        /(authorization|cookie|credential|password|secret|token)/i.test(key)
      ) {
        continue;
      }
      const safe = safeJson(item, depth + 1);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
  return undefined;
}

function selectionOption(
  value: unknown,
  index: number
): BizzbloxProviderSelectionOption | null {
  if (!isRecord(value)) return null;
  const selector = safeJson(value);
  if (!isRecord(selector) || Object.keys(selector).length === 0) return null;
  const identity =
    boundedText(value.id, 256) ??
    boundedText(value.page, 256) ??
    boundedText(value.pageId, 256) ??
    boundedText(value.accountName, 256) ??
    String(index + 1);
  const label =
    boundedText(value.name, 512) ??
    boundedText(value.label, 512) ??
    boundedText(value.username, 512) ??
    `Account ${index + 1}`;
  return {
    optionRef: identity,
    label,
    picture: safePicture(value.picture),
    selector,
  };
}

function validAuth(value: AuthTokenDetails | string): AuthTokenDetails {
  if (
    typeof value === 'string' ||
    value.error ||
    !boundedText(value.id, 512) ||
    !boundedText(value.accessToken, 32_768)
  ) {
    throw new Error('Provider authentication failed.');
  }
  return value;
}

@Injectable()
export class PostizBizzbloxConnectionProviderGateway
  implements BizzbloxConnectionProviderGateway
{
  constructor(
    private readonly manager: IntegrationManager,
    private readonly integrations: IntegrationService,
    private readonly refresh: RefreshIntegrationService,
    @Optional()
    @Inject(BIZZBLOX_CUSTOM_FIELD_SEALER)
    private readonly fieldSealer?: BizzbloxCustomFieldSealer
  ) {}

  async listProviders(): Promise<readonly BizzbloxConnectionProviderSummary[]> {
    const catalogue = await this.manager.getAllIntegrations();
    if (!Array.isArray(catalogue.social) || catalogue.social.length > 100) {
      throw new Error('Social provider catalogue is invalid.');
    }
    const seen = new Set<string>();
    const providers = catalogue.social.map((item) => {
      if (!isRecord(item))
        throw new Error('Social provider catalogue is invalid.');
      const providerKey = boundedText(item.identifier, 100);
      const label = boundedText(item.name, 200);
      if (
        !providerKey ||
        !/^[a-z0-9][a-z0-9-]{0,99}$/.test(providerKey) ||
        !label ||
        seen.has(providerKey)
      ) {
        throw new Error('Social provider catalogue is invalid.');
      }
      seen.add(providerKey);
      return Object.freeze({
        providerKey,
        label,
        connectionMode:
          item.customFields !== undefined
            ? ('form' as const)
            : item.isWeb3 === true
            ? ('manual' as const)
            : ('oauth' as const),
      });
    });
    return Object.freeze(
      providers.sort(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.providerKey.localeCompare(right.providerKey)
      )
    );
  }

  private provider(identifier: string): SelectableProvider {
    if (
      !this.manager.getAllowedSocialsIntegrations().includes(identifier) ||
      this.manager.isHiddenProvider(identifier)
    ) {
      throw new Error('Social provider is unavailable.');
    }
    const provider = this.manager.getSocialIntegration(identifier);
    if (!provider) throw new Error('Social provider is unavailable.');
    return provider as SelectableProvider;
  }

  async describe(
    identifier: string
  ): Promise<BizzbloxConnectionProviderDescription> {
    const provider = this.provider(identifier);
    if (provider.customFields) {
      const fields: BizzbloxConnectionField[] = (
        await provider.customFields()
      ).map((field) => ({
        fieldRef: field.key,
        label: field.label,
        type: field.type,
        ...(field.defaultValue === undefined
          ? {}
          : { defaultValue: field.defaultValue }),
        ...(field.hint === undefined ? {} : { hint: field.hint }),
      }));
      return { mode: 'form', fields };
    }
    if (provider.isWeb3) {
      return {
        mode: 'manual',
        instructions: 'Complete the provider connection steps in AMP.',
      };
    }
    return { mode: 'oauth' };
  }

  async beginAuthorization(identifier: string, callbackUrl: string) {
    const provider = this.provider(identifier);
    const authorization = await provider.generateAuthUrl(
      undefined,
      callbackUrl
    );
    return {
      authorizationUrl: authorization.url,
      providerState: authorization.state,
      codeVerifier: authorization.codeVerifier,
    };
  }

  async resolveReconnectProvider(input: {
    organizationId: string;
    connectorRevision: number;
    integrationId: string;
  }): Promise<string> {
    const integration = await this.integrations.getIntegrationById(
      input.organizationId,
      input.integrationId
    );
    if (!integration) throw new Error('Social channel was not found.');
    const provider = boundedText(integration.providerIdentifier, 100);
    if (!provider) throw new Error('Social channel provider is unavailable.');
    const migrationTarget = this.manager.getMigrationTarget(provider);
    return this.provider(migrationTarget ?? provider).identifier;
  }

  async completeAuthorization(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      code: string;
      codeVerifier: string;
      callbackUrl: string;
      reconnectIntegrationId?: string;
    }>
  ): Promise<BizzbloxProviderConnectionOutcome> {
    const provider = this.provider(input.provider);
    let auth = validAuth(
      await provider.authenticate({
        code: input.code,
        codeVerifier: input.codeVerifier,
        callbackUrl: input.callbackUrl,
      })
    );
    if (input.reconnectIntegrationId) {
      const existing = await this.integrations.getIntegrationById(
        input.organizationId,
        input.reconnectIntegrationId
      );
      if (!existing) throw new Error('Social channel was not found.');
      if (provider.reConnect) {
        auth = validAuth(
          await provider.reConnect(
            auth.id,
            existing.internalId,
            auth.accessToken
          )
        );
      }
      if (String(auth.id) !== String(existing.internalId)) {
        await this.integrations.migrateIntegration(
          input.organizationId,
          existing.internalId,
          provider.identifier,
          { id: String(auth.id), username: auth.username }
        );
      }
    }
    return await this.persist(input.organizationId, provider, auth);
  }

  async completeCustomFields(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      fields: Readonly<Record<string, string>>;
    }>
  ): Promise<BizzbloxProviderConnectionOutcome> {
    const provider = this.provider(input.provider);
    if (!provider.customFields || !this.fieldSealer) {
      throw new Error('Custom-field connection is unavailable.');
    }
    const definitions = await provider.customFields();
    const expectedKeys = definitions.map((field) => field.key).sort();
    const receivedKeys = Object.keys(input.fields).sort();
    if (
      expectedKeys.length === 0 ||
      expectedKeys.length !== receivedKeys.length ||
      expectedKeys.some((key, index) => key !== receivedKeys[index])
    ) {
      throw new Error('Invalid provider connection fields.');
    }
    const fields: Record<string, string> = {};
    for (const key of expectedKeys) {
      const value = input.fields[key];
      if (typeof value !== 'string' || !value || value.length > 16_384) {
        throw new Error('Invalid provider connection fields.');
      }
      fields[key] = value;
    }
    const auth = validAuth(
      await provider.authenticate({
        code: Buffer.from(JSON.stringify(fields), 'utf8').toString('base64'),
        codeVerifier: 'none',
      })
    );
    return await this.persist(
      input.organizationId,
      provider,
      auth,
      this.fieldSealer.seal(fields)
    );
  }

  async completeManual(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      code: string;
    }>
  ): Promise<BizzbloxProviderConnectionOutcome> {
    const provider = this.provider(input.provider);
    if (!provider.isWeb3 || provider.customFields) {
      throw new Error('Manual provider connection is unavailable.');
    }
    const auth = validAuth(
      await provider.authenticate({
        code: input.code,
        codeVerifier: 'none',
      })
    );
    return await this.persist(input.organizationId, provider, auth);
  }

  async selectAccount(
    input: Readonly<{
      organizationId: string;
      connectorRevision: number;
      provider: string;
      integrationId: string;
      selector: Readonly<Record<string, JsonValue>>;
    }>
  ): Promise<void> {
    this.provider(input.provider);
    await this.integrations.saveProviderPage(
      input.organizationId,
      input.integrationId,
      input.selector
    );
  }

  async disconnectAccount(input: {
    organizationId: string;
    connectorRevision: number;
    integrationId: string;
  }): Promise<void> {
    const integration = await this.integrations.getIntegrationById(
      input.organizationId,
      input.integrationId
    );
    if (!integration) throw new Error('Social channel was not found.');
    await this.integrations.disconnectChannel(
      input.organizationId,
      integration
    );
  }

  private async persist(
    organizationId: string,
    provider: SelectableProvider,
    auth: AuthTokenDetails,
    customInstanceDetails?: string
  ): Promise<BizzbloxProviderConnectionOutcome> {
    const internalId = String(auth.id);
    const name =
      boundedText(auth.name, 512) ??
      boundedText(auth.username, 512)?.split('.')[0] ??
      `Channel_${internalId.slice(0, 8)}`;
    const integration = await this.integrations.createOrUpdateIntegration(
      auth.additionalSettings,
      !!provider.oneTimeToken,
      organizationId,
      name.trim(),
      auth.picture,
      'social',
      internalId,
      provider.identifier,
      auth.accessToken,
      auth.refreshToken,
      auth.expiresIn,
      auth.username,
      provider.isBetweenSteps,
      undefined,
      undefined,
      customInstanceDetails
    );
    void this.refresh
      .startRefreshWorkflow(organizationId, integration.id, provider)
      .catch(() => undefined);

    if (!provider.isBetweenSteps) {
      return { integrationId: integration.id, selections: [] };
    }
    const rawSelections = provider.pages
      ? await provider.pages(auth.accessToken)
      : provider.companies
      ? await provider.companies(auth.accessToken, {}, internalId)
      : [];
    const selections = rawSelections
      .slice(0, 250)
      .map(selectionOption)
      .filter(
        (option): option is BizzbloxProviderSelectionOption => option !== null
      );
    if (selections.length === 0) {
      throw new Error('No selectable provider accounts were returned.');
    }
    return { integrationId: integration.id, selections };
  }
}
