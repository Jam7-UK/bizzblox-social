import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as systemRandomBytes,
} from 'node:crypto';

const ENVELOPE_PREFIX = 'bizzblox.kms.v1.';
const MAX_TOKEN_BYTES = 64 * 1024;
const KMS_KEY_ARN =
  /^arn:aws:kms:eu-west-2:[0-9]{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_CONTEXT = /^[A-Za-z0-9_-]{1,256}$/;

export type ProviderTokenPurpose = 'access' | 'refresh';

export type ProviderTokenContext = Readonly<{
  integrationId: string;
  organizationId: string;
  purpose: ProviderTokenPurpose;
}>;

export type TokenEnvelopeConfig = Readonly<{
  currentKeyVersion: number;
  keyArns: Readonly<Record<number, string>>;
  region: 'eu-west-2';
}>;

export type ProviderTokenCodec = Readonly<{
  open: (context: ProviderTokenContext, value: string) => Promise<string>;
  seal: (context: ProviderTokenContext, plaintext: string) => Promise<string>;
}>;

export const PROVIDER_TOKEN_CODEC = Symbol('PROVIDER_TOKEN_CODEC');

const plaintextProviderTokenCodec: ProviderTokenCodec = Object.freeze({
  open: async (_context, value) => value,
  seal: async (_context, value) => value,
});

type KmsResult = Readonly<{
  CiphertextBlob?: Uint8Array;
  Plaintext?: Uint8Array;
}>;

type KmsClient = Readonly<{
  send: (
    command: GenerateDataKeyCommand | DecryptCommand
  ) => Promise<KmsResult>;
}>;

type TokenEnvelopeDependencies = Readonly<{
  client: KmsClient;
  randomBytes: (size: number) => Buffer;
}>;

type SerializedEnvelope = Readonly<{
  algorithm: 'A256GCM';
  ciphertext: string;
  encryptedDataKey: string;
  iv: string;
  keyVersion: number;
  tag: string;
}>;

function validateConfig(config: TokenEnvelopeConfig): void {
  const versions = Object.entries(config.keyArns);
  if (
    config.region !== 'eu-west-2' ||
    !Number.isSafeInteger(config.currentKeyVersion) ||
    config.currentKeyVersion < 1 ||
    versions.length === 0 ||
    !config.keyArns[config.currentKeyVersion] ||
    versions.some(
      ([version, arn]) =>
        !/^[1-9][0-9]{0,8}$/.test(version) || !KMS_KEY_ARN.test(arn)
    )
  ) {
    throw new Error('Invalid managed provider token configuration.');
  }
}

function validateContext(context: ProviderTokenContext): void {
  if (
    !OPAQUE_CONTEXT.test(context.organizationId) ||
    !OPAQUE_CONTEXT.test(context.integrationId) ||
    !['access', 'refresh'].includes(context.purpose)
  ) {
    throw new Error('Invalid managed provider token context.');
  }
}

function encryptionContext(
  context: ProviderTokenContext,
  keyVersion: number
): Readonly<Record<string, string>> {
  return Object.freeze({
    integration: context.integrationId,
    keyVersion: String(keyVersion),
    organization: context.organizationId,
    purpose: context.purpose,
  });
}

function additionalData(
  context: ProviderTokenContext,
  keyVersion: number
): Buffer {
  return Buffer.from(
    JSON.stringify({
      integration: context.integrationId,
      keyVersion,
      organization: context.organizationId,
      purpose: context.purpose,
    }),
    'utf8'
  );
}

function canonicalBase64Url(value: string, maximumBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid managed provider token envelope.');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > maximumBytes ||
    decoded.toString('base64url') !== value
  ) {
    throw new Error('Invalid managed provider token envelope.');
  }
  return decoded;
}

function parseEnvelope(value: string): SerializedEnvelope {
  if (
    !value.startsWith(ENVELOPE_PREFIX) ||
    value.length > MAX_TOKEN_BYTES * 2
  ) {
    throw new Error('Invalid managed provider token envelope.');
  }
  const encoded = value.slice(ENVELOPE_PREFIX.length);
  const serialized = canonicalBase64Url(encoded, MAX_TOKEN_BYTES * 2);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized.toString('utf8'));
  } catch {
    throw new Error('Invalid managed provider token envelope.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid managed provider token envelope.');
  }
  const envelope = parsed as Partial<Record<keyof SerializedEnvelope, unknown>>;
  const keys = Object.keys(envelope).sort();
  if (
    keys.join(',') !==
      'algorithm,ciphertext,encryptedDataKey,iv,keyVersion,tag' ||
    envelope.algorithm !== 'A256GCM' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.encryptedDataKey !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    !Number.isSafeInteger(envelope.keyVersion) ||
    Number(envelope.keyVersion) < 1
  ) {
    throw new Error('Invalid managed provider token envelope.');
  }
  return envelope as SerializedEnvelope;
}

function clear(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

export class TokenEnvelope {
  private readonly dependencies: TokenEnvelopeDependencies;

  constructor(
    private readonly config: TokenEnvelopeConfig,
    dependencies?: TokenEnvelopeDependencies
  ) {
    validateConfig(config);
    this.dependencies =
      dependencies ??
      Object.freeze({
        client: new KMSClient({ region: config.region }),
        randomBytes: systemRandomBytes,
      });
  }

  async seal(
    context: ProviderTokenContext,
    plaintext: string
  ): Promise<string> {
    validateContext(context);
    const plaintextBytes = Buffer.from(plaintext, 'utf8');
    if (
      plaintextBytes.byteLength === 0 ||
      plaintextBytes.byteLength > MAX_TOKEN_BYTES
    ) {
      clear(plaintextBytes);
      throw new Error('Invalid managed provider token value.');
    }
    const keyVersion = this.config.currentKeyVersion;
    const keyArn = this.config.keyArns[keyVersion];
    let generated: KmsResult | undefined;
    let dataKey: Buffer | undefined;
    try {
      generated = await this.dependencies.client.send(
        new GenerateDataKeyCommand({
          EncryptionContext: encryptionContext(context, keyVersion),
          KeyId: keyArn,
          KeySpec: 'AES_256',
        })
      );
      dataKey = generated.Plaintext
        ? Buffer.from(generated.Plaintext)
        : undefined;
      if (
        !dataKey ||
        dataKey.byteLength !== 32 ||
        !generated.CiphertextBlob ||
        generated.CiphertextBlob.byteLength === 0 ||
        generated.CiphertextBlob.byteLength > 6144
      ) {
        throw new Error('Unable to seal managed provider token.');
      }
      const iv = this.dependencies.randomBytes(12);
      if (iv.byteLength !== 12) {
        throw new Error('Unable to seal managed provider token.');
      }
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv, {
        authTagLength: 16,
      });
      cipher.setAAD(additionalData(context, keyVersion));
      const ciphertext = Buffer.concat([
        cipher.update(plaintextBytes),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const serialized: SerializedEnvelope = Object.freeze({
        algorithm: 'A256GCM',
        ciphertext: ciphertext.toString('base64url'),
        encryptedDataKey: Buffer.from(generated.CiphertextBlob).toString(
          'base64url'
        ),
        iv: iv.toString('base64url'),
        keyVersion,
        tag: tag.toString('base64url'),
      });
      return `${ENVELOPE_PREFIX}${Buffer.from(
        JSON.stringify(serialized),
        'utf8'
      ).toString('base64url')}`;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Unable to seal managed provider token.'
      ) {
        throw error;
      }
      throw new Error('Unable to seal managed provider token.');
    } finally {
      clear(plaintextBytes);
      clear(dataKey);
      clear(generated?.Plaintext);
    }
  }

  async open(context: ProviderTokenContext, value: string): Promise<string> {
    validateContext(context);
    const envelope = parseEnvelope(value);
    const keyArn = this.config.keyArns[envelope.keyVersion];
    if (!keyArn) {
      throw new Error('Unable to open managed provider token.');
    }
    let encryptedDataKey: Buffer | undefined;
    let iv: Buffer | undefined;
    let tag: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    try {
      encryptedDataKey = canonicalBase64Url(envelope.encryptedDataKey, 6144);
      iv = canonicalBase64Url(envelope.iv, 12);
      tag = canonicalBase64Url(envelope.tag, 16);
      ciphertext = canonicalBase64Url(
        envelope.ciphertext,
        MAX_TOKEN_BYTES + 16
      );
      if (iv.byteLength !== 12 || tag.byteLength !== 16) {
        throw new Error('Unable to open managed provider token.');
      }
      const decrypted = await this.dependencies.client.send(
        new DecryptCommand({
          CiphertextBlob: encryptedDataKey,
          EncryptionContext: encryptionContext(context, envelope.keyVersion),
          KeyId: keyArn,
        })
      );
      const dataKey = decrypted.Plaintext
        ? Buffer.from(decrypted.Plaintext)
        : undefined;
      try {
        if (!dataKey || dataKey.byteLength !== 32) {
          throw new Error('Unable to open managed provider token.');
        }
        const decipher = createDecipheriv('aes-256-gcm', dataKey, iv, {
          authTagLength: 16,
        });
        decipher.setAAD(additionalData(context, envelope.keyVersion));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        if (
          plaintext.byteLength === 0 ||
          plaintext.byteLength > MAX_TOKEN_BYTES
        ) {
          clear(plaintext);
          throw new Error('Unable to open managed provider token.');
        }
        const result = plaintext.toString('utf8');
        clear(plaintext);
        return result;
      } finally {
        clear(dataKey);
        clear(decrypted.Plaintext);
      }
    } catch {
      throw new Error('Unable to open managed provider token.');
    } finally {
      clear(encryptedDataKey);
      clear(iv);
      clear(tag);
      clear(ciphertext);
    }
  }
}

export function providerTokenCodecFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ProviderTokenCodec {
  if (environment.BIZZBLOX_SERVICE_MODE !== '1') {
    return plaintextProviderTokenCodec;
  }
  const currentArn = environment.BIZZBLOX_TOKEN_KMS_KEY_ARN?.trim();
  const versionValue = environment.BIZZBLOX_TOKEN_KEY_VERSION?.trim();
  if (!currentArn || !versionValue || !/^[1-9][0-9]{0,8}$/.test(versionValue)) {
    throw new Error('Missing managed provider token configuration.');
  }
  const currentKeyVersion = Number(versionValue);
  let previousKeys: unknown = {};
  const serializedPrevious =
    environment.BIZZBLOX_TOKEN_KMS_PREVIOUS_KEYS?.trim();
  if (serializedPrevious) {
    try {
      previousKeys = JSON.parse(serializedPrevious);
    } catch {
      throw new Error('Invalid managed provider token configuration.');
    }
  }
  if (
    !previousKeys ||
    typeof previousKeys !== 'object' ||
    Array.isArray(previousKeys) ||
    Object.keys(previousKeys).length > 10
  ) {
    throw new Error('Invalid managed provider token configuration.');
  }
  const keyArns = {
    ...(previousKeys as Record<number, string>),
    [currentKeyVersion]: currentArn,
  };
  return new TokenEnvelope({
    currentKeyVersion,
    keyArns,
    region: 'eu-west-2',
  });
}
