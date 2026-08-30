import { describe, expect, it } from 'vitest';

import { shouldStartMcp } from './bizzblox-startup-policy';

describe('BizzBLOX managed startup policy', () => {
  it.each([undefined, '', '0'])('starts MCP in normal mode (%s)', (value) => {
    expect(shouldStartMcp(value)).toBe(true);
  });

  it('does not start MCP in managed service mode', () => {
    expect(shouldStartMcp('1')).toBe(false);
  });
});
