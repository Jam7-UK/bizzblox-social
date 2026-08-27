import { describe, expect, it, vi } from 'vitest';

import { RedisBizzbloxReplayStore } from './bizzblox-replay.store';

describe('BizzBLOX claim replay store', () => {
  it('consumes a nonce atomically with an expiry and rejects a replay', async () => {
    const set = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const store = new RedisBizzbloxReplayStore(
      { set },
      () => new Date('2026-08-27T20:00:00.000Z')
    );

    await expect(
      store.consume('nonce_01J6DCG5GFV2X9PPYF4D8KPWYB', 1_787_860_890)
    ).resolves.toBe(true);
    await expect(
      store.consume('nonce_01J6DCG5GFV2X9PPYF4D8KPWYB', 1_787_860_890)
    ).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(/^bizzblox:claim:v1:[0-9a-f]{64}$/),
      '1',
      'EX',
      90,
      'NX'
    );
  });
});
