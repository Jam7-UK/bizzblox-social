import { Injectable } from '@nestjs/common';
import { Integration } from '@prisma/client';
import { IntegrationManager } from './integration.manager';
import { IntegrationRepository } from '../database/prisma/integrations/integration.repository';
import {
  AuthTokenDetails,
  ProviderRefreshFailure,
  SocialProvider,
} from './social/social.integrations.interface';
import { TemporalService } from 'nestjs-temporal-core';

@Injectable()
export class RefreshIntegrationService {
  constructor(
    private _integrationManager: IntegrationManager,
    private repository: IntegrationRepository,
    private _temporalService: TemporalService
  ) {}

  /** Legacy activities retain their signature; all credential work remains inside the activity. */
  async refresh(
    integration: Integration,
    _cause = ''
  ): Promise<false | AuthTokenDetails> {
    try {
      const current = await this.repository.getIntegrationById(
        integration.organizationId,
        integration.id
      );
      if (!current) return false;
      if (current.credentialGeneration === integration.credentialGeneration) {
        await this.run(current.organizationId, current.id, true);
      } else if (integration.credentialGeneration === undefined) {
        await this.run(current.organizationId, current.id);
      }
      const stored = await this.repository.getIntegrationById(
        current.organizationId,
        current.id
      );
      if (!stored || this.repository.health(stored).state !== 'ready')
        return false;
      const opened = await this.repository.openForProviderExecution(stored);
      return {
        id: opened.internalId,
        name: opened.name,
        username: opened.profile ?? '',
        accessToken: opened.token,
        refreshToken: opened.refreshToken ?? undefined,
        expiresIn: opened.tokenExpiration
          ? Math.max(0, (opened.tokenExpiration.getTime() - Date.now()) / 1000)
          : undefined,
      };
    } catch {
      return false;
    }
  }

  /** An old posting activity's catch must not turn a durable claim into a reconnect request. */
  async setBetweenSteps(_integration: Integration, _cause = '') {}

  async run(
    organizationId: string,
    integrationId: string,
    force = false
  ): Promise<void> {
    const current = await this.repository.getIntegrationById(
      organizationId,
      integrationId
    );
    if (!current) return;
    const provider = this._integrationManager.getSocialIntegration(
      current.providerIdentifier
    );
    let claim = await this.repository.claimRefresh(
      organizationId,
      integrationId,
      !!provider.oneTimeToken,
      force
    );
    if (!claim) return;
    let phase: 'prepared' | 'exchanging' | 'resolving' = claim.current
      .refreshPendingAccess
      ? 'resolving'
      : 'prepared';
    try {
      if (claim.current.providerIdentifier !== current.providerIdentifier)
        throw new ProviderRefreshFailure('identity');
      if (phase === 'prepared') {
        const opened = await this.repository.openForRefresh(claim.current);
        if (!opened.refreshToken)
          throw new ProviderRefreshFailure('configuration');
        const fingerprint = provider.refreshConfigurationFingerprint?.();
        if (
          claim.current.credentialScope &&
          fingerprint !== claim.current.credentialScope
        ) {
          throw new ProviderRefreshFailure('configuration');
        }
        await this.repository.beginRefreshExchange(
          claim,
          provider.refreshReplaySafe === true
        );
        phase = 'exchanging';
        const tokens = await provider.refreshToken(opened.refreshToken!, {
          configurationVerified:
            !!fingerprint && fingerprint === claim.current.credentialScope,
        });
        if (
          !tokens.accessToken ||
          !tokens.refreshToken ||
          !Number.isFinite(tokens.expiresIn) ||
          tokens.expiresIn! <= 0
        ) {
          throw new ProviderRefreshFailure('unknown');
        }
        // A later profile read must never lose an already exchanged rotating credential.
        await this.repository.stageRefreshCredentials(claim, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresIn: tokens.expiresIn!,
        });
        claim = await this.repository.claimRefresh(
          organizationId,
          integrationId,
          false,
          false
        );
        if (!claim) return;
        phase = 'resolving';
      }
      if (
        claim.current.refreshPendingExpiry &&
        claim.current.refreshPendingExpiry.getTime() <= Date.now()
      ) {
        await this.repository.renewExpiredPendingRefresh(claim.current);
        return;
      }
      let access = await this.repository.openPendingRefresh(claim.current);
      if (
        provider.reConnect &&
        claim.current.rootInternalId &&
        claim.current.rootInternalId !== claim.current.internalId
      ) {
        const profile = await provider.reConnect(
          claim.current.rootInternalId,
          claim.current.internalId,
          access
        );
        if (
          String(profile.id) !== claim.current.internalId ||
          !profile.accessToken
        ) {
          throw new ProviderRefreshFailure('identity');
        }
        access = profile.accessToken;
      }
      await this.repository.finishRefresh(claim.current, access);
    } catch (error) {
      const kind =
        error instanceof ProviderRefreshFailure ? error.kind : 'unknown';
      const state =
        kind === 'identity'
          ? 'operator_required'
          : phase === 'resolving'
          ? 'recovering'
          : kind === 'consent' && phase === 'exchanging'
          ? 'consent_required'
          : kind === 'configuration'
          ? 'operator_required'
          : phase === 'prepared' ||
            ((kind === 'retry' || !(error instanceof ProviderRefreshFailure)) &&
              provider.refreshReplaySafe === true)
          ? 'recovering'
          : 'operator_required';
      await this.repository.failRefresh(
        claim,
        state,
        kind === 'identity'
          ? 'identity_mismatch'
          : phase === 'resolving'
          ? 'profile_read'
          : kind === 'configuration'
          ? 'configuration'
          : state === 'consent_required'
          ? 'refresh_invalid_grant'
          : phase === 'prepared'
          ? 'preparation'
          : 'exchange_uncertain'
      );
    }
  }

  async retryConfiguration(
    organizationId: string,
    integrationId: string,
    generation: number,
    revision: number
  ) {
    const row = await this.repository.getIntegrationById(
      organizationId,
      integrationId
    );
    if (
      !row ||
      row.credentialGeneration !== generation ||
      row.healthRevision !== revision ||
      row.refreshReason !== 'configuration'
    )
      return false;
    const provider = this._integrationManager.getSocialIntegration(
      row.providerIdentifier
    );
    if (
      row.refreshPhase !== 'prepared' &&
      !(row.refreshReplaySafe && provider.refreshReplaySafe)
    )
      return false;
    const fingerprint = provider.refreshConfigurationFingerprint?.();
    if (row.credentialScope && fingerprint !== row.credentialScope)
      return false;
    return this.repository.retryRefreshConfiguration(row);
  }

  async startRefreshWorkflow(
    orgId: string,
    id: string,
    _provider: SocialProvider
  ) {
    return this._temporalService.client
      .getRawClient()
      ?.workflow.start('refreshTokenWorkflowV2', {
        workflowId: `refresh_v2_${id}`,
        args: [{ integrationId: id, organizationId: orgId }],
        taskQueue: 'main',
        workflowIdConflictPolicy: 'USE_EXISTING',
      });
  }
}
