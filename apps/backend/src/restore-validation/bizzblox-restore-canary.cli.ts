import { PrismaClient } from '@prisma/client';
import {
  GetObjectAttributesCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  collectDatabaseRestoreSnapshot,
  prismaRestoreDatabaseQueryClient,
  type RestoreDatabaseKind,
} from './bizzblox-database-restore-probe';
import {
  collectMediaRestoreSnapshot,
  s3RestoreMediaCommandClient,
} from './bizzblox-media-restore-probe';
import { restoreDatabaseUrlFromEnvironment } from './bizzblox-restore-database-config';
import {
  persistDatabaseRestoreCanary,
  persistDatabaseRestoreManifest,
  persistMediaRestoreCanary,
  persistMediaRestoreManifest,
} from './bizzblox-restore-canary-bootstrap';
import { RestoreProbeError } from './bizzblox-restore-probe';

type RestoreCanaryKind = RestoreDatabaseKind | 'media';

type RestoreCanaryDependencies = Readonly<{
  database: (kind: RestoreDatabaseKind) => Promise<string>;
  media: (
    config: Readonly<{ bucket: string; kmsKeyArn: string }>
  ) => Promise<string>;
}>;

function fail(): never {
  throw new RestoreProbeError();
}

function kind(args: readonly string[]): RestoreCanaryKind {
  if (
    args.length !== 2 ||
    args[0] !== '--kind' ||
    !['application', 'temporal', 'media'].includes(args[1] ?? '')
  ) {
    return fail();
  }
  return args[1] as RestoreCanaryKind;
}

function productionDependencies(
  environment: Readonly<Record<string, string | undefined>>
): RestoreCanaryDependencies {
  return Object.freeze({
    database: async (databaseKind) => {
      const client = new PrismaClient({
        datasourceUrl: restoreDatabaseUrlFromEnvironment(environment),
      });
      try {
        await client.$connect();
        const adapter = {
          execute: (statement: string) => client.$executeRawUnsafe(statement),
          query: (statement: string) =>
            client.$queryRawUnsafe<unknown[]>(statement),
        };
        await persistDatabaseRestoreCanary(adapter);
        await client.$disconnect();
        const restored = await collectDatabaseRestoreSnapshot(
          databaseKind,
          prismaRestoreDatabaseQueryClient(environment)
        );
        await client.$connect();
        return await persistDatabaseRestoreManifest(adapter, restored);
      } catch {
        return fail();
      } finally {
        try {
          await client.$disconnect();
        } catch {
          fail();
        }
      }
    },
    media: async (config) => {
      const client = new S3Client({ region: 'eu-west-2' });
      const canaryClient = {
        send: (command: PutObjectCommand | GetObjectAttributesCommand) =>
          command instanceof PutObjectCommand
            ? client.send(command)
            : client.send(command),
      };
      await persistMediaRestoreCanary(config, canaryClient);
      const restored = await collectMediaRestoreSnapshot(
        config.bucket,
        s3RestoreMediaCommandClient()
      );
      return persistMediaRestoreManifest(config, restored, canaryClient);
    },
  });
}

/** Persists one canary using only task-pinned environment and credentials. */
export async function runRestoreCanaryCli(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: RestoreCanaryDependencies = productionDependencies(environment)
): Promise<string> {
  try {
    const resourceKind = kind(args);
    if (resourceKind !== 'media')
      return await dependencies.database(resourceKind);
    const bucket = environment.BIZZBLOX_MEDIA_BUCKET?.trim();
    const kmsKeyArn = environment.BIZZBLOX_MEDIA_KMS_KEY_ARN?.trim();
    if (!bucket || !kmsKeyArn) return fail();
    return await dependencies.media({ bucket, kmsKeyArn });
  } catch {
    return fail();
  }
}

async function main(): Promise<void> {
  try {
    const result = await runRestoreCanaryCli(
      process.argv.slice(2),
      process.env
    );
    process.stdout.write(`${result}\n`);
  } catch {
    process.stderr.write('Restore probe failed.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
