import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Redirect,
} from '@nestjs/common';

import {
  BIZZBLOX_CONNECTION_CONFIG,
  type BizzbloxConnectionConfig,
  BizzbloxConnectionsService,
} from './bizzblox-connections.service';

function validatedAmpReturnUrls(config: BizzbloxConnectionConfig): Set<string> {
  const urls = Object.values(config.ampReturnUrls).map((value) => {
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
      throw new Error('Invalid BizzBLOX OAuth return configuration.');
    }
    return `${url.origin}${url.pathname}`;
  });
  return new Set(urls);
}

/** Keeps only single string values; the provider decides which names matter. */
function callbackQuery(
  query: Readonly<Record<string, unknown>>
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(query).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  );
}

@Controller('/oauth/bizzblox')
export class BizzbloxOAuthController {
  private readonly ampReturnUrls: Set<string>;

  constructor(
    private readonly connections: BizzbloxConnectionsService,
    @Inject(BIZZBLOX_CONNECTION_CONFIG) config: BizzbloxConnectionConfig
  ) {
    this.ampReturnUrls = validatedAmpReturnUrls(config);
  }

  @Get('/callback/:provider')
  @Redirect()
  async callback(
    @Param('provider') provider: string,
    @Query() query: Readonly<Record<string, unknown>> = {}
  ): Promise<Readonly<{ statusCode: 303; url: string }>> {
    const result = await this.connections.completeCallback({
      provider,
      query: callbackQuery(query),
    });
    const redirect = new URL(result.redirectUrl);
    if (
      !this.ampReturnUrls.has(`${redirect.origin}${redirect.pathname}`) ||
      redirect.username ||
      redirect.password ||
      redirect.hash
    ) {
      throw new Error('Unsafe BizzBLOX OAuth redirect.');
    }
    return { statusCode: 303, url: redirect.toString() };
  }
}
