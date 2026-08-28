const INTERNAL_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_URL_BYTES = 8 * 1024;
const OPAQUE_REF = '[A-Za-z0-9_-]{1,256}';
const PROVIDER_KEY = '[a-z0-9][a-z0-9_-]{0,63}';

type RouteRequest = Readonly<{
  method?: string;
  url?: string;
  contentLength?: string;
}>;

export type BizzbloxRouteDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; status: 400 | 404 | 413 }>;

const ROUTES = Object.freeze([
  ['GET', /^\/health$/],
  ['GET', new RegExp(`^/oauth/bizzblox/callback/${PROVIDER_KEY}$`)],
  ['POST', /^\/internal\/bizzblox\/v1\/tenants:ensure$/],
  ['GET', new RegExp(`^/internal/bizzblox/v1/tenants/${OPAQUE_REF}$`)],
  ['GET', /^\/internal\/bizzblox\/v1\/providers$/],
  ['POST', /^\/internal\/bizzblox\/v1\/connections:begin$/],
  ['POST', /^\/internal\/bizzblox\/v1\/connections:select$/],
  ['GET', /^\/internal\/bizzblox\/v1\/channels$/],
  [
    'GET',
    new RegExp(`^/internal/bizzblox/v1/channels/${OPAQUE_REF}/contract$`),
  ],
  [
    'POST',
    new RegExp(
      `^/internal/bizzblox/v1/channels/${OPAQUE_REF}/tools/${OPAQUE_REF}$`
    ),
  ],
  ['POST', /^\/internal\/bizzblox\/v1\/publications:validate$/],
  ['POST', /^\/internal\/bizzblox\/v1\/publications$/],
  [
    'GET',
    new RegExp(
      `^/internal/bizzblox/v1/publications/by-external/${OPAQUE_REF}$`
    ),
  ],
  [
    'POST',
    new RegExp(
      `^/internal/bizzblox/v1/publications/by-external/${OPAQUE_REF}/cancel$`
    ),
  ],
  [
    'GET',
    new RegExp(
      `^/internal/bizzblox/v1/publications/by-external/${OPAQUE_REF}/analytics$`
    ),
  ],
] as const);

function bodyLimit(pathname: string): number {
  return pathname.startsWith('/internal/bizzblox/v1/')
    ? INTERNAL_BODY_LIMIT_BYTES
    : 0;
}

export function bizzbloxRouteDecision(
  request: RouteRequest
): BizzbloxRouteDecision {
  const method = request.method?.toUpperCase() ?? '';
  const url = request.url ?? '';
  if (!method || !url || Buffer.byteLength(url, 'utf8') > MAX_URL_BYTES) {
    return { allowed: false, status: 400 };
  }
  const pathname = url.split('?', 1)[0] ?? '';
  if (
    !pathname.startsWith('/') ||
    pathname.includes('%') ||
    pathname.includes('\\')
  ) {
    return { allowed: false, status: 404 };
  }

  const contentLength = request.contentLength;
  if (contentLength !== undefined) {
    if (!/^(0|[1-9][0-9]{0,9})$/.test(contentLength)) {
      return { allowed: false, status: 400 };
    }
    if (Number(contentLength) > bodyLimit(pathname)) {
      return { allowed: false, status: 413 };
    }
  }

  return ROUTES.some(
    ([allowedMethod, pattern]) =>
      allowedMethod === method && pattern.test(pathname)
  )
    ? { allowed: true }
    : { allowed: false, status: 404 };
}

type MiddlewareRequest = Readonly<{
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Readonly<Record<string, string | string[] | undefined>>;
}>;

type MiddlewareResponse = Readonly<{
  status: (code: number) => MiddlewareResponse;
  json: (body: Readonly<{ error: string }>) => unknown;
}>;

export function bizzbloxRoutePolicy(
  request: MiddlewareRequest,
  response: MiddlewareResponse,
  next: () => void
): void {
  const rawContentLength = request.headers?.['content-length'];
  const decision = bizzbloxRouteDecision({
    method: request.method,
    url: request.originalUrl ?? request.url,
    contentLength:
      typeof rawContentLength === 'string' ? rawContentLength : undefined,
  });
  if (!('status' in decision)) {
    next();
    return;
  }
  response.status(decision.status).json({
    error:
      decision.status === 413
        ? 'Request too large.'
        : decision.status === 400
        ? 'Bad request.'
        : 'Not found.',
  });
}
