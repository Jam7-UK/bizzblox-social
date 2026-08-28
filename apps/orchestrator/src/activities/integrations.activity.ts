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

  async refreshToken(integration: Integration) {
    const refresh = await this._refreshIntegrationService.refresh(integration);
    return refresh ? refreshForTemporalHistory(refresh) : false;
  }
}
