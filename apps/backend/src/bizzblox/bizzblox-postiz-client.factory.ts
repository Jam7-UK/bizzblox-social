import { Injectable } from '@nestjs/common';

import {
  createPostizAgentClient,
  type PostizAgentTransport,
  type PostizMultipartBody,
  type PostizTransportRequest,
} from '@bizzblox/postiz-agent-client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

import type { BizzbloxPostizClientFactory as BizzbloxPostizClientFactoryContract } from './bizzblox-publications.service';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function internalBaseUrl(): string {
  const port = process.env.PORT?.trim() || '3000';
  if (!/^[0-9]{2,5}$/.test(port) || Number(port) > 65_535) {
    throw new Error('Invalid BizzBLOX internal Postiz port.');
  }
  return `http://127.0.0.1:${port}`;
}

function multipartBody(input: PostizMultipartBody): FormData {
  const body = new FormData();
  for (const part of input.parts) {
    body.append(
      part.field,
      new Blob([part.bytes], { type: part.contentType }),
      part.filename
    );
  }
  return body;
}

function isMultipartBody(value: unknown): value is PostizMultipartBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'multipart' &&
    'parts' in value &&
    Array.isArray(value.parts)
  );
}

class LoopbackPostizTransport implements PostizAgentTransport {
  async request(input: PostizTransportRequest) {
    const configured = new URL(internalBaseUrl());
    const credentialUrl = new URL(input.credential.apiUrl);
    if (credentialUrl.origin !== configured.origin) {
      throw new Error(
        'Postiz client origin is not the fixed loopback service.'
      );
    }
    const url = new URL(input.path, configured);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const multipart = isMultipartBody(input.body);
    const response = await fetch(url, {
      method: input.method,
      headers: {
        authorization: input.credential.apiKey,
        ...(input.body !== undefined && !multipart
          ? { 'content-type': 'application/json' }
          : {}),
      },
      ...(input.body !== undefined
        ? {
            body: multipart
              ? multipartBody(input.body as PostizMultipartBody)
              : JSON.stringify(input.body),
          }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('Postiz response exceeded the service bound.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('Postiz response exceeded the service bound.');
    }
    const text = new TextDecoder().decode(bytes);
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 500) };
      }
    }
    return Object.freeze({ status: response.status, body });
  }
}

@Injectable()
export class BizzbloxPostizClientFactory
  implements BizzbloxPostizClientFactoryContract
{
  private readonly transport = new LoopbackPostizTransport();

  constructor(private readonly database: PrismaService) {}

  async forOrganization(organizationId: string) {
    const organization = await this.database.organization.findUnique({
      where: { id: organizationId, deletedAt: null },
      select: { apiKey: true },
    });
    if (!organization?.apiKey) {
      throw new Error('Managed Postiz organization credential is unavailable.');
    }
    const credential = Object.freeze({
      apiKey: organization.apiKey,
      apiUrl: internalBaseUrl(),
    });
    return createPostizAgentClient({
      transport: this.transport,
      credential: async () => credential,
      clock: () => new Date(),
    });
  }
}
