import { describe, expect, it } from 'vitest';

import {
  socialEnvironmentFromIdempotencyKey,
  socialEnvironmentFromTenantHandle,
} from './bizzblox-environment';

const OPAQUE = 'A'.repeat(43);

describe('BizzBLOX social environment identifiers', () => {
  it.each([
    [`tenant_${OPAQUE}-dev`, 'dev'],
    [`tenant_${OPAQUE}-preprod`, 'preprod'],
    [`tenant_${OPAQUE}-prod`, 'prod'],
  ] as const)('binds %s to %s', (handle, environment) => {
    expect(socialEnvironmentFromTenantHandle(handle)).toBe(environment);
  });

  it.each([
    [`idem_${OPAQUE}-dev`, 'dev'],
    [`idem_${OPAQUE}-preprod`, 'preprod'],
    [`idem_${OPAQUE}-prod`, 'prod'],
  ] as const)('binds %s to %s', (key, environment) => {
    expect(socialEnvironmentFromIdempotencyKey(key)).toBe(environment);
  });

  it.each([
    `tenant_${OPAQUE}`,
    `tenant_${OPAQUE}-staging`,
    `tenant_short-dev`,
    `idem_${OPAQUE}`,
    `idem_${OPAQUE}-production`,
    `idem_short-prod`,
  ])('rejects non-canonical identifier %s', (value) => {
    expect(socialEnvironmentFromTenantHandle(value)).toBeNull();
    expect(socialEnvironmentFromIdempotencyKey(value)).toBeNull();
  });
});
