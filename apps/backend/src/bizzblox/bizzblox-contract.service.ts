import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type {
  IntegrationSummary,
  JsonValue,
  PostizAgentClient,
  ProviderContract,
  ProviderTool,
} from '@bizzblox/postiz-agent-client';

import { bizzbloxDigest } from './bizzblox-canonical';
import {
  BIZZBLOX_POSTIZ_CLIENTS,
  type BizzbloxPostizClientFactory,
} from './bizzblox-publications.service';

export const BIZZBLOX_CHANNEL_DIRECTORY = Symbol('BIZZBLOX_CHANNEL_DIRECTORY');
export const BIZZBLOX_OPAQUE_REFS = Symbol('BIZZBLOX_OPAQUE_REFS');

export type BizzbloxManagedChannelStatus =
  | 'active'
  | 'inactive'
  | 'disconnected';

export type BizzbloxManagedChannelCandidate = Readonly<{
  channelHandle: string;
  connectorRevision: number;
  contractDigest: string;
  integrationId: string;
  status: BizzbloxManagedChannelStatus;
}>;

export type BizzbloxManagedChannelRecord = BizzbloxManagedChannelCandidate &
  Readonly<{
    organizationId: string;
  }>;

export interface BizzbloxChannelDirectory {
  synchronize(
    organizationId: string,
    connectorRevision: number,
    candidates: readonly BizzbloxManagedChannelCandidate[]
  ): Promise<readonly BizzbloxManagedChannelRecord[]>;
  read(
    organizationId: string,
    channelHandle: string
  ): Promise<BizzbloxManagedChannelRecord | null>;
  updateContract(
    input: Readonly<{
      organizationId: string;
      channelHandle: string;
      connectorRevision: number;
      contractDigest: string;
    }>
  ): Promise<BizzbloxManagedChannelRecord | null>;
  markDisconnected(
    input: Readonly<{
      organizationId: string;
      channelHandle: string;
      connectorRevision: number;
    }>
  ): Promise<BizzbloxManagedChannelRecord | null>;
}

export interface BizzbloxOpaqueRefs {
  channel(organizationId: string, integrationId: string): string;
  helper(
    organizationId: string,
    integrationId: string,
    contractDigest: string,
    methodName: string
  ): string;
}

export class BizzbloxHmacOpaqueRefs implements BizzbloxOpaqueRefs {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new Error('BizzBLOX opaque reference key must be 32 bytes.');
    }
  }

  private derive(prefix: string, values: readonly string[]): string {
    const hmac = createHmac('sha256', this.key);
    for (const value of values) {
      hmac.update(String(Buffer.byteLength(value, 'utf8')));
      hmac.update(':');
      hmac.update(value, 'utf8');
      hmac.update('\0');
    }
    return `${prefix}${hmac.digest('base64url')}`;
  }

  channel(organizationId: string, integrationId: string): string {
    return this.derive('bbx_ch_', [organizationId, integrationId]);
  }

  helper(
    organizationId: string,
    integrationId: string,
    contractDigest: string,
    methodName: string
  ): string {
    return this.derive('bbx_help_', [
      organizationId,
      integrationId,
      contractDigest,
      methodName,
    ]);
  }
}

export class BizzbloxContractInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BizzbloxContractInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SECRET_KEY_SUFFIXES = Object.freeze([
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'authtoken',
  'bearertoken',
  'apikey',
  'clientsecret',
  'privatekey',
  'password',
  'authorization',
  'cookie',
  'secret',
  'token',
  'jwt',
]);

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function boundedJson(value: JsonValue, depth = 0): JsonValue {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return Object.freeze(
      value.slice(0, 100).map((item) => boundedJson(item, depth + 1))
    );
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          key.slice(0, 200),
          isSecretKey(key) ? '[redacted]' : boundedJson(item, depth + 1),
        ])
    )
  );
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

function helperProjection(
  refs: BizzbloxOpaqueRefs,
  organizationId: string,
  integrationId: string,
  contractDigest: string,
  tool: ProviderTool
) {
  const label = boundedText(tool.label, 200);
  const description = boundedText(tool.description, 1_000);
  const dataSchema = tool.dataSchema;
  return Object.freeze({
    helperRef: refs.helper(
      organizationId,
      integrationId,
      contractDigest,
      tool.methodName
    ),
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(dataSchema !== undefined
      ? { dataSchema: boundedJson(dataSchema) }
      : {}),
  });
}

function contractProjection(
  refs: BizzbloxOpaqueRefs,
  organizationId: string,
  channel: BizzbloxManagedChannelRecord,
  contract: ProviderContract
) {
  const contractDigest = bizzbloxDigest(contract);
  return Object.freeze({
    channelHandle: channel.channelHandle,
    connectorRevision: channel.connectorRevision,
    contractDigest,
    rules: contract.rules.slice(0, 32_000),
    maxLength: Math.max(0, Math.min(contract.maxLength, 10_000_000)),
    settings: boundedJson(contract.settings),
    helpers: Object.freeze(
      contract.tools
        .slice(0, 100)
        .map((tool) =>
          helperProjection(
            refs,
            organizationId,
            channel.integrationId,
            contractDigest,
            tool
          )
        )
    ),
  });
}

function validToolData(
  value: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const entries = Object.entries(value);
  if (
    entries.length > 100 ||
    entries.some(
      ([key, item]) =>
        !key ||
        key.length > 200 ||
        typeof item !== 'string' ||
        item.length > 8_000
    )
  ) {
    throw new BizzbloxContractInputError('Invalid provider helper input.');
  }
  return Object.freeze(Object.fromEntries(entries));
}

type LoadedContract = Readonly<{
  channel: BizzbloxManagedChannelRecord;
  client: PostizAgentClient;
  contract: ProviderContract;
  projection: ReturnType<typeof contractProjection>;
}>;

@Injectable()
export class BizzbloxContractService {
  constructor(
    @Inject(BIZZBLOX_POSTIZ_CLIENTS)
    private readonly clients: BizzbloxPostizClientFactory,
    @Inject(BIZZBLOX_CHANNEL_DIRECTORY)
    private readonly channels: BizzbloxChannelDirectory,
    @Inject(BIZZBLOX_OPAQUE_REFS)
    private readonly refs: BizzbloxOpaqueRefs
  ) {}

  async listChannels(organizationId: string, connectorRevision: number) {
    const client = await this.clients.forOrganization(organizationId);
    const integrations = await client.listIntegrations();
    if (integrations.length > 100) {
      throw new BizzbloxContractInputError(
        'Managed social channel count exceeded the service bound.'
      );
    }
    const contracts = await Promise.all(
      integrations.map(async (integration) =>
        client.getIntegrationSettings(integration.id)
      )
    );
    const candidates = integrations.map((integration, index) =>
      Object.freeze({
        channelHandle: this.refs.channel(organizationId, integration.id),
        connectorRevision,
        contractDigest: bizzbloxDigest(contracts[index]),
        integrationId: integration.id,
        status: integration.disabled
          ? ('inactive' as const)
          : ('active' as const),
      })
    );
    const stored = await this.channels.synchronize(
      organizationId,
      connectorRevision,
      candidates
    );
    const byIntegration = new Map(
      stored.map((channel) => [channel.integrationId, channel])
    );
    return Object.freeze({
      channels: Object.freeze(
        integrations.map((integration) => {
          const channel = byIntegration.get(integration.id);
          if (!channel) {
            throw new Error('Managed social channel synchronization failed.');
          }
          return this.channelProjection(integration, channel);
        })
      ),
    });
  }

  private channelProjection(
    integration: IntegrationSummary,
    channel: BizzbloxManagedChannelRecord
  ) {
    return Object.freeze({
      channelHandle: channel.channelHandle,
      connectorRevision: channel.connectorRevision,
      contractDigest: channel.contractDigest,
      provider: integration.identifier.slice(0, 200),
      displayName: integration.name.slice(0, 500),
      picture: integration.picture?.slice(0, 2_000) ?? null,
      status: channel.status,
    });
  }

  private async loadContract(
    organizationId: string,
    connectorRevision: number,
    channelHandle: string
  ): Promise<LoadedContract> {
    const channel = await this.channels.read(organizationId, channelHandle);
    if (!channel || channel.organizationId !== organizationId) {
      throw new BizzbloxContractInputError('Social channel was not found.');
    }
    if (channel.connectorRevision !== connectorRevision) {
      throw new BizzbloxContractInputError('Social channel revision is stale.');
    }
    if (channel.status !== 'active') {
      throw new BizzbloxContractInputError('Social channel is inactive.');
    }
    const client = await this.clients.forOrganization(organizationId);
    const contract = await client.getIntegrationSettings(channel.integrationId);
    const projection = contractProjection(
      this.refs,
      organizationId,
      channel,
      contract
    );
    const updated = await this.channels.updateContract({
      organizationId,
      channelHandle,
      connectorRevision,
      contractDigest: projection.contractDigest,
    });
    if (!updated) {
      throw new BizzbloxContractInputError('Social channel changed.');
    }
    return Object.freeze({ channel: updated, client, contract, projection });
  }

  async readContract(
    organizationId: string,
    connectorRevision: number,
    channelHandle: string
  ) {
    return (
      await this.loadContract(organizationId, connectorRevision, channelHandle)
    ).projection;
  }

  async executeHelper(
    organizationId: string,
    connectorRevision: number,
    channelHandle: string,
    helperRef: string,
    data: Readonly<Record<string, string>>
  ) {
    const loaded = await this.loadContract(
      organizationId,
      connectorRevision,
      channelHandle
    );
    const tool = loaded.contract.tools.find(
      (candidate) =>
        this.refs.helper(
          organizationId,
          loaded.channel.integrationId,
          loaded.projection.contractDigest,
          candidate.methodName
        ) === helperRef
    );
    if (!tool) {
      throw new BizzbloxContractInputError(
        'Provider helper reference is stale or invalid.'
      );
    }
    const output = await loaded.client.triggerIntegrationTool({
      integrationId: loaded.channel.integrationId,
      methodName: tool.methodName,
      data: validToolData(data),
    });
    return Object.freeze({ output: boundedJson(output) });
  }
}
