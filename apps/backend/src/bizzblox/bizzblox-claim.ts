import { createPublicKey, type KeyObject } from 'node:crypto';

import { decode, verify, type JwtPayload } from 'jsonwebtoken';

import type {
  BizzbloxClaimVerifier,
  BizzbloxOperationClaim,
} from './bizzblox-auth.guard';
import {
  BIZZBLOX_SOCIAL_ENVIRONMENTS,
  type BizzbloxSocialEnvironment,
  socialEnvironmentFromTenantHandle,
} from './bizzblox-environment';

export type BizzbloxJwtClaimVerifierConfig = Readonly<{
  audience: string;
  clock: () => Date;
  environments: Readonly<
    Record<
      BizzbloxSocialEnvironment,
      Readonly<{ issuer: string; publicKey: KeyObject | string }>
    >
  >;
  synthetic?: Readonly<{
    issuer: string;
    publicKey: KeyObject | string;
    tenantPattern: RegExp;
  }>;
}>;

function isJwtPayload(value: string | JwtPayload): value is JwtPayload {
  return typeof value === 'object' && value !== null;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function canonicalRsaPublicKey(value: KeyObject | string): Buffer {
  const key =
    typeof value !== 'string' && value.type === 'public'
      ? value
      : createPublicKey(value);
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error('Invalid BizzBLOX operation claim public key.');
  }
  return key.export({ format: 'der', type: 'spki' });
}

export class BizzbloxJwtClaimVerifier implements BizzbloxClaimVerifier {
  constructor(private readonly config: BizzbloxJwtClaimVerifierConfig) {
    const keys = BIZZBLOX_SOCIAL_ENVIRONMENTS.map((environment) => ({
      environment,
      value: canonicalRsaPublicKey(config.environments[environment].publicKey),
    }));
    for (const [index, key] of keys.entries()) {
      if (
        keys
          .slice(index + 1)
          .some((candidate) => key.value.equals(candidate.value))
      ) {
        throw new Error('Social environment operation claim keys must differ.');
      }
    }
    if (config.synthetic) {
      const synthetic = canonicalRsaPublicKey(config.synthetic.publicKey);
      if (keys.some((key) => key.value.equals(synthetic))) {
        throw new Error(
          'Social environment and synthetic operation claim keys must differ.'
        );
      }
    }
  }

  private verifyWithKey(
    compactClaim: string,
    input: Readonly<{
      environment: BizzbloxSocialEnvironment;
      issuer: string;
      publicKey: KeyObject | string;
      requireEnvironmentClaim: boolean;
    }>
  ): BizzbloxOperationClaim {
    if (compactClaim.length > 16_384 || compactClaim.split('.').length !== 3) {
      throw new Error('invalid compact claim');
    }
    const payload = verify(compactClaim, input.publicKey, {
      algorithms: ['RS256'],
      audience: this.config.audience,
      clockTimestamp: Math.floor(this.config.clock().getTime() / 1000),
      issuer: input.issuer,
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
      !sha256Digest(payload.tenantHandleHash) ||
      (input.requireEnvironmentClaim &&
        payload.environment !== input.environment)
    ) {
      throw new Error('invalid claim payload');
    }
    return Object.freeze({
      audience: this.config.audience,
      connectorRevision: payload.connectorRevision,
      environment: input.environment,
      expiresAt: payload.exp,
      issuedAt: payload.iat,
      nonce: payload.jti,
      operation: payload.operation,
      requestDigest: payload.requestDigest,
      tenantHandleHash: payload.tenantHandleHash,
    });
  }

  async verify(
    compactClaim: string,
    tenantHandle: string
  ): Promise<BizzbloxOperationClaim> {
    const environment = socialEnvironmentFromTenantHandle(tenantHandle);
    if (environment) {
      try {
        const decoded = decode(compactClaim, { complete: true });
        if (!decoded || decoded.header.kid !== environment) {
          throw new Error('invalid environment key id');
        }
        const configured = this.config.environments[environment];
        return this.verifyWithKey(compactClaim, {
          environment,
          issuer: configured.issuer,
          publicKey: configured.publicKey,
          requireEnvironmentClaim: true,
        });
      } catch {
        throw new Error('Invalid BizzBLOX operation claim.');
      }
    }
    const synthetic = this.config.synthetic;
    if (!synthetic?.tenantPattern.test(tenantHandle)) {
      throw new Error('Invalid BizzBLOX operation claim.');
    }
    try {
      return this.verifyWithKey(compactClaim, {
        environment: 'prod',
        issuer: synthetic.issuer,
        publicKey: synthetic.publicKey,
        requireEnvironmentClaim: false,
      });
    } catch {
      throw new Error('Invalid BizzBLOX operation claim.');
    }
  }
}
