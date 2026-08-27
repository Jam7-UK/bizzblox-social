import { afterEach, describe, expect, it, vi } from 'vitest';

import { BizzbloxPostizClientFactory } from './bizzblox-postiz-client.factory';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BizzBLOX loopback Postiz client factory', () => {
  it('pins transport to loopback and loads only the exact organization API key', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      apiKey: 'bbx_internal_exact_organization_key',
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'integration-linkedin-1',
            identifier: 'linkedin',
            name: 'Jam 7',
            picture: null,
            disabled: false,
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetch);
    const factory = new BizzbloxPostizClientFactory({
      organization: { findUnique },
    } as never);

    const client = await factory.forOrganization('postiz-org-1');
    await expect(client.listIntegrations()).resolves.toHaveLength(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'postiz-org-1', deletedAt: null },
      select: { apiKey: true },
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3000/public/v1/integrations'),
      expect.objectContaining({
        method: 'GET',
        headers: {
          authorization: 'bbx_internal_exact_organization_key',
        },
      })
    );
  });

  it('fails closed when the managed organization API key is missing', async () => {
    const factory = new BizzbloxPostizClientFactory({
      organization: { findUnique: vi.fn().mockResolvedValue({ apiKey: null }) },
    } as never);

    await expect(factory.forOrganization('postiz-org-1')).rejects.toThrow(
      /unavailable/i
    );
  });
});
