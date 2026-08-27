import { generateKeyPairSync } from 'node:crypto';

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

    await expect(verifier.verify(compact)).resolves.toMatchObject({
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
});
