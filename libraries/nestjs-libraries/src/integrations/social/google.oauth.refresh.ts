import { createHash } from 'node:crypto';
import { google } from 'googleapis';
import { ProviderRefreshFailure } from './social.integrations.interface';

export function googleRefreshFingerprint(
  clientId: string,
  clientSecret: string,
  scopes: string[]
) {
  if (!clientId || !clientSecret)
    throw new ProviderRefreshFailure('configuration');
  return createHash('sha256')
    .update(JSON.stringify([clientId, clientSecret, [...scopes].sort()]))
    .digest('hex');
}

/** Google documents reusing the original refresh token until it is invalidated. */
export async function refreshGoogleCredentials(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  configurationVerified: boolean
) {
  if (!clientId || !clientSecret || !refreshToken)
    throw new ProviderRefreshFailure('configuration');
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const { credentials } = await client.refreshAccessToken();
    return {
      accessToken: credentials.access_token!,
      refreshToken: credentials.refresh_token ?? refreshToken,
      expiresIn: Math.floor((credentials.expiry_date! - Date.now()) / 1000),
      id: '',
      name: '',
      username: '',
    };
  } catch (error) {
    // Do not inspect messages, profile errors, or generic HTTP 401 responses.
    const response = (
      error as {
        response?: {
          status?: number;
          data?: { error?: unknown };
          config?: { url?: string; method?: string };
        };
      }
    )?.response;
    const authoritative =
      response?.config?.url === 'https://oauth2.googleapis.com/token' &&
      response.config.method === 'POST';
    const code = authoritative ? response?.data?.error : undefined;
    if (
      code === 'invalid_client' ||
      code === 'unauthorized_client' ||
      code === 'invalid_scope'
    ) {
      throw new ProviderRefreshFailure('configuration');
    }
    if (code === 'invalid_grant' && response?.status === 400) {
      throw new ProviderRefreshFailure(
        configurationVerified ? 'consent' : 'configuration'
      );
    }
    throw new ProviderRefreshFailure('retry');
  }
}
