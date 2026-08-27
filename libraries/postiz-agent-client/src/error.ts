import type { PostizCredential } from './types';

export type PostizAgentErrorCode = 'provider_rejected' | 'transport_error';

export class PostizAgentError extends Error {
  readonly code: PostizAgentErrorCode;
  readonly status: number | null;

  constructor(
    code: PostizAgentErrorCode,
    status: number | null,
    message: string
  ) {
    super(message.slice(0, 512));
    this.name = 'PostizAgentError';
    this.code = code;
    this.status = status;
  }
}

function bounded(value: string, credential: PostizCredential): string {
  return value
    .split(credential.apiKey)
    .join('[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 400);
}

export function providerRejectionMessage(
  body: unknown,
  credential: PostizCredential
): string {
  if (typeof body === 'string') return bounded(body, credential);
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    for (const key of ['message', 'msg', 'error'] as const) {
      const candidate = (body as Record<string, unknown>)[key];
      if (typeof candidate === 'string') return bounded(candidate, credential);
    }
  }
  return 'Provider rejected the request without a customer-safe error message.';
}
