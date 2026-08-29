import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  type BinaryLike,
} from 'node:crypto';

import type { BizzbloxTenantCredentials } from './bizzblox-tenant.service';

const RECOVERY_AAD = Buffer.from(
  'bizzblox-social-tenant-credential-recovery-v1',
  'utf8'
);

export type BizzbloxTenantCredentialCodecConfig = Readonly<{
  encryptionKey: Buffer;
  hashKey: BinaryLike;
  randomBytes: (size: number) => Buffer;
}>;

function assertKey(value: Buffer): void {
  if (value.byteLength !== 32) {
    throw new Error(
      'BizzBLOX tenant recovery encryption requires a 32-byte key.'
    );
  }
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('invalid recovery envelope');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('invalid recovery envelope');
  }
  return decoded;
}

export class BizzbloxTenantCredentialCodec
  implements BizzbloxTenantCredentials
{
  constructor(private readonly config: BizzbloxTenantCredentialCodecConfig) {
    assertKey(config.encryptionKey);
  }

  generateCredential(): string {
    return `bbx_tenant_${this.config.randomBytes(32).toString('base64url')}`;
  }

  hashCredential(value: string): string {
    return `hmac-sha256:${createHmac('sha256', this.config.hashKey)
      .update(value, 'utf8')
      .digest('hex')}`;
  }

  async sealCredential(value: string): Promise<string> {
    const iv = this.config.randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.encryptionKey, iv);
    cipher.setAAD(RECOVERY_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  async unsealCredential(value: string): Promise<string> {
    try {
      const [version, encodedIv, encodedCiphertext, encodedTag, extra] =
        value.split('.');
      if (
        version !== 'v1' ||
        !encodedIv ||
        !encodedCiphertext ||
        !encodedTag ||
        extra !== undefined
      ) {
        throw new Error('invalid recovery envelope');
      }
      const iv = decode(encodedIv);
      const ciphertext = decode(encodedCiphertext);
      const tag = decode(encodedTag);
      if (
        iv.byteLength !== 12 ||
        tag.byteLength !== 16 ||
        ciphertext.byteLength === 0
      ) {
        throw new Error('invalid recovery envelope');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.config.encryptionKey,
        iv
      );
      decipher.setAAD(RECOVERY_AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Invalid recovery envelope.');
    }
  }
}
