import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_DATABASE_FIELDS = Object.freeze([
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_USERNAME',
  'DATABASE_PASSWORD',
]);
const REQUIRED_REDIS_FIELDS = Object.freeze([
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_AUTH_TOKEN',
]);

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Managed runtime requires ${name}.`);
  }
  return value;
}

function endpoint(environment, hostField, portField) {
  const host = required(environment, hostField);
  const port = required(environment, portField);
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error(`Managed runtime requires a valid ${hostField}.`);
  }
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error(`Managed runtime requires a valid ${portField}.`);
  }
  return { host, port };
}

export function buildManagedRuntimeEnvironment(
  environment,
  { includeRedis = true } = {}
) {
  if (environment.BIZZBLOX_SERVICE_MODE !== '1') {
    return {};
  }
  for (const field of REQUIRED_DATABASE_FIELDS) {
    required(environment, field);
  }
  if (includeRedis) {
    for (const field of REQUIRED_REDIS_FIELDS) required(environment, field);
  }

  const database = endpoint(environment, 'DATABASE_HOST', 'DATABASE_PORT');
  const databaseName = environment.DATABASE_NAME || 'bizzblox_social';
  if (!/^[A-Za-z0-9_]{1,63}$/.test(databaseName)) {
    throw new Error('Managed runtime requires a valid DATABASE_NAME.');
  }

  const databaseUser = encodeURIComponent(
    required(environment, 'DATABASE_USERNAME')
  );
  const databasePassword = encodeURIComponent(
    required(environment, 'DATABASE_PASSWORD')
  );
  const result = {
    DATABASE_URL: `postgresql://${databaseUser}:${databasePassword}@${database.host}:${database.port}/${databaseName}?sslmode=require`,
  };
  if (!includeRedis) return result;
  const redis = endpoint(environment, 'REDIS_HOST', 'REDIS_PORT');
  const redisToken = encodeURIComponent(
    required(environment, 'REDIS_AUTH_TOKEN')
  );
  return {
    ...result,
    REDIS_URL: `rediss://:${redisToken}@${redis.host}:${redis.port}`,
  };
}

async function runModule(relativePath) {
  await import(new URL(relativePath, import.meta.url));
}

async function runApplicationSchemaMigration() {
  const prismaCli = fileURLToPath(
    new URL('../node_modules/prisma/build/index.js', import.meta.url)
  );
  const schema = fileURLToPath(
    new URL('../prisma/schema.prisma', import.meta.url)
  );
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [prismaCli, 'db', 'push', '--skip-generate', '--schema', schema],
      { stdio: 'inherit', env: process.env }
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Application schema migration failed (${signal || `exit ${code}`}).`
        )
      );
    });
  });
}

async function main() {
  const mode = process.argv[2];
  Object.assign(
    process.env,
    buildManagedRuntimeEnvironment(process.env, {
      includeRedis: mode !== 'migrate-application-schema',
    })
  );
  switch (mode) {
    case 'api':
      await runModule('../apps/backend/dist/apps/backend/src/main.js');
      return;
    case 'orchestrator':
      await runModule(
        '../apps/orchestrator/dist/apps/orchestrator/src/main.js'
      );
      return;
    case 'migrate-application-schema':
      await runApplicationSchemaMigration();
      return;
    default:
      throw new Error(
        'Expected api, orchestrator, or migrate-application-schema.'
      );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Managed runtime failed.'
    );
    process.exitCode = 1;
  });
}
