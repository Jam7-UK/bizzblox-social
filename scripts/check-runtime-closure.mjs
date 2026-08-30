import { builtinModules, createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runtimeManifest = JSON.parse(
  readFileSync(resolve(root, 'apps/service-runtime/package.json'))
);
const declared = new Set(Object.keys(runtimeManifest.dependencies ?? {}));
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return files(absolute);
    return entry.name.endsWith('.js') ? [absolute] : [];
  });
}

function packageName(specifier) {
  if (specifier.startsWith('@'))
    return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/', 1)[0];
}

const buildDirectories = ['apps/backend/dist', 'apps/orchestrator/dist'];
for (const directory of buildDirectories) {
  const absolute = resolve(root, directory);
  if (!statSync(absolute).isDirectory())
    throw new Error(`Missing production build ${directory}`);
}

const missing = new Map();
const unresolvedLocal = new Map();
for (const file of buildDirectories.flatMap((directory) =>
  files(resolve(root, directory))
)) {
  const body = readFileSync(file, 'utf8');
  const matches = body.matchAll(/require\((?:'([^']+)'|"([^"]+)")\)/g);
  for (const match of matches) {
    const specifier = match[1] ?? match[2];
    if (!specifier || specifier.startsWith('/') || builtins.has(specifier)) {
      continue;
    }
    if (specifier.startsWith('.')) {
      try {
        createRequire(file).resolve(specifier);
      } catch {
        const consumers = unresolvedLocal.get(specifier) ?? [];
        consumers.push(relative(root, file));
        unresolvedLocal.set(specifier, consumers);
      }
      continue;
    }
    const dependency = packageName(specifier);
    if (!declared.has(dependency)) {
      const consumers = missing.get(dependency) ?? [];
      consumers.push(relative(root, file));
      missing.set(dependency, consumers);
    }
  }
}

if (missing.size > 0 || unresolvedLocal.size > 0) {
  const externalDetails = [...missing.entries()]
    .map(
      ([dependency, consumers]) =>
        `${dependency}: ${[...new Set(consumers)].slice(0, 3).join(', ')}`
    )
    .join('\n');
  const localDetails = [...unresolvedLocal.entries()]
    .map(
      ([specifier, consumers]) =>
        `${specifier}: ${[...new Set(consumers)].slice(0, 3).join(', ')}`
    )
    .join('\n');
  throw new Error(
    `Production runtime dependencies are incomplete:\n${[
      externalDetails,
      localDetails,
    ]
      .filter(Boolean)
      .join('\n')}`
  );
}

process.stdout.write(
  `Runtime closure check passed (${declared.size} declared packages).\n`
);
