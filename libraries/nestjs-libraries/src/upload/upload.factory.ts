import { CloudflareStorage } from './cloudflare.storage';
import { IUploadProvider } from './upload.interface';
import { LocalStorage } from './local.storage';
import { AwsS3Storage } from './aws-s3.storage';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing managed media configuration: ${name}`);
  return value;
}

export class UploadFactory {
  static createStorage(): IUploadProvider {
    const storageProvider =
      process.env.STORAGE_PROVIDER ||
      (process.env.BIZZBLOX_SERVICE_MODE === '1' ? 'invalid' : 'local');

    switch (storageProvider) {
      case 'local':
        return new LocalStorage(process.env.UPLOAD_DIRECTORY!);
      case 'cloudflare':
        return new CloudflareStorage(
          process.env.CLOUDFLARE_ACCOUNT_ID!,
          process.env.CLOUDFLARE_ACCESS_KEY!,
          process.env.CLOUDFLARE_SECRET_ACCESS_KEY!,
          process.env.CLOUDFLARE_REGION!,
          process.env.CLOUDFLARE_BUCKETNAME!,
          process.env.CLOUDFLARE_BUCKET_URL!
        );
      case 'aws-s3':
        return new AwsS3Storage({
          bucket: requiredEnvironment('BIZZBLOX_MEDIA_BUCKET'),
          keyPrefix: 'managed-media/',
          kmsKeyArn: requiredEnvironment('BIZZBLOX_MEDIA_KMS_KEY_ARN'),
          region: requiredEnvironment('AWS_REGION') as 'eu-west-2',
          signedReadSeconds: 300,
        });
      default:
        throw new Error(`Invalid storage type ${storageProvider}`);
    }
  }
}
