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

function validatedAmpReturnUrl(config: BizzbloxConnectionConfig): URL {
  const url = new URL(config.ampReturnUrl);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.bizzblox.com') ||
    !url.pathname.startsWith('/settings') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid BizzBLOX OAuth return configuration.');
  }
  return url;
}

@Controller('/oauth/bizzblox')
export class BizzbloxOAuthController {
  private readonly ampReturnUrl: URL;

  constructor(
    private readonly connections: BizzbloxConnectionsService,
    @Inject(BIZZBLOX_CONNECTION_CONFIG) config: BizzbloxConnectionConfig
  ) {
    this.ampReturnUrl = validatedAmpReturnUrl(config);
  }

  @Get('/callback/:provider')
  @Redirect()
  async callback(
    @Param('provider') provider: string,
    @Query('state') providerState?: string,
    @Query('code') code?: string
  ): Promise<Readonly<{ statusCode: 303; url: string }>> {
    const result = await this.connections.completeCallback({
      provider,
      providerState: providerState ?? '',
      code: code ?? '',
    });
    if (result.outcome === 'selection_required') {
      const redirect = new URL(this.ampReturnUrl);
      redirect.searchParams.set('social', 'selection_required');
      redirect.hash = new URLSearchParams({
        selection: Buffer.from(
          JSON.stringify({
            attemptHandle: result.attemptHandle,
            expiresAt: result.expiresAt,
            options: result.options,
          }),
          'utf8'
        ).toString('base64url'),
      }).toString();
      return { statusCode: 303, url: redirect.toString() };
    }

    const redirect = new URL(result.redirectUrl);
    if (
      redirect.origin !== this.ampReturnUrl.origin ||
      redirect.pathname !== this.ampReturnUrl.pathname ||
      redirect.username ||
      redirect.password ||
      redirect.hash
    ) {
      throw new Error('Unsafe BizzBLOX OAuth redirect.');
    }
    return { statusCode: 303, url: redirect.toString() };
  }
}
