import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { Integration } from '@prisma/client';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import {
  integrationForTemporalHistory,
  refreshForTemporalHistory,
} from './temporal-provider-boundary';

@Injectable()
@Activity()
export class IntegrationsActivity {
  constructor(
    private _integrationService: IntegrationService,
    private _refreshIntegrationService: RefreshIntegrationService
  ) {}

  @ActivityMethod()
  async getIntegrationsById(id: string, orgId: string) {
    const integration = await this._integrationService.getIntegrationById(
      orgId,
      id
    );
    return integration ? integrationForTemporalHistory(integration) : null;
  }

  @ActivityMethod()
  async refreshToken(integration: Integration) {
    const refresh = await this._refreshIntegrationService.refresh(integration);
    return refresh ? refreshForTemporalHistory(refresh) : false;
  }
  @ActivityMethod()
  async recoverIntegrationV2(input: {
    organizationId: string;
    integrationId: string;
  }) {
    try {
      await this._refreshIntegrationService.run(
        input.organizationId,
        input.integrationId
      );
      const current = await this._integrationService.getIntegrationById(
        input.organizationId,
        input.integrationId
      );
      if (!current || current.deletedAt) return { stopped: true, delayMs: 0 };
      const next =
        current.refreshLeaseUntil ??
        current.refreshNextAt ??
        current.tokenExpiration;
      return {
        stopped: false,
        delayMs:
          current.disabled ||
          current.inBetweenSteps ||
          ['operator_required', 'consent_required'].includes(
            this._integrationService.integrationHealth(current).state
          )
            ? 21_600_000
            : Math.max(
                60_000,
                Math.min(
                  21_600_000,
                  (next?.getTime() ?? Date.now() + 21_600_000) - Date.now()
                )
              ),
      };
    } catch {
      return { stopped: false, delayMs: 300_000 };
    }
  }

  @ActivityMethod()
  async refreshIntegrationBatchV2(after?: string) {
    try {
      return await this._integrationService.refreshTokens(after);
    } catch {
      return { after, failed: true };
    }
  }
}
