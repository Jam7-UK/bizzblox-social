import { describe, expect, it } from 'vitest';

import { RestoreProbeError } from './bizzblox-restore-probe';
import { restoreDatabaseUrlFromEnvironment } from './bizzblox-restore-database-config';

describe('BizzBLOX restore database configuration', () => {
  it('builds one TLS-required URL from task-pinned connection fields', () => {
    expect(
      restoreDatabaseUrlFromEnvironment({
        DATABASE_HOST: 'restore-app.abcdefghijkl.eu-west-2.rds.amazonaws.com',
        DATABASE_NAME: 'bizzblox_social',
        DATABASE_PASSWORD: 'secret:/?#[]@ value',
        DATABASE_PORT: '5432',
        DATABASE_USERNAME: 'social_admin@example',
      })
    ).toBe(
      'postgresql://social_admin%40example:secret%3A%2F%3F%23%5B%5D%40%20value@restore-app.abcdefghijkl.eu-west-2.rds.amazonaws.com:5432/bizzblox_social?sslmode=require'
    );
  });

  it.each([
    {},
    {
      DATABASE_HOST: 'restore.invalid/path',
      DATABASE_NAME: 'bizzblox_social',
      DATABASE_PASSWORD: 'secret',
      DATABASE_PORT: '5432',
      DATABASE_USERNAME: 'social_admin',
    },
    {
      DATABASE_HOST: 'restore.example',
      DATABASE_NAME: 'bizzblox_social',
      DATABASE_PASSWORD: 'secret',
      DATABASE_PORT: '70000',
      DATABASE_USERNAME: 'social_admin',
    },
  ])('fails closed for missing or invalid task fields', (environment) => {
    try {
      restoreDatabaseUrlFromEnvironment(environment);
      throw new Error('expected database configuration to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreProbeError);
      expect((error as Error).message).toBe('Restore probe failed.');
      expect((error as Error).message).not.toContain('secret');
    }
  });
});
