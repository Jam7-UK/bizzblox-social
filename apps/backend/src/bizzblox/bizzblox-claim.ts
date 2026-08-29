import type { KeyObject } from 'node:crypto';

import { verify, type JwtPayload } from 'jsonwebtoken';

import type {
  BizzbloxClaimVerifier,
  BizzbloxOperationClaim,
} from './bizzblox-auth.guard';

export type BizzbloxJwtClaimVerifierConfig = Readonly<{
  audience: string;
  clock: () => Date;
  issuer: string;
  publicKey: KeyObject | string;
}>;

function isJwtPayload(value: string | JwtPayload): value is JwtPayload {
  return typeof value === 'object' && value !== null;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export class BizzbloxJwtClaimVerifier implements BizzbloxClaimVerifier {
  constructor(private readonly config: BizzbloxJwtClaimVerifierConfig) {}

  async verify(compactClaim: string): Promise<BizzbloxOperationClaim> {
    try {
      if (
        compactClaim.length > 16_384 ||
        compactClaim.split('.').length !== 3
      ) {
        throw new Error('invalid compact claim');
      }
      const payload = verify(compactClaim, this.config.publicKey, {
        algorithms: ['RS256'],
        audience: this.config.audience,
        clockTimestamp: Math.floor(this.config.clock().getTime() / 1000),
        issuer: this.config.issuer,
      });
      if (
        !isJwtPayload(payload) ||
        typeof payload.connectorRevision !== 'number' ||
        !Number.isInteger(payload.connectorRevision) ||
        payload.connectorRevision <= 0 ||
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        typeof payload.jti !== 'string' ||
        !/^nonce_[A-Za-z0-9_-]{16,120}$/.test(payload.jti) ||
        typeof payload.operation !== 'string' ||
        !sha256Digest(payload.requestDigest) ||
        !sha256Digest(payload.tenantHandleHash)
      ) {
        throw new Error('invalid claim payload');
      }
      return Object.freeze({
        audience: this.config.audience,
        connectorRevision: payload.connectorRevision,
        expiresAt: payload.exp,
        issuedAt: payload.iat,
        nonce: payload.jti,
        operation: payload.operation,
        requestDigest: payload.requestDigest,
        tenantHandleHash: payload.tenantHandleHash,
      });
    } catch {
      throw new Error('Invalid BizzBLOX operation claim.');
    }
  }
}
