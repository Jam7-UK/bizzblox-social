import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BizzbloxTenantCredentialCodec } from './bizzblox-tenant-credentials';

describe('BizzBLOX tenant credential codec', () => {
  it('generates opaque credentials and authenticates encrypted recovery envelopes', async () => {
    const codec = new BizzbloxTenantCredentialCodec({
      encryptionKey: randomBytes(32),
      hashKey: randomBytes(32),
      randomBytes,
    });

    const first = codec.generateCredential();
    const second = codec.generateCredential();
    expect(first).toMatch(/^bbx_tenant_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(codec.hashCredential(first)).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(codec.hashCredential(first)).not.toContain(first);

    const envelope = await codec.sealCredential(first);
    expect(envelope).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
    );
    expect(envelope).not.toContain(first);
    await expect(codec.unsealCredential(envelope)).resolves.toBe(first);

    const tampered = `${envelope.slice(0, -1)}${
      envelope.endsWith('A') ? 'B' : 'A'
    }`;
    await expect(codec.unsealCredential(tampered)).rejects.toThrow(
      /invalid recovery envelope/i
    );
  });
});
