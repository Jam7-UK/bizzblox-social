import {
  Injectable,
  type MiddlewareConsumer,
  type NestMiddleware,
  RequestMethod,
} from '@nestjs/common';
import type { NextFunction } from 'express';

import type { BizzbloxVerifiedRequest } from './bizzblox-auth.guard';

/**
 * Every route the IAM context middleware covers: the whole gateway-proxied
 * prefix that `BizzbloxController`, `BizzbloxConnectionsController` and
 * `BizzbloxPublicationsController` serve. Scoped by path, not by controller
 * class: `forRoutes(SomeController)` expands to each route and Nest's
 * overlapped-route check then turns the escaped colon of custom-method paths
 * (`/tenants\:ensure`) into an invalid regular expression, which crashes the
 * API at startup (production, 2026-09-03).
 */
export const BIZZBLOX_IAM_CONTEXT_ROUTES = Object.freeze({
  path: 'internal/bizzblox/v1/{*splat}',
  method: RequestMethod.ALL,
});

/** Shared by the production module and the route spec so both wire the same scope. */
export function applyBizzbloxIamContext(consumer: MiddlewareConsumer): void {
  consumer
    .apply(BizzbloxIamContextMiddleware)
    .forRoutes(BIZZBLOX_IAM_CONTEXT_ROUTES);
}

@Injectable()
export class BizzbloxIamContextMiddleware implements NestMiddleware {
  use(
    request: Pick<BizzbloxVerifiedRequest, 'headers' | 'bizzbloxIam'>,
    _response: unknown,
    next: NextFunction
  ): void {
    const accountId = request.headers['x-bizzblox-iam-account'];
    const principalArn = request.headers['x-bizzblox-iam-principal'];
    if (typeof accountId === 'string' && typeof principalArn === 'string') {
      request.bizzbloxIam = Object.freeze({ accountId, principalArn });
    }
    next();
  }
}
