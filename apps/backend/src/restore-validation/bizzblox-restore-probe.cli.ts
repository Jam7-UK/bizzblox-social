import type { Readable } from 'node:stream';

import {
  collectDatabaseRestoreSnapshot,
  prismaRestoreDatabaseQueryClient,
  type RestoreDatabaseKind,
} from './bizzblox-database-restore-probe';
import {
  collectMediaRestoreSnapshot,
  s3RestoreMediaCommandClient,
} from './bizzblox-media-restore-probe';
import type {
  DatabaseRestoreSnapshot,
  MediaRestoreSnapshot,
} from './bizzblox-restore-probe';
import {
  RestoreValidationError,
  validateDatabaseRestore,
  validateDatabaseRestoreV2,
  validateMediaRestore,
  validateMediaRestoreV2,
} from './bizzblox-restore-validation';

const MAX_MANIFEST_BYTES = 4 * 1024;

type RestoreProbeKind = RestoreDatabaseKind | 'media';
type RestoreProbeInvocation = Readonly<{
  contract: 'v1' | 'v2';
  kind: RestoreProbeKind;
}>;

type RestoreProbeDependencies = Readonly<{
  database: (kind: RestoreDatabaseKind) => Promise<DatabaseRestoreSnapshot>;
  media: (bucket: string) => Promise<MediaRestoreSnapshot>;
}>;

function fail(): never {
  throw new RestoreValidationError();
}

function invocation(args: readonly string[]): RestoreProbeInvocation {
  if (
    args[0] !== '--kind' ||
    !['application', 'temporal', 'media'].includes(args[1] ?? '') ||
    !(
      args.length === 2 ||
      (args.length === 4 && args[2] === '--contract' && args[3] === 'v2')
    )
  ) {
    return fail();
  }
  return Object.freeze({
    contract: args.length === 4 ? 'v2' : 'v1',
    kind: args[1] as RestoreProbeKind,
  });
}

async function manifest(input: Readable): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.byteLength;
    if (total > MAX_MANIFEST_BYTES) return fail();
    chunks.push(bytes);
  }
  if (total === 0) return fail();
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
  } catch {
    return fail();
  }
}

function productionDependencies(
  environment: Readonly<Record<string, string | undefined>>
): RestoreProbeDependencies {
  return Object.freeze({
    database: (databaseKind: RestoreDatabaseKind) =>
      collectDatabaseRestoreSnapshot(
        databaseKind,
        prismaRestoreDatabaseQueryClient(environment)
      ),
    media: (bucket: string) =>
      collectMediaRestoreSnapshot(bucket, s3RestoreMediaCommandClient()),
  });
}

/** Probes one restored resource and emits only its versioned validation result. */
export async function runRestoreProbeCli(
  args: readonly string[],
  input: Readable,
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: RestoreProbeDependencies = productionDependencies(environment)
): Promise<string> {
  try {
    const request = invocation(args);
    const expected =
      request.contract === 'v1' ? await manifest(input) : undefined;
    const resourceKind = request.kind;
    if (resourceKind === 'media') {
      const bucket = environment.SOCIAL_RESTORED_MEDIA_BUCKET?.trim();
      if (!bucket) return fail();
      const restored = await dependencies.media(bucket);
      const restoredEvidence = {
        byteCount: restored.byteCount,
        inventoryDigest: restored.inventoryDigest,
        objectCount: restored.objectCount,
        verifiedObjectCount: restored.verifiedObjectCount,
      };
      if (request.contract === 'v2') {
        return validateMediaRestoreV2({
          canaryVerified: restored.canaryVerified,
          checksumFailureCount: 0,
          kind: 'media',
          restored: restoredEvidence,
          version: 2,
        });
      }
      return validateMediaRestore({
        checksumFailureCount: 0,
        expected,
        kind: 'media',
        restored: restoredEvidence,
        version: 1,
      });
    }

    const restored = await dependencies.database(resourceKind);
    if (request.contract === 'v2') {
      return validateDatabaseRestoreV2({
        canaryVerified: restored.canaryVerified,
        catalogDigest: restored.dataDigest,
        connectionVerified: restored.connectionVerified,
        failedMigrationCount: restored.failedMigrationCount,
        kind: 'database',
        migrationDigest: restored.migrationDigest,
        rowCount: restored.rowCount,
        version: 2,
      });
    }
    return validateDatabaseRestore({
      connectionVerified: restored.connectionVerified,
      expected,
      failedMigrationCount: restored.failedMigrationCount,
      kind: 'database',
      restored: {
        dataDigest: restored.dataDigest,
        migrationDigest: restored.migrationDigest,
        rowCount: restored.rowCount,
      },
      version: 1,
    });
  } catch {
    return fail();
  }
}

async function main(): Promise<void> {
  try {
    const result = await runRestoreProbeCli(
      process.argv.slice(2),
      process.stdin,
      process.env
    );
    process.stdout.write(`${result}\n`);
  } catch {
    process.stderr.write('Restore validation failed.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
