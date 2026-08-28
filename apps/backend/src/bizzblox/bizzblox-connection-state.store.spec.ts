import { describe, expect, it } from 'vitest';

import {
  BizzbloxConnectionStateCodec,
  RedisBizzbloxConnectionStateStore,
} from './bizzblox-connection-state.store';
import type {
  BizzbloxAuthorizationState,
  BizzbloxSelectionState,
} from './bizzblox-connections.service';

describe('BizzBLOX managed connection state store', () => {
  it('encrypts authorization state and consumes it exactly once', async () => {
    const values = new Map<string, string>();
    const writes: Array<readonly unknown[]> = [];
    const redis = {
      async getdel(key: string) {
        const value = values.get(key) ?? null;
        values.delete(key);
        return value;
      },
      async set(...args: [string, string, 'PX', number, 'NX']) {
        writes.push(args);
        values.set(args[0], args[1]);
        return 'OK' as const;
      },
    };
    const clock = () => new Date('2026-08-27T22:00:00.000Z');
    const store = new RedisBizzbloxConnectionStateStore(
      redis,
      new BizzbloxConnectionStateCodec({
        encryptionKey: Buffer.alloc(32, 1),
        randomBytes: (size) => Buffer.alloc(size, 2),
      }),
      clock
    );
    const state: BizzbloxAuthorizationState = {
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'linkedin',
      codeVerifier: 'pkce-verifier-1',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
      expiresAt: Date.parse('2026-08-27T22:10:00.000Z'),
    };

    await store.saveAuthorization('provider-state-1', state);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toMatch(
      /^bizzblox:connection:authorization:v1:[0-9a-f]{64}$/
    );
    expect(writes[0]?.[1]).not.toContain('postiz-org-1');
    expect(writes[0]?.[1]).not.toContain('pkce-verifier-1');
    expect(writes[0]?.slice(2)).toEqual(['PX', 600_000, 'NX']);
    await expect(
      store.consumeAuthorization('provider-state-1')
    ).resolves.toEqual(state);
    await expect(
      store.consumeAuthorization('provider-state-1')
    ).resolves.toBeNull();
  });

  it('namespaces one-use page selection state to the exact tenant revision', async () => {
    const values = new Map<string, string>();
    const redis = {
      async getdel(key: string) {
        const value = values.get(key) ?? null;
        values.delete(key);
        return value;
      },
      async set(key: string, value: string) {
        values.set(key, value);
        return 'OK' as const;
      },
    };
    const store = new RedisBizzbloxConnectionStateStore(
      redis,
      new BizzbloxConnectionStateCodec({
        encryptionKey: Buffer.alloc(32, 3),
        randomBytes: (size) => Buffer.alloc(size, 4),
      }),
      () => new Date('2026-08-27T22:00:00.000Z')
    );
    const state: BizzbloxSelectionState = {
      organizationId: 'postiz-org-1',
      connectorRevision: 7,
      provider: 'linkedin',
      integrationId: 'integration-linkedin-1',
      ampReturnUrl: 'https://mvp.bizzblox.com/settings/social',
      expiresAt: Date.parse('2026-08-27T22:05:00.000Z'),
      options: [
        {
          optionRef: 'selection-option-1',
          label: 'BizzBLOX Company',
          picture: null,
          selector: { pageId: 'remote-page-123' },
        },
      ],
    };

    await store.saveSelection('selection-attempt-1', state);

    await expect(
      store.consumeSelection('postiz-org-2', 7, 'selection-attempt-1')
    ).resolves.toBeNull();
    await expect(
      store.consumeSelection('postiz-org-1', 7, 'selection-attempt-1')
    ).resolves.toEqual(state);
    await expect(
      store.consumeSelection('postiz-org-1', 7, 'selection-attempt-1')
    ).resolves.toBeNull();
  });
});
