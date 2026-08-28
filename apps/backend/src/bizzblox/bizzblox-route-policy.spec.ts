import { describe, expect, it, vi } from 'vitest';

import {
  bizzbloxRouteDecision,
  bizzbloxRoutePolicy,
} from './bizzblox-route-policy';

describe('BizzBLOX service route policy', () => {
  it.each([
    ['GET', '/health'],
    ['GET', '/oauth/bizzblox/callback/linkedin?state=opaque&code=opaque'],
    ['POST', '/internal/bizzblox/v1/tenants:ensure'],
    [
      'POST',
      '/internal/bizzblox/v1/tenants/tenant_synthetic_release_123/cleanup',
    ],
    ['GET', '/internal/bizzblox/v1/providers'],
    ['POST', '/internal/bizzblox/v1/connections:begin'],
    ['POST', '/internal/bizzblox/v1/connections:select'],
    ['POST', '/internal/bizzblox/v1/connections:disconnect'],
    ['GET', '/internal/bizzblox/v1/channels'],
    ['GET', '/internal/bizzblox/v1/channels/channel_ref/contract'],
    ['POST', '/internal/bizzblox/v1/channels/channel_ref/tools/helper_ref'],
    ['POST', '/internal/bizzblox/v1/publications:validate'],
    ['POST', '/internal/bizzblox/v1/publications'],
    ['GET', '/internal/bizzblox/v1/publications/by-external/publication_ref'],
    [
      'POST',
      '/internal/bizzblox/v1/publications/by-external/publication_ref/cancel',
    ],
    [
      'GET',
      '/internal/bizzblox/v1/publications/by-external/publication_ref/analytics',
    ],
  ])('allows the closed managed route %s %s', (method, url) => {
    expect(bizzbloxRouteDecision({ method, url })).toEqual({ allowed: true });
  });

  it.each([
    ['GET', '/'],
    ['GET', '/login'],
    ['POST', '/auth/register'],
    ['GET', '/dashboard'],
    ['GET', '/billing'],
    ['GET', '/marketplace'],
    ['POST', '/copilot/generate'],
    ['GET', '/api/posts'],
    ['POST', '/internal/bizzblox/v1/unknown'],
    ['POST', '/internal/bizzblox/v1/tenants/tenant_customer_123/cleanup'],
    ['DELETE', '/internal/bizzblox/v1/publications/by-external/post'],
    ['GET', '/oauth/bizzblox/callback/../../dashboard'],
  ])('denies the non-product route %s %s', (method, url) => {
    expect(bizzbloxRouteDecision({ method, url })).toEqual({
      allowed: false,
      status: 404,
    });
  });

  it('rejects oversized or malformed request lengths without reflecting input', () => {
    expect(
      bizzbloxRouteDecision({
        method: 'POST',
        url: '/internal/bizzblox/v1/publications',
        contentLength: String(2 * 1024 * 1024 + 1),
      })
    ).toEqual({ allowed: false, status: 413 });
    expect(
      bizzbloxRouteDecision({
        method: 'POST',
        url: '/internal/bizzblox/v1/publications',
        contentLength: 'credential=secret',
      })
    ).toEqual({ allowed: false, status: 400 });
  });

  it.each([
    ['POST', '/public/v1/upload'],
    ['POST', '/public/v1/posts/validate'],
    ['POST', '/public/v1/posts'],
    ['GET', '/public/v1/posts'],
    ['GET', '/public/v1/posts/post_ref'],
    ['PUT', '/public/v1/posts/post_ref/status'],
    ['DELETE', '/public/v1/posts/post_ref'],
    ['GET', '/public/v1/analytics/post/post_ref'],
    ['GET', '/public/v1/integration-settings/channel_ref'],
    ['POST', '/public/v1/integration-trigger/channel_ref'],
  ])('allows only the exact loopback provider route %s %s', (method, url) => {
    expect(
      bizzbloxRouteDecision({
        method,
        url,
        remoteAddress: '::ffff:127.0.0.1',
      })
    ).toEqual({ allowed: true });
    expect(
      bizzbloxRouteDecision({
        method,
        url,
        remoteAddress: '10.30.1.42',
        contentLength: '50000000',
      })
    ).toEqual({ allowed: false, status: 404 });
  });

  it('returns one bounded generic denial from middleware', () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    bizzbloxRoutePolicy(
      {
        method: 'GET',
        originalUrl: '/dashboard?token=secret',
        headers: {},
      },
      { status, json },
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Not found.' });
  });
});
