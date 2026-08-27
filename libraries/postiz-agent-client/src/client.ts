import type {
  IntegrationSummary,
  JsonValue,
  PostizAgentClient,
  PostizAgentClientDependencies,
  ProviderContract,
  ProviderTool,
  UploadedMedia,
  PostizTransportRequest,
} from './types';
import { PostizAgentError, providerRejectionMessage } from './error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integrationSummary(value: unknown): IntegrationSummary {
  const picture = isRecord(value) ? value.picture : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.identifier !== 'string' ||
    typeof value.name !== 'string' ||
    !(typeof picture === 'string' || picture === null) ||
    typeof value.disabled !== 'boolean'
  ) {
    throw new Error('Postiz returned an invalid integration summary.');
  }
  return Object.freeze({
    id: value.id,
    identifier: value.identifier,
    name: value.name,
    picture,
    disabled: value.disabled,
  });
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value))
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function providerTool(value: unknown): ProviderTool {
  if (
    !isRecord(value) ||
    typeof value.methodName !== 'string' ||
    !isJsonValue(value)
  ) {
    throw new Error('Postiz returned an invalid provider tool.');
  }
  return Object.freeze({ ...value }) as ProviderTool;
}

function providerContract(value: unknown): ProviderContract {
  if (!isRecord(value) || !isRecord(value.output)) {
    throw new Error('Postiz returned an invalid provider contract.');
  }
  const { maxLength, rules, settings, tools } = value.output;
  if (
    typeof rules !== 'string' ||
    typeof maxLength !== 'number' ||
    !isJsonValue(settings) ||
    !Array.isArray(tools)
  ) {
    throw new Error('Postiz returned an invalid provider contract.');
  }
  return Object.freeze({
    rules,
    maxLength,
    settings,
    tools: Object.freeze(tools.map(providerTool)),
  });
}

function pathSegment(value: string): string {
  if (!value) throw new Error('Postiz identifiers must not be empty.');
  return encodeURIComponent(value);
}

function jsonObject(
  value: unknown,
  description: string
): Readonly<Record<string, JsonValue>> {
  if (!isRecord(value) || !isJsonValue(value)) {
    throw new Error(`Postiz returned an invalid ${description} response.`);
  }
  return Object.freeze({ ...value });
}

function addUtcDays(value: Date, days: number): string {
  const result = new Date(value.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString();
}

function uploadedMedia(value: unknown): UploadedMedia {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.name !== 'string'
  ) {
    throw new Error('Postiz returned an invalid upload response.');
  }
  return Object.freeze({ id: value.id, path: value.path, name: value.name });
}

export function createPostizAgentClient(
  dependencies: PostizAgentClientDependencies
): PostizAgentClient {
  const request = async (
    input: Omit<PostizTransportRequest, 'credential'>
  ): Promise<unknown> => {
    const credential = await dependencies.credential();
    if (!credential.apiKey || !credential.apiUrl) {
      throw new PostizAgentError(
        'transport_error',
        null,
        'Postiz credentials are unavailable.'
      );
    }
    let response;
    try {
      response = await dependencies.transport.request({ ...input, credential });
    } catch {
      throw new PostizAgentError(
        'transport_error',
        null,
        'Postiz transport request failed.'
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PostizAgentError(
        'provider_rejected',
        response.status,
        `Postiz rejected request (${
          response.status
        }): ${providerRejectionMessage(response.body, credential)}`
      );
    }
    return response.body;
  };
  const client: PostizAgentClient = {
    async listIntegrations() {
      const body = await request({
        method: 'GET',
        path: '/public/v1/integrations',
      });
      if (!Array.isArray(body)) {
        throw new Error('Postiz returned an invalid integrations response.');
      }
      return Object.freeze(body.map(integrationSummary));
    },
    async getIntegrationSettings(integrationId) {
      const body = await request({
        method: 'GET',
        path: `/public/v1/integration-settings/${pathSegment(integrationId)}`,
      });
      return providerContract(body);
    },
    async triggerIntegrationTool(input) {
      const body = await request({
        body: { methodName: input.methodName, data: input.data },
        method: 'POST',
        path: `/public/v1/integration-trigger/${pathSegment(
          input.integrationId
        )}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!isJsonValue(body)) {
        throw new Error('Postiz returned an invalid provider tool response.');
      }
      return body;
    },
    async upload(input) {
      if (
        !input.filename ||
        !input.contentType ||
        input.bytes.byteLength === 0
      ) {
        throw new Error(
          'Postiz uploads require non-empty bytes, filename, and content type.'
        );
      }
      const body = await request({
        body: {
          kind: 'multipart',
          parts: [
            {
              bytes: input.bytes,
              contentType: input.contentType,
              field: 'file',
              filename: input.filename,
            },
          ],
        },
        method: 'POST',
        path: '/public/v1/upload',
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return uploadedMedia(body);
    },
    async createPost(input) {
      const { signal, ...post } = input;
      const body = await request({
        body: { ...post, creationMethod: 'API' },
        method: 'POST',
        path: '/public/v1/posts',
        ...(signal ? { signal } : {}),
      });
      return jsonObject(body, 'create-post');
    },
    async listPosts(input) {
      const now = dependencies.clock();
      const body = await request({
        method: 'GET',
        path: '/public/v1/posts',
        query: {
          startDate: input.startDate ?? addUtcDays(now, -30),
          endDate: input.endDate ?? addUtcDays(now, 30),
          ...(input.customer ? { customer: input.customer } : {}),
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!isRecord(body) || !Array.isArray(body.posts)) {
        throw new Error('Postiz returned an invalid posts response.');
      }
      return Object.freeze(
        body.posts.map((post) => jsonObject(post, 'post-summary'))
      );
    },
    async readPost(input) {
      const body = await request({
        method: 'GET',
        path: `/public/v1/posts/${pathSegment(input.id)}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return jsonObject(body, 'post');
    },
    async changePostStatus(input) {
      const body = await request({
        body: { status: input.status },
        method: 'PUT',
        path: `/public/v1/posts/${pathSegment(input.id)}/status`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return jsonObject(body, 'post-status');
    },
    async deletePost(input) {
      const body = await request({
        method: 'DELETE',
        path: `/public/v1/posts/${pathSegment(input.id)}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return jsonObject(body, 'delete-post');
    },
    async getPostAnalytics(input) {
      if (!Number.isInteger(input.days) || input.days <= 0) {
        throw new Error('Postiz analytics days must be a positive integer.');
      }
      const body = await request({
        method: 'GET',
        path: `/public/v1/analytics/post/${pathSegment(input.postId)}`,
        query: { date: String(input.days) },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return jsonObject(body, 'post-analytics');
    },
  };
  return Object.freeze(client);
}
