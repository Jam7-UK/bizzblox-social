import { describe, expect, it, vi } from 'vitest';
const activity = vi.hoisted(() => ({
  recoverIntegrationV2: vi.fn(),
  refreshIntegrationBatchV2: vi.fn(),
}));
const calls = vi.hoisted(() => ({
  options: [] as unknown[],
  sleeps: [] as unknown[],
  continued: vi.fn(),
}));
vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (options) => {
    calls.options.push(options);
    return activity;
  },
  sleep: async (delay) => {
    calls.sleeps.push(delay);
  },
  continueAsNew: (...args) => {
    calls.continued(...args);
    throw new Error('continued');
  },
}));
import {
  refreshTokenWorkflowV2,
  refreshTokensSweepWorkflowV2,
} from './refresh.token.workflow.v2';

describe('refresh workflow successor', () => {
  it('survives lost activities with slow durable retries, bounded history and identifier-only continuation', async () => {
    activity.recoverIntegrationV2
      .mockRejectedValueOnce(new Error('worker disappeared'))
      .mockResolvedValue({ stopped: false, delayMs: 1 });
    const input = { organizationId: 'org', integrationId: 'channel' };
    await expect(refreshTokenWorkflowV2(input)).rejects.toThrow('continued');
    expect(activity.recoverIntegrationV2).toHaveBeenCalledTimes(100);
    expect(calls.options).toEqual([
      { startToCloseTimeout: '10 minutes', retry: { maximumAttempts: 1 } },
    ]);
    expect(calls.sleeps[0]).toBe(300_000);
    expect(calls.sleeps.slice(1).every((delay) => delay === 60_000)).toBe(true);
    expect(calls.continued).toHaveBeenCalledWith(input);
  });
  it('stops deleted integrations and keeps sweep progress across lost activities', async () => {
    activity.recoverIntegrationV2.mockResolvedValue({
      stopped: true,
      delayMs: 0,
    });
    await expect(
      refreshTokenWorkflowV2({ organizationId: 'org', integrationId: 'gone' })
    ).resolves.toBeUndefined();
    activity.refreshIntegrationBatchV2
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValue({ after: 'next' });
    await expect(refreshTokensSweepWorkflowV2('previous')).rejects.toThrow(
      'continued'
    );
    expect(activity.refreshIntegrationBatchV2.mock.calls.slice(0, 3)).toEqual([
      ['previous'],
      ['previous'],
      ['next'],
    ]);
    expect(calls.continued).toHaveBeenLastCalledWith('next');
  });
});
