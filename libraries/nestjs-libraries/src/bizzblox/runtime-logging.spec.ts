import { describe, expect, it, vi } from 'vitest';

import { installManagedRuntimeLogBoundary } from './runtime-logging';

describe('managed runtime log boundary', () => {
  it('emits fixed diagnostics without serializing provider requests, content, or errors', () => {
    const emitted: unknown[][] = [];
    const target = {
      debug: vi.fn((...args: unknown[]) => emitted.push(args)),
      error: vi.fn((...args: unknown[]) => emitted.push(args)),
      info: vi.fn((...args: unknown[]) => emitted.push(args)),
      log: vi.fn((...args: unknown[]) => emitted.push(args)),
      warn: vi.fn((...args: unknown[]) => emitted.push(args)),
    };
    installManagedRuntimeLogBoundary(target);

    target.log('customer post body', { access_token: 'provider-secret' });
    target.error(
      'provider request failed',
      new Error('Bearer provider-secret')
    );
    target.warn({ authorization: 'provider-secret', code: 'oauth-code' });

    expect(emitted).toEqual([
      ['Managed runtime event; details redacted.'],
      ['Managed runtime error; details redacted.'],
      ['Managed runtime warning; details redacted.'],
    ]);
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain('customer post body');
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('oauth-code');
    expect(serialized).not.toContain('provider request failed');
  });
});
