import { describe, expect, it, vi } from 'vitest';

import { BizzbloxIamContextMiddleware } from './bizzblox-iam.middleware';

describe('BizzBLOX API Gateway IAM context middleware', () => {
  it('projects only the bridge headers injected by the private API integration', () => {
    const request = {
      headers: {
        'x-bizzblox-iam-account': '111111111111',
        'x-bizzblox-iam-principal':
          'arn:aws:iam::111111111111:role/BizzbloxSocialBridge',
      },
    };
    const next = vi.fn();

    new BizzbloxIamContextMiddleware().use(request, {}, next);

    expect(request).toMatchObject({
      bizzbloxIam: {
        accountId: '111111111111',
        principalArn: 'arn:aws:iam::111111111111:role/BizzbloxSocialBridge',
      },
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
