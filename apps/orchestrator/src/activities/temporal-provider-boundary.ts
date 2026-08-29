type IntegrationCredentials = Readonly<{
  refreshToken?: string | null;
  token: string;
}>;

export type TemporalSafeIntegration<T extends IntegrationCredentials> = Omit<
  T,
  'refreshToken' | 'token'
> &
  Readonly<{
    refreshToken: null;
    token: '';
  }>;

export function integrationForTemporalHistory<T extends IntegrationCredentials>(
  integration: T
): TemporalSafeIntegration<T> {
  return { ...integration, refreshToken: null, token: '' };
}

export function postForTemporalHistory<
  TIntegration extends IntegrationCredentials,
  TPost extends Readonly<{ integration: TIntegration }>
>(
  post: TPost
): Omit<TPost, 'integration'> &
  Readonly<{ integration: TemporalSafeIntegration<TIntegration> }> {
  return {
    ...post,
    integration: integrationForTemporalHistory(post.integration),
  };
}

type ProviderRefresh = Readonly<{
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
}>;

export function refreshForTemporalHistory<T extends ProviderRefresh>(
  refresh: T
): Omit<T, 'accessToken' | 'refreshToken'> &
  Readonly<{ accessToken: 'managed-in-activity'; refreshToken: '' }> {
  return {
    ...refresh,
    accessToken: 'managed-in-activity',
    refreshToken: '',
  };
}
