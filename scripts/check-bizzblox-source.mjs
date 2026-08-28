import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appRevision = '0f1647f7491a217d43eb5ae7a480484bdf0aff3e';
const agentRevision = '77d09c668cb2f7793989a185844d0a0c3d65c951';
const required = [
  'LICENSE',
  'CCLA.md',
  'ICLA.md',
  'BIZZBLOX_UPSTREAM.md',
  'NOTICE',
  'docs/bizzblox-boundary.md',
  'Dockerfile.production',
  '.github/workflows/ci.yml',
  '.github/workflows/corresponding-source.yml',
  '.github/workflows/production-images.yml',
];

function read(file) {
  return readFileSync(resolve(root, file), 'utf8');
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

for (const file of required)
  invariant(statSync(resolve(root, file)).isFile(), `Missing ${file}`);

const provenance = read('BIZZBLOX_UPSTREAM.md');
invariant(
  provenance.includes(appRevision),
  'Postiz application revision is not pinned'
);
invariant(
  provenance.includes(agentRevision),
  'Postiz Agent revision is not pinned'
);
invariant(
  !provenance.includes('/main'),
  'Mutable upstream branch found in provenance'
);

const agentProvenance = read('libraries/postiz-agent-client/UPSTREAM.md');
invariant(
  agentProvenance.includes(agentRevision),
  'Agent client provenance disagrees'
);

const dockerfile = read('Dockerfile.production');
for (const label of [
  'org.opencontainers.image.source',
  'org.opencontainers.image.revision',
  'org.opencontainers.image.licenses',
]) {
  invariant(dockerfile.includes(label), `Missing OCI label ${label}`);
}
invariant(
  /FROM\s+[^\n]+@sha256:[0-9a-f]{64}/.test(dockerfile),
  'Base image is not digest-pinned'
);
invariant(
  !/(:latest|:main)(?:\s|$)/m.test(dockerfile),
  'Mutable container tag found'
);
invariant(
  dockerfile.includes('USER 10001:10001'),
  'Production image is not non-root'
);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [absolute] : [];
  });
}

for (const file of [
  ...sourceFiles(resolve(root, 'apps')),
  ...sourceFiles(resolve(root, 'libraries')),
]) {
  const body = readFileSync(file, 'utf8');
  const imports = body.match(/@bizzblox\/[A-Za-z0-9._/-]+/g) ?? [];
  invariant(
    imports.every((name) => name.startsWith('@bizzblox/postiz-agent-client')),
    `Proprietary BizzBLOX import in ${relative(root, file)}`
  );
}

const packageJson = JSON.parse(read('package.json'));
invariant(packageJson.license === 'AGPL-3.0', 'Root licence metadata changed');
invariant(
  packageJson.repository?.url ===
    'https://github.com/Jam7-UK/bizzblox-social.git',
  'Public source repository metadata is missing'
);

process.stdout.write('BizzBLOX source/provenance check passed.\n');
