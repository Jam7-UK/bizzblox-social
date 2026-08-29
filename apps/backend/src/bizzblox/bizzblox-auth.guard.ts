import { createHash } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

export const BIZZBLOX_CLAIM_VERIFIER = Symbol('BIZZBLOX_CLAIM_VERIFIER');
export const BIZZBLOX_REPLAY_STORE = Symbol('BIZZBLOX_REPLAY_STORE');
export const BIZZBLOX_TENANT_ACCESS = Symbol('BIZZBLOX_TENANT_ACCESS');
export const BIZZBLOX_AUTH_CONFIG = Symbol('BIZZBLOX_AUTH_CONFIG');

export type BizzbloxOperationClaim = Readonly<{
  audience: string;
  connectorRevision: number;
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  operation: string;
  requestDigest: string;
  tenantHandleHash: string;
}>;

export interface BizzbloxClaimVerifier {
  verify(compactClaim: string): Promise<BizzbloxOperationClaim>;
}

export interface BizzbloxReplayStore {
  consume(nonce: string, expiresAt: number): Promise<boolean>;
}

export interface BizzbloxTenantAccess {
  verifyCredential(
    tenantHandle: string,
    credential: string
  ): Promise<Readonly<{
    connectorRevision: number;
    credentialVersion: number;
    organizationId: string;
  }> | null>;
}

export type BizzbloxAuthConfig = Readonly<{
  accountId: string;
  audience: string;
  bridgePrincipalArn: string;
  clock: () => Date;
}>;

export type BizzbloxVerifiedRequest = {
  method: string;
  originalUrl: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: unknown;
  rawBody?: Buffer;
  bizzbloxIam?: Readonly<{ accountId: string; principalArn: string }>;
  bizzbloxAuth?: Readonly<{
    connectorRevision: number;
    credentialVersion: number | null;
    operation: string;
    organizationId: string | null;
    tenantHandle: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new UnauthorizedException();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function operationFor(method: string, path: string): string | null {
  if (method === 'GET' && path === '/internal/bizzblox/v1/providers') {
    return 'provider.list';
  }
  if (method === 'POST' && path === '/internal/bizzblox/v1/connections:begin') {
    return 'connection.begin';
  }
  if (
    method === 'POST' &&
    path === '/internal/bizzblox/v1/connections:select'
  ) {
    return 'connection.select';
  }
  if (
    method === 'POST' &&
    path === '/internal/bizzblox/v1/connections:outcome'
  ) {
    return 'connection.outcome.redeem';
  }
  if (
    method === 'POST' &&
    path === '/internal/bizzblox/v1/connections:disconnect'
  ) {
    return 'connection.disconnect';
  }
  if (
    method === 'POST' &&
    path === '/internal/bizzblox/v1/connections:reconnect'
  ) {
    return 'connection.reconnect';
  }
  if (method === 'POST' && path === '/internal/bizzblox/v1/tenants:ensure') {
    return 'tenant.ensure';
  }
  if (
    method === 'POST' &&
    /^\/internal\/bizzblox\/v1\/tenants\/tenant_synthetic_[A-Za-z0-9_-]{1,103}\/cleanup$/.test(
      path
    )
  ) {
    return 'tenant.cleanup';
  }
  if (
    method === 'GET' &&
    /^\/internal\/bizzblox\/v1\/tenants\/[^/?]+$/.test(path)
  ) {
    return 'tenant.read';
  }
  if (
    method === 'POST' &&
    path === '/internal/bizzblox/v1/publications:validate'
  ) {
    return 'publication.validate';
  }
  if (method === 'POST' && path === '/internal/bizzblox/v1/publications') {
    return 'publication.schedule';
  }
  if (method === 'POST' && path === '/internal/bizzblox/v1/media:upload') {
    return 'media.upload';
  }
  if (
    method === 'GET' &&
    /^\/internal\/bizzblox\/v1\/publications\/by-external\/[^/?]+\/analytics$/.test(
      path
    )
  ) {
    return 'publication.analytics.read';
  }
  if (
    method === 'GET' &&
    /^\/internal\/bizzblox\/v1\/publications\/by-external\/[^/?]+$/.test(path)
  ) {
    return 'publication.read';
  }
  if (
    method === 'POST' &&
    /^\/internal\/bizzblox\/v1\/publications\/by-external\/[^/?]+\/cancel$/.test(
      path
    )
  ) {
    return 'publication.cancel';
  }
  if (method === 'GET' && path === '/internal/bizzblox/v1/channels') {
    return 'channel.list';
  }
  if (
    method === 'GET' &&
    /^\/internal\/bizzblox\/v1\/channels\/[^/?]+\/contract$/.test(path)
  ) {
    return 'channel.contract.read';
  }
  if (
    method === 'POST' &&
    /^\/internal\/bizzblox\/v1\/channels\/[^/?]+\/tools\/[^/?]+$/.test(path)
  ) {
    return 'channel.helper.execute';
  }
  return null;
}

function requestBinding(request: BizzbloxVerifiedRequest): Readonly<{
  claim: string;
  credential: string | null;
  digest: string;
  operation: string;
  tenantHandle: string;
}> {
  const operationClaim = request.headers['x-bizzblox-operation-claim'];
  if (typeof operationClaim !== 'string') throw new UnauthorizedException();
  const tenantHandle = request.headers['x-bizzblox-tenant-handle'];
  if (typeof tenantHandle !== 'string' || tenantHandle.length < 16) {
    throw new UnauthorizedException();
  }
  if (
    isRecord(request.body) &&
    request.body.externalTenantHandle !== undefined &&
    request.body.externalTenantHandle !== tenantHandle
  ) {
    throw new UnauthorizedException();
  }
  const operation = operationFor(
    request.method.toUpperCase(),
    request.originalUrl
  );
  if (!operation) throw new UnauthorizedException();
  const candidateCredential = request.headers['x-bizzblox-tenant-credential'];
  const credential =
    typeof candidateCredential === 'string' && candidateCredential.length >= 16
      ? candidateCredential
      : null;
  if (operation !== 'tenant.ensure' && !credential) {
    throw new UnauthorizedException();
  }
  let digestBody: unknown = request.body ?? null;
  if (operation === 'media.upload') {
    const bytes = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.isBuffer(request.rawBody)
      ? request.rawBody
      : null;
    const externalMediaId = request.headers['x-bizzblox-media-external-id'];
    const checksumSha256 = request.headers['x-bizzblox-media-sha256'];
    const byteSize = request.headers['x-bizzblox-media-byte-size'];
    const contentType = request.headers['content-type'];
    if (
      !bytes ||
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_SOCIAL_MEDIA_UPLOAD_BYTES ||
      typeof externalMediaId !== 'string' ||
      !/^bbx_media_[a-f0-9]{48}$/.test(externalMediaId) ||
      typeof checksumSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(checksumSha256) ||
      typeof byteSize !== 'string' ||
      String(bytes.byteLength) !== byteSize ||
      typeof contentType !== 'string' ||
      contentType.length > 200 ||
      createHash('sha256').update(bytes).digest('hex') !== checksumSha256
    ) {
      throw new UnauthorizedException();
    }
    digestBody = {
      bodySha256: checksumSha256,
      metadata: {
        externalMediaId,
        checksumSha256,
        contentType,
        byteSize: bytes.byteLength,
      },
    };
  }
  if (operation === 'tenant.read' || operation === 'tenant.cleanup') {
    const pathParts = request.originalUrl.split('/');
    const encodedPathHandle =
      operation === 'tenant.cleanup' ? pathParts.at(-2) : pathParts.at(-1);
    if (
      !encodedPathHandle ||
      decodeURIComponent(encodedPathHandle) !== tenantHandle
    ) {
      throw new UnauthorizedException();
    }
  }
  return Object.freeze({
    claim: operationClaim,
    credential,
    digest: sha256(
      canonicalJson({
        ...(operation === 'media.upload'
          ? (digestBody as Record<string, unknown>)
          : { body: digestBody }),
        method: request.method.toUpperCase(),
        path: request.originalUrl,
      })
    ),
    operation,
    tenantHandle,
  });
}

@Injectable()
export class BizzbloxAuthGuard implements CanActivate {
  constructor(
    @Inject(BIZZBLOX_CLAIM_VERIFIER)
    private readonly claimVerifier: BizzbloxClaimVerifier,
    @Inject(BIZZBLOX_REPLAY_STORE)
    private readonly replayStore: BizzbloxReplayStore,
    @Inject(BIZZBLOX_TENANT_ACCESS)
    private readonly tenantAccess: BizzbloxTenantAccess,
    @Inject(BIZZBLOX_AUTH_CONFIG)
    private readonly config: BizzbloxAuthConfig
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const request = context
        .switchToHttp()
        .getRequest<BizzbloxVerifiedRequest>();
      const iam = request.bizzbloxIam;
      if (
        iam?.accountId !== this.config.accountId ||
        iam.principalArn !== this.config.bridgePrincipalArn
      ) {
        throw new UnauthorizedException();
      }

      const binding = requestBinding(request);
      const claim = await this.claimVerifier.verify(binding.claim);
      const now = Math.floor(this.config.clock().getTime() / 1000);
      if (
        claim.audience !== this.config.audience ||
        claim.expiresAt <= now ||
        claim.expiresAt > claim.issuedAt + 120 ||
        claim.issuedAt < now - 120 ||
        claim.issuedAt > now + 30 ||
        claim.operation !== binding.operation ||
        claim.requestDigest !== binding.digest ||
        claim.tenantHandleHash !== sha256(binding.tenantHandle) ||
        !Number.isInteger(claim.connectorRevision) ||
        claim.connectorRevision <= 0 ||
        !claim.nonce
      ) {
        throw new UnauthorizedException();
      }

      const tenant =
        claim.operation !== 'tenant.ensure' && binding.credential
          ? await this.tenantAccess.verifyCredential(
              binding.tenantHandle,
              binding.credential
            )
          : null;
      if (
        claim.operation !== 'tenant.ensure' &&
        (!tenant || tenant.connectorRevision !== claim.connectorRevision)
      ) {
        throw new UnauthorizedException();
      }
      if (!(await this.replayStore.consume(claim.nonce, claim.expiresAt))) {
        throw new UnauthorizedException();
      }

      request.bizzbloxAuth = Object.freeze({
        connectorRevision: claim.connectorRevision,
        credentialVersion: tenant?.credentialVersion ?? null,
        operation: claim.operation,
        organizationId: tenant?.organizationId ?? null,
        tenantHandle: binding.tenantHandle,
      });
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
const MAX_SOCIAL_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024;
