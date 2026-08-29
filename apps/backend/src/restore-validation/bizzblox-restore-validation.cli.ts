import type { Readable } from 'node:stream';

import {
  RestoreValidationError,
  validateDatabaseRestore,
  validateMediaRestore,
} from './bizzblox-restore-validation';

const MAX_EVIDENCE_BYTES = 16 * 1024;

type RestoreKind = 'database' | 'media';

function fail(): never {
  throw new RestoreValidationError();
}

function restoreKind(args: readonly string[]): RestoreKind {
  if (
    args.length !== 2 ||
    args[0] !== '--kind' ||
    (args[1] !== 'database' && args[1] !== 'media')
  ) {
    return fail();
  }
  return args[1];
}

async function readBoundedEvidence(input: Readable): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.byteLength;
    if (total > MAX_EVIDENCE_BYTES) {
      return fail();
    }
    chunks.push(bytes);
  }
  if (total === 0) {
    return fail();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
  } catch {
    return fail();
  }
}

/** Runs the value-free validation boundary used by the isolated restore job. */
export async function runRestoreValidationCli(
  args: readonly string[],
  input: Readable
): Promise<string> {
  const kind = restoreKind(args);
  const evidence = await readBoundedEvidence(input);
  return kind === 'database'
    ? validateDatabaseRestore(evidence)
    : validateMediaRestore(evidence);
}

async function main(): Promise<void> {
  try {
    const result = await runRestoreValidationCli(
      process.argv.slice(2),
      process.stdin
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
