import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction } from 'express';

import type { BizzbloxVerifiedRequest } from './bizzblox-auth.guard';

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
