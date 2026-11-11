import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Integration, Prisma } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';
import {
  PROVIDER_TOKEN_CODEC,
  type ProviderTokenCodec,
} from '@gitroom/nestjs-libraries/bizzblox/token-envelope';

@Injectable()
export class IntegrationRepository {
  private storage = UploadFactory.createStorage();
  constructor(
    private _integration: PrismaRepository<'integration'>,
    private _posts: PrismaRepository<'post'>,
    private _plugs: PrismaRepository<'plugs'>,
    private _exisingPlugData: PrismaRepository<'exisingPlugData'>,
    private _customers: PrismaRepository<'customer'>,
    private _mentions: PrismaRepository<'mentions'>,
    @Inject(PROVIDER_TOKEN_CODEC)
    private _providerTokens: ProviderTokenCodec,
    private _transaction: PrismaTransaction
  ) {}

  /** Reserve before any identity or token write. Failed connects never release ownership. */
  async reserveProviderAccount(
    org: string,
    provider: string,
    externalAccountId: string
  ) {
    if (!org || !provider || !externalAccountId) {
      throw new Error('Social account ownership identity is incomplete.');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this._transaction.model.$transaction(
          async (transaction) => {
            const owner =
              await transaction.bizzbloxSocialAccountOwnership.upsert({
                where: {
                  providerIdentifier_externalAccountId: {
                    providerIdentifier: provider,
                    externalAccountId,
                  },
                },
                create: {
                  providerIdentifier: provider,
                  externalAccountId,
                  organizationId: org,
                },
                update: {},
              });
            const foreign = await transaction.integration.findFirst({
              where: {
                providerIdentifier: provider,
                internalId: externalAccountId,
                organizationId: { not: org },
                deletedAt: null,
                inBetweenSteps: false,
              },
              select: { id: true },
            });
            if (owner.organizationId !== org || foreign) {
              throw new Error(
                'This social account already belongs to another workspace or environment.'
              );
            }
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        return;
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034')
        )
          continue;
        throw error;
      }
    }
  }

  private async sealProviderToken(
    organizationId: string,
    integrationId: string,
    purpose: 'access' | 'refresh',
    value: string
  ): Promise<string> {
    return this._providerTokens.seal(
      { integrationId, organizationId, purpose },
      value
    );
  }

  async openForProviderExecution<T extends Integration>(
    integration: T
  ): Promise<T> {
    const current = await this.getIntegrationById(
      integration.organizationId,
      integration.id
    );
    if (
      !current ||
      current.disabled ||
      current.deletedAt ||
      this.health(current).state !== 'ready' ||
      current.credentialGeneration !== integration.credentialGeneration
    ) {
      throw new Error('Social channel credentials are unavailable.');
    }
    const opened = await this.openForRefresh({ ...integration, ...current });
    const latest = await this.getIntegrationById(
      current.organizationId,
      current.id
    );
    if (
      !latest ||
      latest.disabled ||
      latest.deletedAt ||
      this.health(latest).state !== 'ready' ||
      latest.credentialGeneration !== current.credentialGeneration ||
      latest.healthRevision !== current.healthRevision
    ) {
      throw new Error('Social channel credentials are unavailable.');
    }
    return opened;
  }

  async openForRefresh<T extends Integration>(integration: T): Promise<T> {
    if (integration.type === 'social' && !integration.inBetweenSteps) {
      await this.reserveProviderAccount(
        integration.organizationId,
        integration.providerIdentifier,
        integration.internalId
      );
    }
    const token = await this._providerTokens.open(
      {
        integrationId: integration.id,
        organizationId: integration.organizationId,
        purpose: 'access',
      },
      integration.token
    );
    const refreshToken = integration.refreshToken
      ? await this._providerTokens.open(
          {
            integrationId: integration.id,
            organizationId: integration.organizationId,
            purpose: 'refresh',
          },
          integration.refreshToken
        )
      : integration.refreshToken;
    return { ...integration, refreshToken, token };
  }

  private async credentialTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._transaction.model.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 30_000,
        });
      } catch (error) {
        if (
          attempt < 4 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034'
        )
          continue;
        throw error;
      }
    }
  }

  /** Credentials and recovery metadata have one writer; callers never persist raw failures. */
  private freshCredentials(credentialScope: string | null = null) {
    return {
      credentialGeneration: { increment: 1 },
      healthRevision: { increment: 1 },
      credentialScope,
      healthState: 'ready',
      refreshReason: null,
      refreshNeeded: false,
      refreshClaim: null,
      refreshLeaseUntil: null,
      refreshPhase: null,
      refreshReplaySafe: false,
      refreshNextAt: null,
      refreshAttempts: 0,
      refreshPendingAccess: null,
      refreshPendingToken: null,
      refreshPendingExpiry: null,
    };
  }

  health(integration: Integration) {
    const state =
      integration.refreshNeeded && integration.healthState === 'ready'
        ? 'operator_required'
        : integration.healthState;
    return {
      version: 1 as const,
      credentialGeneration: integration.credentialGeneration,
      revision: integration.healthRevision,
      state: ([
        'ready',
        'recovering',
        'operator_required',
        'consent_required',
      ].includes(state)
        ? state
        : 'operator_required') as
        | 'ready'
        | 'recovering'
        | 'operator_required'
        | 'consent_required',
    };
  }

  private refreshFence(row: Integration) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      providerIdentifier: row.providerIdentifier,
      internalId: row.internalId,
      rootInternalId: row.rootInternalId,
      credentialGeneration: row.credentialGeneration,
      healthRevision: row.healthRevision,
      refreshClaim: row.refreshClaim,
      disabled: row.disabled,
      deletedAt: row.deletedAt,
      inBetweenSteps: row.inBetweenSteps,
    };
  }

  async claimRefresh(
    org: string,
    id: string,
    oneTimeToken: boolean,
    force: boolean
  ) {
    const now = new Date();
    return this._transaction.model.$transaction(
      async (tx) => {
        const current = await tx.integration.findFirst({
          where: { id, organizationId: org },
        });
        if (
          !current ||
          current.disabled ||
          current.deletedAt ||
          current.inBetweenSteps
        )
          return null;
        if (
          this.health(current).state === 'operator_required' ||
          this.health(current).state === 'consent_required'
        )
          return null;
        if (current.refreshLeaseUntil && current.refreshLeaseUntil > now)
          return null;
        if (current.refreshClaim) {
          // A lost exchange has unknown consumption. Only the persisted provider replay proof allows retry.
          const safe =
            current.refreshPhase !== 'exchanging' || current.refreshReplaySafe;
          await tx.integration.updateMany({
            where: { organizationId: org, refreshClaim: current.refreshClaim },
            data: {
              healthState: safe ? 'recovering' : 'operator_required',
              refreshReason: safe ? 'lease_expired' : 'exchange_uncertain',
              refreshClaim: null,
              refreshLeaseUntil: null,
              refreshNextAt: safe ? new Date(now.getTime() + 60_000) : null,
              healthRevision: { increment: 1 },
            },
          });
          return null;
        }
        if (current.refreshNextAt && current.refreshNextAt > now) return null;
        if (
          !force &&
          !current.refreshPendingAccess &&
          current.healthState === 'ready' &&
          (!current.tokenExpiration ||
            current.tokenExpiration.getTime() > now.getTime() + 300_000)
        )
          return null;
        const rows =
          oneTimeToken && !current.refreshPendingAccess
            ? await tx.integration.findMany({
                where: {
                  organizationId: org,
                  providerIdentifier: current.providerIdentifier,
                  rootInternalId: current.rootInternalId ?? current.internalId,
                  deletedAt: null,
                  inBetweenSteps: false,
                },
                orderBy: { id: 'asc' },
              })
            : [current];
        if (!rows.some((row) => row.id === current.id)) rows.push(current);
        if (
          rows.some(
            (row) =>
              row.refreshClaim ||
              (row.refreshPendingAccess &&
                row.id !== current.id &&
                !row.disabled) ||
              ['operator_required', 'consent_required'].includes(
                this.health(row).state
              )
          )
        )
          return null;
        const claim = randomUUID();
        const claimed: Integration[] = [];
        for (const row of rows) {
          const result = await tx.integration.updateMany({
            where: this.refreshFence(row),
            data: {
              refreshClaim: claim,
              refreshLeaseUntil: new Date(now.getTime() + 600_000),
              refreshPhase: row.refreshPendingAccess ? 'resolving' : 'prepared',
              healthState: 'recovering',
              healthRevision: { increment: 1 },
              refreshAttempts: Math.min(row.refreshAttempts + 1, 16),
            },
          });
          if (result.count !== 1)
            throw new Error('Credential refresh claim changed.');
          claimed.push({
            ...row,
            refreshClaim: claim,
            healthRevision: row.healthRevision + 1,
          });
        }
        return {
          current: claimed.find((row) => row.id === id)!,
          rows: claimed,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async beginRefreshExchange(
    claim: { rows: Integration[] },
    replaySafe: boolean
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      for (const row of claim.rows) {
        const result = await tx.integration.updateMany({
          where: {
            ...this.refreshFence(row),
            refreshLeaseUntil: { gt: new Date() },
          },
          data: { refreshPhase: 'exchanging', refreshReplaySafe: replaySafe },
        });
        if (result.count !== 1)
          throw new Error('Credential refresh claim changed.');
      }
    });
  }

  async stageRefreshCredentials(
    claim: { rows: Integration[] },
    credentials: {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }
  ) {
    const pending = await Promise.all(
      claim.rows.map(async (row) => ({
        row,
        access: await this.sealProviderToken(
          row.organizationId,
          row.id,
          'access',
          credentials.accessToken
        ),
        refresh: await this.sealProviderToken(
          row.organizationId,
          row.id,
          'refresh',
          credentials.refreshToken
        ),
      }))
    );
    return this._transaction.model.$transaction(async (tx) => {
      for (const { row, access, refresh } of pending) {
        const result = await tx.integration.updateMany({
          where: {
            ...this.refreshFence(row),
            refreshLeaseUntil: { gt: new Date() },
            refreshPhase: 'exchanging',
          },
          data: {
            refreshPendingAccess: access,
            refreshPendingToken: refresh,
            refreshPendingExpiry: new Date(
              Date.now() + credentials.expiresIn * 1000
            ),
            refreshPhase: 'resolving',
            refreshClaim: null,
            refreshLeaseUntil: null,
            refreshNextAt: new Date(),
            refreshReason: null,
            healthRevision: { increment: 1 },
          },
        });
        if (result.count !== 1)
          throw new Error('Credential refresh result is stale.');
      }
    });
  }

  async openPendingRefresh(row: Integration) {
    return this._providerTokens.open(
      {
        integrationId: row.id,
        organizationId: row.organizationId,
        purpose: 'access',
      },
      row.refreshPendingAccess!
    );
  }

  async renewExpiredPendingRefresh(row: Integration) {
    return this._integration.model.integration.updateMany({
      where: {
        ...this.refreshFence(row),
        refreshLeaseUntil: { gt: new Date() },
        refreshPhase: 'resolving',
      },
      data: {
        ...this.freshCredentials(row.credentialScope),
        refreshToken: row.refreshPendingToken,
        healthState: 'recovering',
        refreshNextAt: new Date(Date.now() + 60_000),
      },
    });
  }

  async finishRefresh(row: Integration, accessToken: string) {
    const token = await this.sealProviderToken(
      row.organizationId,
      row.id,
      'access',
      accessToken
    );
    const updated = await this._integration.model.integration.updateMany({
      where: {
        ...this.refreshFence(row),
        disabled: false,
        deletedAt: null,
        inBetweenSteps: false,
        refreshLeaseUntil: { gt: new Date() },
        refreshPhase: 'resolving',
      },
      data: {
        ...this.freshCredentials(row.credentialScope),
        token,
        refreshToken: row.refreshPendingToken,
        tokenExpiration: row.refreshPendingExpiry,
      },
    });
    return updated.count === 1;
  }

  async failRefresh(
    claim: { rows: Integration[] },
    state: 'recovering' | 'operator_required' | 'consent_required',
    reason: string
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      for (const row of claim.rows) {
        await tx.integration.updateMany({
          where: {
            ...this.refreshFence(row),
            refreshLeaseUntil: { gt: new Date() },
          },
          data: {
            healthState: state,
            refreshReason: reason,
            refreshClaim: null,
            refreshLeaseUntil: null,
            refreshNextAt:
              state === 'recovering'
                ? new Date(
                    Date.now() +
                      Math.min(
                        21_600_000,
                        60_000 * 2 ** Math.min(row.refreshAttempts, 9)
                      )
                  )
                : null,
            healthRevision: { increment: 1 },
          },
        });
      }
    });
  }

  async retryRefreshConfiguration(row: Integration) {
    const updated = await this._integration.model.integration.updateMany({
      where: {
        ...this.refreshFence(row),
        healthState: 'operator_required',
        refreshReason: 'configuration',
        disabled: false,
        deletedAt: null,
      },
      data: {
        healthState: 'recovering',
        refreshReason: null,
        refreshNextAt: new Date(),
        healthRevision: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  /** Bounded cursor scan: a held/failed row can never starve later integrations. */
  refreshCandidates(after?: string, held = false) {
    return this._integration.model.integration.findMany({
      where: {
        type: 'social',
        deletedAt: null,
        ...(after ? { id: { gt: after } } : {}),
        ...(held
          ? {
              OR: [
                { healthState: 'operator_required' },
                { healthState: 'consent_required' },
                { refreshNeeded: true },
              ],
            }
          : { disabled: false, inBetweenSteps: false }),
      },
      orderBy: { id: 'asc' },
      take: 100,
      select: {
        id: true,
        organizationId: true,
        credentialGeneration: true,
        healthRevision: true,
        healthState: true,
        refreshReason: true,
        refreshNeeded: true,
      },
    });
  }

  private async changeLifecycle(
    org: string,
    id: string,
    data: Prisma.IntegrationUpdateManyMutationInput
  ) {
    return this.credentialTransaction(async (tx) => {
      const row = await tx.integration.findFirst({
        where: { id, organizationId: org },
      });
      if (!row) return;
      const changed = await tx.integration.updateMany({
        where: this.refreshFence(row),
        data: {
          ...data,
          credentialGeneration: { increment: 1 },
          healthRevision: { increment: 1 },
          refreshClaim: null,
          refreshLeaseUntil: null,
          ...(row.refreshPhase === 'exchanging'
            ? {
                healthState: 'operator_required',
                refreshReason: 'exchange_uncertain',
              }
            : {}),
        },
      });
      if (changed.count !== 1) throw new Error('Channel lifecycle changed.');
    });
  }

  getMentions(platform: string, q: string) {
    return this._mentions.model.mentions.findMany({
      where: {
        platform,
        OR: [
          {
            name: {
              contains: q,
              mode: 'insensitive',
            },
          },
          {
            username: {
              contains: q,
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: {
        name: 'asc',
      },
      take: 100,
      select: {
        name: true,
        username: true,
        image: true,
      },
    });
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    if (mentions.length === 0) {
      return [] as any[];
    }
    return this._mentions.model.mentions.createMany({
      data: mentions.map((mention) => ({
        platform,
        name: mention.name,
        username: mention.username,
        image: mention.image,
      })),
      skipDuplicates: true,
    });
  }

  async checkPreviousConnections(org: string, id: string) {
    // Deleted accounts keep their integrations with an md5 hashed
    // rootInternalId, so match both the raw id and its hash to still catch
    // channels that were connected by a deleted account.
    const findIt = await this._integration.model.integration.findMany({
      where: {
        rootInternalId: {
          in: [id, createHash('md5').update(id).digest('hex')],
        },
      },
      select: {
        organizationId: true,
        id: true,
      },
    });

    if (findIt.some((f) => f.organizationId === org)) {
      return false;
    }

    return findIt.length > 0;
  }

  updateProviderSettings(org: string, id: string, settings: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        additionalSettings: settings,
      },
    });
  }

  async setTimes(org: string, id: string, times: IntegrationTimeDto) {
    return this._integration.model.integration.update({
      select: {
        id: true,
      },
      where: {
        id,
        organizationId: org,
      },
      data: {
        postingTimes: JSON.stringify(times.time),
      },
    });
  }

  getPlug(plugId: string) {
    return this._plugs.model.plugs.findFirst({
      where: {
        id: plugId,
      },
      include: {
        integration: true,
      },
    });
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        integrationId,
        organizationId: orgId,
        activated: true,
      },
      include: {
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
          },
        },
      },
    });
  }

  async updateIntegration(id: string, params: Partial<Integration>) {
    const current = await this._integration.model.integration.findFirst({
      where: { id, organizationId: params.organizationId },
    });
    if (!current || !params.organizationId || !params.internalId) {
      throw new Error('Social account ownership identity is incomplete.');
    }
    if (
      params.credentialGeneration !== undefined &&
      params.credentialGeneration !== current.credentialGeneration
    ) {
      throw new Error('Channel credentials changed during account selection.');
    }
    const providerIdentifier =
      params.providerIdentifier ?? current.providerIdentifier;
    if (current.type === 'social' && !current.inBetweenSteps) {
      await this.reserveProviderAccount(
        current.organizationId,
        current.providerIdentifier,
        current.internalId
      );
    }
    if (current.type === 'social' && params.inBetweenSteps !== true) {
      await this.reserveProviderAccount(
        params.organizationId,
        providerIdentifier,
        params.internalId
      );
    }
    await this.checkForDeletedOnceAndUpdate(
      params.organizationId,
      params.internalId,
      providerIdentifier
    );
    if (
      params.picture &&
      (params.picture.indexOf(process.env.CLOUDFLARE_BUCKET_URL!) === -1 ||
        params.picture.indexOf(process.env.FRONTEND_URL!) === -1)
    ) {
      params.picture = await this.storage.uploadSimple(params.picture);
    }

    const existing = await this._integration.model.integration.findUnique({
      where: {
        organizationId_providerIdentifier_internalId: {
          organizationId: params.organizationId!,
          providerIdentifier,
          internalId: params.internalId,
        },
      },
    });

    const targetId = existing?.id ?? id;
    const securedParams = { ...params };
    if (params.refreshToken === undefined && current.refreshToken) {
      const plaintext = await this._providerTokens.open(
        {
          integrationId: current.id,
          organizationId: current.organizationId,
          purpose: 'refresh',
        },
        current.refreshToken
      );
      securedParams.refreshToken = await this.sealProviderToken(
        current.organizationId,
        targetId,
        'refresh',
        plaintext
      );
    }
    if (typeof params.token === 'string') {
      if (!params.organizationId) {
        throw new Error('Managed provider token context is incomplete.');
      }
      securedParams.token = await this.sealProviderToken(
        params.organizationId,
        targetId,
        'access',
        params.token
      );
    }
    if (typeof params.refreshToken === 'string' && params.refreshToken) {
      if (!params.organizationId) {
        throw new Error('Managed provider token context is incomplete.');
      }
      securedParams.refreshToken = await this.sealProviderToken(
        params.organizationId,
        targetId,
        'refresh',
        params.refreshToken
      );
    }

    if (existing && existing.id !== id) {
      await this._posts.model.post.updateMany({
        where: {
          integrationId: id,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      await this._integration.model.integration.update({
        where: {
          id,
        },
        data: {
          ...this.freshCredentials(),
          internalId: `deleted_${params.internalId}_${makeId(10)}`,
          deletedAt: new Date(),
        },
      });
    }

    return this._integration.model.integration.update({
      where: {
        id: targetId,
        credentialGeneration:
          existing?.credentialGeneration ?? current.credentialGeneration,
      },
      data: {
        ...securedParams,
        ...this.freshCredentials(params.credentialScope ?? null),
        disabled: false,
        deletedAt: null,
      },
    });
  }

  disconnectChannel(org: string, id: string, credentialGeneration: number) {
    if (!Number.isSafeInteger(credentialGeneration)) return;
    return this._integration.model.integration.updateMany({
      where: {
        id,
        organizationId: org,
        credentialGeneration,
        healthState: 'ready',
        refreshClaim: null,
        deletedAt: null,
      },
      data: {
        healthState: 'operator_required',
        refreshReason: 'execution_rejected',
        healthRevision: { increment: 1 },
      },
    });
  }

  async getIntegrationByInternalId(
    org: string,
    internalId: string,
    providerIdentifier?: string
  ) {
    const rows = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        internalId,
        ...(providerIdentifier ? { providerIdentifier } : {}),
        deletedAt: null,
      },
      take: 2,
    });
    if (rows.length > 1)
      throw new Error('Social account provider identity is ambiguous.');
    return rows[0] ?? null;
  }

  // Moves a channel to another provider in place (MIGRATE_PROVIDERS): only the
  // provider and the app-scoped ids change, so the integration id - and with it
  // scheduled posts, settings and customers - survives the migration. The
  // follow-up createOrUpdateIntegration upsert matches the new internalId and
  // stores the fresh tokens.
  async migrateIntegration(
    org: string,
    id: string,
    internalId: string,
    providerIdentifier: string,
    rootInternalId: string
  ) {
    const current = await this._integration.model.integration.findFirst({
      where: { id, organizationId: org },
    });
    if (!current)
      throw new Error('Social account ownership identity is incomplete.');
    if (current.type === 'social' && !current.inBetweenSteps) {
      await this.reserveProviderAccount(
        org,
        current.providerIdentifier,
        current.internalId
      );
    }
    await this.reserveProviderAccount(org, providerIdentifier, internalId);
    // A soft-deleted channel can still hold the target internalId
    // (deleteChannel keeps it): rename it out of the way like updateIntegration
    // does, otherwise the organizationId_providerIdentifier_internalId unique constraint rejects
    // the migration. Live channels are rejected by the service before this.
    const existing = await this._integration.model.integration.findUnique({
      where: {
        organizationId_providerIdentifier_internalId: {
          organizationId: org,
          providerIdentifier,
          internalId,
        },
      },
    });

    if (existing && existing.deletedAt) {
      await this._integration.model.integration.update({
        where: {
          id: existing.id,
        },
        data: {
          internalId: `deleted_${internalId}_${makeId(10)}`,
        },
      });
    }

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        ...this.freshCredentials(),
        healthState: 'operator_required',
        refreshReason: 'identity_changed',
        internalId,
        providerIdentifier,
        rootInternalId,
      },
    });
  }

  async createOrUpdateIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn = 999999999,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string,
    credentialScope: string | null = null
  ) {
    if (type === 'social' && !isBetweenSteps)
      await this.reserveProviderAccount(org, provider, internalId);
    return this.credentialTransaction(async (tx) => {
      const existingIntegration = await tx.integration.findUnique({
        where: {
          organizationId_providerIdentifier_internalId: {
            internalId,
            providerIdentifier: provider,
            organizationId: org,
          },
        },
        select: { id: true },
      });
      const integrationId = existingIntegration?.id ?? randomUUID();
      const sealedToken = await this.sealProviderToken(
        org,
        integrationId,
        'access',
        token
      );
      const sealedRefreshToken = refreshToken
        ? await this.sealProviderToken(
            org,
            integrationId,
            'refresh',
            refreshToken
          )
        : '';
      const postTimes = timezone
        ? {
            postingTimes: JSON.stringify([
              { time: 560 - timezone },
              { time: 850 - timezone },
              { time: 1140 - timezone },
            ]),
          }
        : {};
      let upsert = await tx.integration.upsert({
        where: {
          organizationId_providerIdentifier_internalId: {
            internalId,
            providerIdentifier: provider,
            organizationId: org,
          },
        },
        create: {
          id: integrationId,
          credentialScope,
          type: type as any,
          name,
          providerIdentifier: provider,
          token: sealedToken,
          profile: username,
          ...(picture ? { picture } : {}),
          inBetweenSteps: isBetweenSteps,
          refreshToken: sealedRefreshToken,
          ...(expiresIn
            ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
            : {}),
          internalId,
          ...postTimes,
          organizationId: org,
          refreshNeeded: false,
          rootInternalId: internalId,
          ...(customInstanceDetails ? { customInstanceDetails } : {}),
          additionalSettings: additionalSettings
            ? JSON.stringify(additionalSettings)
            : '[]',
        },
        update: {
          ...this.freshCredentials(credentialScope),
          ...(additionalSettings
            ? { additionalSettings: JSON.stringify(additionalSettings) }
            : {}),
          ...(customInstanceDetails ? { customInstanceDetails } : {}),
          type: type as any,
          ...(!refresh
            ? {
                inBetweenSteps: isBetweenSteps,
              }
            : {}),
          ...(picture ? { picture } : {}),
          profile: username,
          providerIdentifier: provider,
          token: sealedToken,
          refreshToken: sealedRefreshToken,
          ...(expiresIn
            ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
            : {}),
          internalId,
          organizationId: org,
          deletedAt: null,
          refreshNeeded: false,
        },
      });

      // A competing first connection may win the unique organization/account
      // row after our initial lookup. Rebind the envelopes to the row Prisma
      // actually returned before any caller can use them.
      if (upsert.id !== integrationId) {
        const reboundToken = await this.sealProviderToken(
          org,
          upsert.id,
          'access',
          token
        );
        const reboundRefreshToken = refreshToken
          ? await this.sealProviderToken(
              org,
              upsert.id,
              'refresh',
              refreshToken
            )
          : '';
        upsert = await tx.integration.update({
          where: { id: upsert.id },
          data: {
            ...this.freshCredentials(credentialScope),
            token: reboundToken,
            refreshToken: reboundRefreshToken,
          },
        });
      }

      if (oneTimeToken) {
        const rootId =
          (
            await tx.integration.findFirst({
              where: {
                organizationId: org,
                internalId: internalId,
                providerIdentifier: provider,
              },
            })
          )?.rootInternalId || internalId;

        const siblings = await tx.integration.findMany({
          where: {
            id: { not: upsert.id },
            organizationId: org,
            rootInternalId: rootId,
            deletedAt: null,
            providerIdentifier: provider,
          },
          select: { id: true, organizationId: true },
        });
        const siblingTokens = await Promise.all(
          siblings.map(async (sibling) => ({
            id: sibling.id,
            token: await this.sealProviderToken(
              sibling.organizationId,
              sibling.id,
              'access',
              token
            ),
            refreshToken: refreshToken
              ? await this.sealProviderToken(
                  sibling.organizationId,
                  sibling.id,
                  'refresh',
                  refreshToken
                )
              : '',
          }))
        );
        await Promise.all(
          siblingTokens.map((sibling) =>
            tx.integration.update({
              where: { id: sibling.id },
              data: {
                ...this.freshCredentials(credentialScope),
                token: sibling.token,
                refreshToken: sibling.refreshToken,
                refreshNeeded: false,
                ...(expiresIn
                  ? {
                      tokenExpiration: new Date(Date.now() + expiresIn * 1000),
                    }
                  : {}),
              },
            })
          )
        );
      }

      return upsert;
    });
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integration.model.integration.update({
      where: {
        id,
      },
      data: {
        ...(name ? { name } : {}),
        ...(url ? { picture: url } : {}),
      },
    });
  }

  getIntegrationById(org: string, id: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        id,
      },
    });
  }

  async getIntegrationForOrder(
    id: string,
    order: string,
    user: string,
    org: string
  ) {
    const integration = await this._posts.model.post.findFirst({
      where: {
        integrationId: id,
        submittedForOrder: {
          id: order,
          messageGroup: {
            OR: [
              { sellerId: user },
              { buyerId: user },
              { buyerOrganizationId: org },
            ],
          },
        },
      },
      select: {
        integration: {
          select: {
            id: true,
            name: true,
            picture: true,
            inBetweenSteps: true,
            providerIdentifier: true,
          },
        },
      },
    });

    return integration?.integration;
  }

  async updateOnCustomerName(org: string, id: string, name: string) {
    const customer = !name
      ? undefined
      : (await this._customers.model.customer.findFirst({
          where: {
            orgId: org,
            name,
          },
        })) ||
        (await this._customers.model.customer.create({
          data: {
            name,
            orgId: org,
          },
        }));

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        customer: !customer
          ? { disconnect: true }
          : {
              connect: {
                id: customer.id,
              },
            },
      },
    });
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: !group
        ? {
            customer: {
              disconnect: true,
            },
          }
        : {
            customer: {
              connect: {
                id: group,
              },
            },
          },
    });
  }

  customers(orgId: string) {
    return this._customers.model.customer.findMany({
      where: {
        orgId,
        deletedAt: null,
      },
    });
  }

  getIntegrationsList(org: string) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        deletedAt: null,
      },
      include: {
        customer: true,
      },
    });
  }

  async disableChannel(org: string, id: string) {
    return this.changeLifecycle(org, id, { disabled: true });
  }

  async enableChannel(org: string, id: string) {
    return this.changeLifecycle(org, id, { disabled: false });
  }

  getPostsForChannel(org: string, id: string) {
    return this._posts.model.post.groupBy({
      by: ['group'],
      where: {
        organizationId: org,
        integrationId: id,
        deletedAt: null,
      },
    });
  }

  deleteChannel(org: string, id: string) {
    return this.changeLifecycle(org, id, { deletedAt: new Date() });
  }

  async deleteIntegrationsForAccount(org: string) {
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');

    await this._posts.model.post.updateMany({
      where: {
        organizationId: org,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    const integrations = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
      },
    });

    // md5 is deterministic, so a hashed rootInternalId can still be matched
    // by checkPreviousConnections when the same channel is connected again
    // from a new account.
    for (const integration of integrations) {
      await this._integration.model.integration.update({
        where: {
          id: integration.id,
        },
        data: {
          ...this.freshCredentials(),
          name: hash(integration.name),
          internalId: hash(integration.internalId),
          rootInternalId: integration.rootInternalId
            ? hash(integration.rootInternalId)
            : null,
          token: hash(integration.token),
          refreshToken: integration.refreshToken
            ? hash(integration.refreshToken)
            : null,
          profile: integration.profile ? hash(integration.profile) : null,
          customInstanceDetails: integration.customInstanceDetails
            ? hash(integration.customInstanceDetails)
            : null,
          picture: null,
          deletedAt: integration.deletedAt || new Date(),
        },
      });
    }
  }

  async checkForDeletedOnceAndUpdate(
    org: string,
    page: string,
    providerIdentifier: string
  ) {
    return this._integration.model.integration.updateMany({
      where: {
        organizationId: org,
        internalId: page,
        providerIdentifier,
        deletedAt: {
          not: null,
        },
      },
      data: {
        ...this.freshCredentials(),
        internalId: makeId(10),
      },
    });
  }

  async disableIntegrations(org: string, totalChannels: number) {
    const getChannels = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        disabled: false,
        deletedAt: null,
      },
      take: totalChannels,
      select: {
        id: true,
      },
    });

    for (const channel of getChannels) {
      await this.changeLifecycle(org, channel.id, { disabled: true });
    }
  }

  getPlugsByIntegrationId(org: string, id: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        organizationId: org,
        integrationId: id,
      },
    });
  }

  createOrUpdatePlug(org: string, integrationId: string, body: PlugDto) {
    return this._plugs.model.plugs.upsert({
      where: {
        organizationId: org,
        plugFunction_integrationId: {
          integrationId,
          plugFunction: body.func,
        },
      },
      create: {
        integrationId,
        organizationId: org,
        plugFunction: body.func,
        data: JSON.stringify(body.fields),
        activated: true,
      },
      update: {
        data: JSON.stringify(body.fields),
      },
      select: {
        activated: true,
      },
    });
  }

  changePlugActivation(orgId: string, plugId: string, status: boolean) {
    return this._plugs.model.plugs.update({
      where: {
        organizationId: orgId,
        id: plugId,
      },
      data: {
        activated: !!status,
      },
    });
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    return this._exisingPlugData.model.exisingPlugData.findMany({
      where: {
        integrationId,
        methodName,
        value: {
          in: id,
        },
      },
    });
  }

  async saveExisingData(
    methodName: string,
    integrationId: string,
    value: string[]
  ) {
    return this._exisingPlugData.model.exisingPlugData.createMany({
      data: value.map((p) => ({
        integrationId,
        methodName,
        value: p,
      })),
    });
  }

  async getPostingTimes(orgId: string, integrationsId?: string) {
    return this._integration.model.integration.findMany({
      where: {
        ...(integrationsId ? { id: integrationsId } : {}),
        organizationId: orgId,
        disabled: false,
        deletedAt: null,
      },
      select: {
        postingTimes: true,
      },
    });
  }
}
