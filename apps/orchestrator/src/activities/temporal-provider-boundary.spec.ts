import { describe, expect, it } from 'vitest';

import {
  integrationForTemporalHistory,
  postForTemporalHistory,
  refreshForTemporalHistory,
} from './temporal-provider-boundary';

describe('Temporal provider credential boundary', () => {
  it('removes stored and refreshed provider credentials from workflow history values', () => {
    const integration = {
      id: 'integration_current',
      organizationId: 'organization_123',
      providerIdentifier: 'linkedin',
      refreshToken: 'sealed-refresh-envelope',
      token: 'sealed-access-envelope',
    };

    const safeIntegration = integrationForTemporalHistory(integration);
    const safePost = postForTemporalHistory({
      id: 'post_123',
      integration,
    });
    const safeRefresh = refreshForTemporalHistory({
      accessToken: 'new-access-secret',
      refreshToken: 'new-refresh-secret',
      expiresIn: 3600,
    });
    const serialized = JSON.stringify({
      safeIntegration,
      safePost,
      safeRefresh,
    });

    expect(safeIntegration).toMatchObject({ token: '', refreshToken: null });
    expect(safePost.integration).toMatchObject({
      token: '',
      refreshToken: null,
    });
    expect(safeRefresh).toEqual({
      accessToken: 'managed-in-activity',
      refreshToken: '',
      expiresIn: 3600,
    });
    expect(serialized).not.toContain('sealed-access-envelope');
    expect(serialized).not.toContain('sealed-refresh-envelope');
    expect(serialized).not.toContain('new-access-secret');
    expect(serialized).not.toContain('new-refresh-secret');
  });
});
