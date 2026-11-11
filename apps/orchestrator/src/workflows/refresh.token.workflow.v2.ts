import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { IntegrationsActivity } from '../activities/integrations.activity';

const { recoverIntegrationV2, refreshIntegrationBatchV2 } =
  proxyActivities<IntegrationsActivity>({
    startToCloseTimeout: '10 minutes',
    retry: { maximumAttempts: 1 },
  });

export async function refreshTokenWorkflowV2(input: {
  organizationId: string;
  integrationId: string;
}): Promise<void> {
  for (let cycle = 0; cycle < 100; cycle++) {
    let delay = 300_000;
    try {
      const next = await recoverIntegrationV2(input);
      if (next.stopped) return;
      delay = next.delayMs;
    } catch {
      /* A lost activity is recovered through its durable database lease. */
    }
    await sleep(Math.max(60_000, Math.min(21_600_000, delay)));
  }
  await continueAsNew<typeof refreshTokenWorkflowV2>(input);
}

/** Includes existing integrations and lost per-channel workflow starts. */
export async function refreshTokensSweepWorkflowV2(
  after?: string
): Promise<void> {
  for (let page = 0; page < 50; page++) {
    try {
      const next = await refreshIntegrationBatchV2(after);
      after = next.after;
    } catch {
      /* Retry the page after a durable delay; row claims fence exchange replay. */
    }
    await sleep(after ? 60_000 : 300_000);
  }
  await continueAsNew<typeof refreshTokensSweepWorkflowV2>(after);
}
