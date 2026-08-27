import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { BizzbloxReplayStore } from './bizzblox-auth.guard';

export const BIZZBLOX_REDIS = Symbol('BIZZBLOX_REDIS');

export interface BizzbloxReplayRedis {
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
    condition: 'NX'
  ): Promise<'OK' | null>;
}

@Injectable()
export class RedisBizzbloxReplayStore implements BizzbloxReplayStore {
  constructor(
    @Inject(BIZZBLOX_REDIS)
    private readonly redis: BizzbloxReplayRedis,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async consume(nonce: string, expiresAt: number): Promise<boolean> {
    const now = Math.floor(this.clock().getTime() / 1_000);
    const ttlSeconds = Math.min(120, expiresAt - now);
    if (ttlSeconds <= 0) return false;
    const nonceDigest = createHash('sha256')
      .update(nonce, 'utf8')
      .digest('hex');
    return (
      (await this.redis.set(
        `bizzblox:claim:v1:${nonceDigest}`,
        '1',
        'EX',
        ttlSeconds,
        'NX'
      )) === 'OK'
    );
  }
}
