import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('BizzBLOX corresponding source', () => {
  it('passes the executable provenance and boundary checker', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/check-bizzblox-source.mjs'], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    ).not.toThrow();
  });

  it('pins immutable upstreams and container source labels', () => {
    expect(read('BIZZBLOX_UPSTREAM.md')).toContain(
      '0f1647f7491a217d43eb5ae7a480484bdf0aff3e'
    );
    expect(read('BIZZBLOX_UPSTREAM.md')).toContain(
      '77d09c668cb2f7793989a185844d0a0c3d65c951'
    );
    const dockerfile = read('Dockerfile.production');
    expect(dockerfile).toContain('org.opencontainers.image.source');
    expect(dockerfile).toContain('org.opencontainers.image.revision');
    expect(dockerfile).toContain('org.opencontainers.image.licenses');
    expect(dockerfile).toContain('USER 10001:10001');
    expect(dockerfile).toContain(
      '/app/node_modules/.prisma/client ./node_modules/.prisma/client'
    );
    expect(dockerfile).not.toMatch(/(:latest|FROM\s+[^\s]+:main)/);
  });

  it('publishes an immutable source archive without a proprietary import', () => {
    const workflow = read('.github/workflows/corresponding-source.yml');
    expect(workflow).toContain('git archive');
    expect(workflow).toContain('sha256sum');
    expect(workflow).toContain('actions/upload-artifact@');
    expect(read('docs/bizzblox-boundary.md')).toContain(
      'No proprietary BizzBLOX package'
    );
  });
});
