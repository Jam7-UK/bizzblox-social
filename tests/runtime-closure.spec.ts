import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('production runtime dependency closure', () => {
  it('covers every external require in both compiled service targets', () => {
    const root = resolve(import.meta.dirname, '..');
    expect(() =>
      execFileSync(process.execPath, ['scripts/check-runtime-closure.mjs'], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    ).not.toThrow();
  });
});
