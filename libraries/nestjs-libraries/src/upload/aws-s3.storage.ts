import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';

import { isSafePublicHttpsUrl } from '../dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '../dtos/webhooks/ssrf.safe.dispatcher';
import { parseDataUrl } from './data.url';

import type { IUploadProvider } from './upload.interface';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type') as {
  fileTypeFromBuffer: (
    bytes: Uint8Array
  ) => Promise<{ ext: string; mime: string } | undefined>;
};

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
]);

export type AwsS3StorageConfig = Readonly<{
  bucket: string;
  keyPrefix: string;
  kmsKeyArn: string;
  region: 'eu-west-2';
  signedReadSeconds: number;
}>;

type S3CommandClient = Readonly<{
  send: (command: PutObjectCommand | DeleteObjectCommand) => Promise<unknown>;
}>;

type SignedRead = (
  client: S3CommandClient,
  command: GetObjectCommand,
  options: Readonly<{ expiresIn: number }>
) => Promise<string>;

type AwsS3StorageDependencies = Readonly<{
  client: S3CommandClient;
  createId: () => string;
  sign: SignedRead;
}>;

function validateConfig(config: AwsS3StorageConfig): void {
  if (
    config.region !== 'eu-west-2' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    !/^[A-Za-z0-9!_.*'()/-]{1,128}\/$/.test(config.keyPrefix) ||
    !/^arn:aws:kms:eu-west-2:[0-9]{12}:key\/[0-9a-f-]{36}$/.test(
      config.kmsKeyArn
    ) ||
    !Number.isInteger(config.signedReadSeconds) ||
    config.signedReadSeconds < 60 ||
    config.signedReadSeconds > 900
  ) {
    throw new Error('Invalid managed S3 media configuration.');
  }
}

async function boundedBody(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) {
    throw new Error('Unable to load managed media.');
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_MEDIA_BYTES) {
    throw new Error('Media exceeds the production size limit.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel();
      throw new Error('Media exceeds the production size limit.');
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks, total);
}

async function validatedMedia(bytes: Buffer): Promise<{
  bytes: Buffer;
  extension: string;
  contentType: string;
}> {
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new Error('Media exceeds the production size limit.');
  }
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
    throw new Error('Unsupported file type.');
  }
  return {
    bytes,
    extension: detected.ext,
    contentType: detected.mime,
  };
}

export class AwsS3Storage implements IUploadProvider {
  private readonly dependencies: AwsS3StorageDependencies;

  constructor(
    private readonly config: AwsS3StorageConfig,
    dependencies?: AwsS3StorageDependencies
  ) {
    validateConfig(config);
    const client = new S3Client({ region: config.region });
    this.dependencies =
      dependencies ??
      Object.freeze({
        client,
        createId: randomUUID,
        sign: (signingClient, command, options) =>
          getSignedUrl(signingClient as S3Client, command, options),
      });
  }

  private async store(bytes: Buffer): Promise<{
    contentType: string;
    filename: string;
    signedUrl: string;
  }> {
    const media = await validatedMedia(bytes);
    const id = this.dependencies.createId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error('Invalid managed media identifier.');
    }
    const filename = `${id}.${media.extension}`;
    const key = `${this.config.keyPrefix}${filename}`;
    const encryptionContext = Buffer.from(
      JSON.stringify({ purpose: 'bizzblox-social-media', key }),
      'utf8'
    ).toString('base64');
    await this.dependencies.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: media.bytes,
        BucketKeyEnabled: true,
        ChecksumSHA256: createHash('sha256')
          .update(media.bytes)
          .digest('base64'),
        ContentLength: media.bytes.byteLength,
        ContentType: media.contentType,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.config.kmsKeyArn,
        SSEKMSEncryptionContext: encryptionContext,
      })
    );
    const signedUrl = await this.dependencies.sign(
      this.dependencies.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: this.config.signedReadSeconds }
    );
    return { contentType: media.contentType, filename, signedUrl };
  }

  async uploadSimple(path: string): Promise<string> {
    const data = path.startsWith('data:') ? parseDataUrl(path) : null;
    let bytes: Buffer;
    if (data) {
      bytes = data.buffer;
    } else {
      if (!(await isSafePublicHttpsUrl(path))) {
        throw new Error('Unsafe URL');
      }
      bytes = await boundedBody(
        await fetch(path, {
          // @ts-expect-error undici dispatcher is not part of lib.dom types.
          dispatcher: ssrfSafeDispatcher,
        })
      );
    }
    return (await this.store(bytes)).signedUrl;
  }

  async uploadFile(file: Express.Multer.File): Promise<unknown> {
    if (
      file.size > MAX_MEDIA_BYTES ||
      file.buffer.byteLength > MAX_MEDIA_BYTES
    ) {
      throw new Error('Media exceeds the production size limit.');
    }
    const stored = await this.store(file.buffer);
    return Object.freeze({
      filename: stored.filename,
      mimetype: stored.contentType,
      originalname: stored.filename,
      size: file.buffer.byteLength,
      path: stored.signedUrl,
      destination: stored.signedUrl,
    });
  }

  async removeFile(filePath: string): Promise<void> {
    let reference: URL;
    try {
      reference = new URL(filePath);
    } catch {
      throw new Error('Invalid managed media reference.');
    }
    const expectedHost = `${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
    const key = decodeURIComponent(reference.pathname.slice(1));
    if (
      reference.protocol !== 'https:' ||
      reference.hostname !== expectedHost ||
      !key.startsWith(this.config.keyPrefix) ||
      !/^[A-Za-z0-9!_.*'()/-]+$/.test(key)
    ) {
      throw new Error('Invalid managed media reference.');
    }
    await this.dependencies.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key })
    );
  }
}
