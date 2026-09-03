import { describe, expect, it } from 'vitest';
import { ConfigurationChecker } from './configuration.checker';

const BASE = {
  DATABASE_URL: 'postgresql://user:pass@db.internal:5432/social',
  JWT_SECRET: 'secret',
  FRONTEND_URL: 'https://social.example.test',
  NEXT_PUBLIC_BACKEND_URL: 'https://social.example.test',
  STORAGE_PROVIDER: 's3',
};

function check(env: Record<string, string>) {
  const checker = new ConfigurationChecker();
  checker.cfg = env;
  checker.check();
  return checker.getIssues();
}

describe('ConfigurationChecker', () => {
  it('accepts a TLS rediss:// URL and still rejects other schemes', () => {
    expect(
      check({ ...BASE, REDIS_URL: 'rediss://cache.internal:6379' })
    ).not.toContainEqual(expect.stringContaining('REDIS_URL'));
    expect(
      check({ ...BASE, REDIS_URL: 'redis://cache.internal:6379' })
    ).not.toContainEqual(expect.stringContaining('REDIS_URL'));
    expect(
      check({ ...BASE, REDIS_URL: 'https://cache.internal:6379' })
    ).toContain('REDIS_URL must start with redis:// or rediss://');
  });

  it('does not require the frontend-only URLs when running as the headless service', () => {
    const service = check({
      ...BASE,
      REDIS_URL: 'rediss://cache.internal:6379',
      BIZZBLOX_SERVICE_MODE: '1',
    });
    expect(service).toEqual([]);
  });

  it('keeps requiring MAIN_URL and BACKEND_INTERNAL_URL for the full Postiz deployment', () => {
    const full = check({ ...BASE, REDIS_URL: 'redis://cache.internal:6379' });
    expect(full).toContain('MAIN_URL not set. ');
    expect(full).toContain('BACKEND_INTERNAL_URL not set. ');
  });
});
