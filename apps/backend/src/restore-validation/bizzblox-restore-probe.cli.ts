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
  validateMediaRestore,
} from './bizzblox-restore-validation';

const MAX_MANIFEST_BYTES = 4 * 1024;

type RestoreProbeKind = RestoreDatabaseKind | 'media';

type RestoreProbeDependencies = Readonly<{
  database: (kind: RestoreDatabaseKind) => Promise<DatabaseRestoreSnapshot>;
  media: (bucket: string) => Promise<MediaRestoreSnapshot>;
}>;

function fail(): never {
  throw new RestoreValidationError();
}

function kind(args: readonly string[]): RestoreProbeKind {
  if (
    args.length !== 2 ||
    args[0] !== '--kind' ||
    !['application', 'temporal', 'media'].includes(args[1] ?? '')
  ) {
    return fail();
  }
  return args[1] as RestoreProbeKind;
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

function productionDependencies(): RestoreProbeDependencies {
  return Object.freeze({
    database: (databaseKind: RestoreDatabaseKind) =>
      collectDatabaseRestoreSnapshot(
        databaseKind,
        prismaRestoreDatabaseQueryClient()
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
  dependencies: RestoreProbeDependencies = productionDependencies()
): Promise<string> {
  try {
    const resourceKind = kind(args);
    const expected = await manifest(input);
    if (resourceKind === 'media') {
      const bucket = environment.SOCIAL_RESTORED_MEDIA_BUCKET?.trim();
      if (!bucket) return fail();
      const restored = await dependencies.media(bucket);
      return validateMediaRestore({
        checksumFailureCount: 0,
        expected,
        kind: 'media',
        restored,
        version: 1,
      });
    }

    const restored = await dependencies.database(resourceKind);
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
