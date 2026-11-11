import { Command, Positional } from 'nestjs-command';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';

@Injectable()
export class RefreshTokens {
  constructor(
    private _integrationService: IntegrationService,
    private refreshService: RefreshIntegrationService
  ) {}
  @Command({
    command: 'refresh',
    describe: 'Refresh all tokens',
  })
  async refresh() {
    let after: string | undefined;
    do {
      ({ after } = await this._integrationService.refreshTokens(after));
    } while (after);
    return true;
  }
  @Command({
    command: 'refresh-holds',
    describe:
      'List credential recovery holds without credentials or provider errors',
  })
  async holds() {
    let after: string | undefined;
    do {
      const rows = await this._integrationService.listRefreshHolds(after);
      for (const row of rows) console.log(JSON.stringify(row));
      after = rows.length === 100 ? rows[rows.length - 1].id : undefined;
    } while (after);
  }

  @Command({
    command:
      'refresh-retry-configuration <organization> <integration> <generation> <revision>',
    describe:
      'Retry a repaired configuration using exact current health evidence; uncertain rotating exchanges remain held',
  })
  async retryConfiguration(
    @Positional({ name: 'organization', type: 'string' }) organization: string,
    @Positional({ name: 'integration', type: 'string' }) integration: string,
    @Positional({ name: 'generation', type: 'number' }) generation: number,
    @Positional({ name: 'revision', type: 'number' }) revision: number
  ) {
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      throw new Error('Invalid credential health evidence.');
    const accepted = await this.refreshService.retryConfiguration(
      organization,
      integration,
      generation,
      revision
    );
    console.log(JSON.stringify({ accepted }));
  }
}
