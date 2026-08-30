import { describe, expect, it } from 'vitest';

import {
  shouldRegisterPostizStartupHooks,
  shouldStartMcp,
} from './bizzblox-startup-policy';

describe('BizzBLOX managed startup policy', () => {
  it.each([undefined, '', '0'])('starts MCP in normal mode (%s)', (value) => {
    expect(shouldStartMcp(value)).toBe(true);
  });

  it('does not start MCP in managed service mode', () => {
    expect(shouldStartMcp('1')).toBe(false);
  });

  it.each([undefined, '', '0'])(
    'registers Postiz startup hooks in normal mode (%s)',
    (value) => {
      expect(shouldRegisterPostizStartupHooks(value)).toBe(true);
    }
  );

  it('does not register Postiz startup hooks in managed service mode', () => {
    expect(shouldRegisterPostizStartupHooks('1')).toBe(false);
  });
});
