import { describe, expect, it } from 'vitest';

import { buildManagedRuntimeEnvironment } from './bizzblox-managed-runtime-entry.mjs';

describe('managed runtime entrypoint', () => {
  it('constructs encoded TLS database and Redis URLs only in process memory', () => {
    expect(
      buildManagedRuntimeEnvironment({
        BIZZBLOX_SERVICE_MODE: '1',
        DATABASE_HOST: 'db.internal',
        DATABASE_PORT: '5432',
        DATABASE_USERNAME: 'social user',
        DATABASE_PASSWORD: 'p@ss:/word',
        REDIS_HOST: 'cache.internal',
        REDIS_PORT: '6379',
        REDIS_AUTH_TOKEN: 'redis:/secret',
      })
    ).toEqual({
      DATABASE_URL:
        'postgresql://social%20user:p%40ss%3A%2Fword@db.internal:5432/bizzblox_social?sslmode=require',
      REDIS_URL: 'rediss://:redis%3A%2Fsecret@cache.internal:6379',
    });
  });

  it('fails closed when a managed runtime secret or endpoint is absent', () => {
    expect(() =>
      buildManagedRuntimeEnvironment({ BIZZBLOX_SERVICE_MODE: '1' })
    ).toThrow('DATABASE_HOST');
  });

  it('does not synthesize credentials outside managed service mode', () => {
    expect(buildManagedRuntimeEnvironment({})).toEqual({});
  });

  it('builds only the database URL for the isolated schema task', () => {
    expect(
      buildManagedRuntimeEnvironment(
        {
          BIZZBLOX_SERVICE_MODE: '1',
          DATABASE_HOST: 'db.internal',
          DATABASE_PORT: '5432',
          DATABASE_USERNAME: 'social_admin',
          DATABASE_PASSWORD: 'database-secret',
        },
        { includeRedis: false }
      )
    ).toEqual({
      DATABASE_URL:
        'postgresql://social_admin:database-secret@db.internal:5432/bizzblox_social?sslmode=require',
    });
  });
});
