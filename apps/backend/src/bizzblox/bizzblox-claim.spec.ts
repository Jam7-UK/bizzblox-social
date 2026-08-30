import { createHash, generateKeyPairSync } from 'node:crypto';

import { sign } from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { BizzbloxJwtClaimVerifier } from './bizzblox-claim';

describe('BizzBLOX Integration V3 claims', () => {
  it('verifies an exact RS256 audience/issuer and projects only the governed claims', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const compact = sign(
      {
        connectorRevision: 7,
        operation: 'tenant.ensure',
        requestDigest:
          '1ec0e26b3e5a3ea99987c8faf0b95b54324eb5f91d82eda29b1db74d280c4a30',
        tenantHandleHash:
          '8871aadbec53ee07ee9468cf7073562c5f58ad817a338063a2d1232f495ea003',
      },
      privateKey,
      {
        algorithm: 'RS256',
        audience: 'bizzblox-social',
        expiresIn: 300,
        issuer: 'https://amp.bizzblox.com/integration-v3',
        jwtid: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
        noTimestamp: false,
      }
    );
    const verifier = new BizzbloxJwtClaimVerifier({
      audience: 'bizzblox-social',
      clock: () => new Date(),
      issuer: 'https://amp.bizzblox.com/integration-v3',
      publicKey,
    });

    await expect(
      verifier.verify(compact, 'tenant_opaque_123')
    ).resolves.toMatchObject({
      audience: 'bizzblox-social',
      connectorRevision: 7,
      nonce: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      operation: 'tenant.ensure',
      requestDigest:
        '1ec0e26b3e5a3ea99987c8faf0b95b54324eb5f91d82eda29b1db74d280c4a30',
      tenantHandleHash:
        '8871aadbec53ee07ee9468cf7073562c5f58ad817a338063a2d1232f495ea003',
    });
  });

  it('accepts the smoke key only for a synthetic tenant', async () => {
    const production = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const smoke = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const syntheticTenant = 'tenant_synthetic_release_33320511348_1';
    const compact = sign(
      {
        connectorRevision: 1,
        operation: 'tenant.ensure',
        requestDigest:
          '1ec0e26b3e5a3ea99987c8faf0b95b54324eb5f91d82eda29b1db74d280c4a30',
        tenantHandleHash: createHash('sha256')
          .update(syntheticTenant)
          .digest('hex'),
      },
      smoke.privateKey,
      {
        algorithm: 'RS256',
        audience: 'bizzblox-social',
        expiresIn: 90,
        issuer: 'https://mvp.bizzblox.com/integrations/social',
        jwtid: 'nonce_01J6DCG5GFV2X9PPYF4D8KPWYB',
      }
    );
    const verifier = new BizzbloxJwtClaimVerifier({
      audience: 'bizzblox-social',
      clock: () => new Date(),
      issuer: 'https://mvp.bizzblox.com/integrations/social',
      publicKey: production.publicKey,
      synthetic: {
        publicKey: smoke.publicKey,
        tenantPattern: /^tenant_synthetic_[A-Za-z0-9_-]{1,103}$/,
      },
    });

    await expect(
      verifier.verify(compact, syntheticTenant)
    ).resolves.toMatchObject({
      connectorRevision: 1,
      operation: 'tenant.ensure',
    });
    await expect(
      verifier.verify(compact, 'tenant_customer_01J6DCG5GFV2X9PPYF4D8KPWYB')
    ).rejects.toThrow('Invalid BizzBLOX operation claim.');
  });

  it('rejects one RSA key supplied in different PEM encodings', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const spki = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const pkcs1 = publicKey.export({ format: 'pem', type: 'pkcs1' }).toString();

    expect(
      () =>
        new BizzbloxJwtClaimVerifier({
          audience: 'bizzblox-social',
          clock: () => new Date(),
          issuer: 'https://mvp.bizzblox.com/integrations/social',
          publicKey: spki,
          synthetic: {
            publicKey: pkcs1,
            tenantPattern: /^tenant_synthetic_[A-Za-z0-9_-]{1,103}$/,
          },
        })
    ).toThrow('Production and synthetic operation claim keys must differ.');
  });
});
