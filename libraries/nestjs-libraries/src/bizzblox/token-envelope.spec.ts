import { describe, expect, it } from 'vitest';

import {
  providerTokenCodecFromEnvironment,
  TokenEnvelope,
} from './token-envelope';

const KEY_V1 =
  'arn:aws:kms:eu-west-2:123456789012:key/11111111-1111-4111-8111-111111111111';
const KEY_V2 =
  'arn:aws:kms:eu-west-2:123456789012:key/22222222-2222-4222-8222-222222222222';

describe('managed provider token envelope', () => {
  it('stores no plaintext and binds KMS to the exact token context', async () => {
    const calls: Array<{
      input: Readonly<Record<string, unknown>>;
      name: string;
    }> = [];
    const client = {
      async send(command: {
        constructor: Readonly<{ name: string }>;
        input: Readonly<Record<string, unknown>>;
      }) {
        const ciphertext = command.input.CiphertextBlob;
        const kmsContext = command.input.EncryptionContext;
        calls.push({
          name: command.constructor.name,
          input: {
            ...command.input,
            ...(ciphertext instanceof Uint8Array
              ? { CiphertextBlob: Buffer.from(ciphertext) }
              : {}),
            ...(kmsContext && typeof kmsContext === 'object'
              ? { EncryptionContext: { ...kmsContext } }
              : {}),
          },
        });
        if (command.constructor.name === 'GenerateDataKeyCommand') {
          return {
            CiphertextBlob: Buffer.from('wrapped-data-key-v2', 'utf8'),
            Plaintext: Buffer.alloc(32, 37),
          };
        }
        if (command.constructor.name === 'DecryptCommand') {
          return { Plaintext: Buffer.alloc(32, 37) };
        }
        throw new Error('Unexpected KMS command');
      },
    };
    const envelope = new TokenEnvelope(
      {
        currentKeyVersion: 2,
        keyArns: { 1: KEY_V1, 2: KEY_V2 },
        region: 'eu-west-2',
      },
      { client, randomBytes: (size) => Buffer.alloc(size, 19) }
    );
    const context = {
      integrationId: 'integration_456',
      organizationId: 'organization_123',
      purpose: 'access' as const,
    };

    const stored = await envelope.seal(context, 'provider-secret-token');

    expect(stored).toMatch(/^bizzblox\.kms\.v1\.[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain('provider-secret-token');
    await expect(envelope.open(context, stored)).resolves.toBe(
      'provider-secret-token'
    );
    expect(calls).toEqual([
      {
        name: 'GenerateDataKeyCommand',
        input: {
          EncryptionContext: {
            integration: 'integration_456',
            keyVersion: '2',
            organization: 'organization_123',
            purpose: 'access',
          },
          KeyId: KEY_V2,
          KeySpec: 'AES_256',
        },
      },
      {
        name: 'DecryptCommand',
        input: {
          CiphertextBlob: Buffer.from('wrapped-data-key-v2', 'utf8'),
          EncryptionContext: {
            integration: 'integration_456',
            keyVersion: '2',
            organization: 'organization_123',
            purpose: 'access',
          },
          KeyId: KEY_V2,
        },
      },
    ]);
  });

  it('fails service startup closed when the KMS key ring is incomplete', () => {
    expect(() =>
      providerTokenCodecFromEnvironment({
        BIZZBLOX_SERVICE_MODE: '1',
        BIZZBLOX_TOKEN_KEY_VERSION: '1',
      })
    ).toThrow('Missing managed provider token configuration.');
  });

  it('reads an old key version, writes the current version, and rejects a changed context', async () => {
    const calls: Array<{
      input: Readonly<Record<string, unknown>>;
      name: string;
    }> = [];
    const client = {
      async send(command: {
        constructor: Readonly<{ name: string }>;
        input: Readonly<Record<string, unknown>>;
      }) {
        calls.push({ name: command.constructor.name, input: command.input });
        return command.constructor.name === 'GenerateDataKeyCommand'
          ? {
              CiphertextBlob: Buffer.from(
                `wrapped:${String(command.input.KeyId)}`,
                'utf8'
              ),
              Plaintext: Buffer.alloc(32, 61),
            }
          : { Plaintext: Buffer.alloc(32, 61) };
      },
    };
    const context = {
      integrationId: 'integration_456',
      organizationId: 'organization_123',
      purpose: 'refresh' as const,
    };
    const oldCodec = new TokenEnvelope(
      {
        currentKeyVersion: 1,
        keyArns: { 1: KEY_V1 },
        region: 'eu-west-2',
      },
      { client, randomBytes: (size) => Buffer.alloc(size, 7) }
    );
    const oldEnvelope = await oldCodec.seal(context, 'old-refresh-secret');
    const currentCodec = new TokenEnvelope(
      {
        currentKeyVersion: 2,
        keyArns: { 1: KEY_V1, 2: KEY_V2 },
        region: 'eu-west-2',
      },
      { client, randomBytes: (size) => Buffer.alloc(size, 9) }
    );

    await expect(currentCodec.open(context, oldEnvelope)).resolves.toBe(
      'old-refresh-secret'
    );
    const currentEnvelope = await currentCodec.seal(
      context,
      'current-refresh-secret'
    );
    const serialized = JSON.parse(
      Buffer.from(currentEnvelope.split('.')[3], 'base64url').toString('utf8')
    );
    expect(serialized.keyVersion).toBe(2);
    expect(
      calls.some(
        ({ name, input }) => name === 'DecryptCommand' && input.KeyId === KEY_V1
      )
    ).toBe(true);
    await expect(
      currentCodec.open(
        { ...context, integrationId: 'integration_other' },
        oldEnvelope
      )
    ).rejects.toThrow('Unable to open managed provider token.');
  });

  it('sanitizes a KMS data-key failure without echoing the token', async () => {
    const codec = new TokenEnvelope(
      {
        currentKeyVersion: 1,
        keyArns: { 1: KEY_V1 },
        region: 'eu-west-2',
      },
      {
        client: {
          send: async () => {
            throw new Error('KMS failure near provider-secret-token');
          },
        },
        randomBytes: (size) => Buffer.alloc(size, 5),
      }
    );

    const failure = codec.seal(
      {
        integrationId: 'integration_456',
        organizationId: 'organization_123',
        purpose: 'access',
      },
      'provider-secret-token'
    );
    await expect(failure).rejects.toThrow(
      'Unable to seal managed provider token.'
    );
    await expect(failure).rejects.not.toThrow('provider-secret-token');
  });
});
