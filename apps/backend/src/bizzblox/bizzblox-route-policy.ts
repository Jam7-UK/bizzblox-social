const INTERNAL_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const LOOPBACK_UPLOAD_LIMIT_BYTES = 52 * 1024 * 1024;
const MAX_URL_BYTES = 8 * 1024;
const OPAQUE_REF = '[A-Za-z0-9_-]{1,256}';
const PROVIDER_KEY = '[a-z0-9][a-z0-9_-]{0,63}';

type RouteRequest = Readonly<{
  method?: string;
  url?: string;
  contentLength?: string;
  remoteAddress?: string;
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

const LOOPBACK_ROUTES = Object.freeze([
  ['POST', /^\/public\/v1\/upload$/],
  ['POST', /^\/public\/v1\/posts\/validate$/],
  ['POST', /^\/public\/v1\/posts$/],
  ['GET', /^\/public\/v1\/posts$/],
  ['GET', new RegExp(`^/public/v1/posts/${OPAQUE_REF}$`)],
  ['PUT', new RegExp(`^/public/v1/posts/${OPAQUE_REF}/status$`)],
  ['DELETE', new RegExp(`^/public/v1/posts/${OPAQUE_REF}$`)],
  ['GET', new RegExp(`^/public/v1/analytics/post/${OPAQUE_REF}$`)],
  ['GET', new RegExp(`^/public/v1/integration-settings/${OPAQUE_REF}$`)],
  ['POST', new RegExp(`^/public/v1/integration-trigger/${OPAQUE_REF}$`)],
] as const);

function isLoopback(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

function routeMatches(
  routes: typeof ROUTES | typeof LOOPBACK_ROUTES,
  method: string,
  pathname: string
): boolean {
  return routes.some(
    ([allowedMethod, pattern]) =>
      allowedMethod === method && pattern.test(pathname)
  );
}

function bodyLimit(pathname: string): number {
  if (pathname === '/public/v1/upload') {
    return LOOPBACK_UPLOAD_LIMIT_BYTES;
  }
  return pathname.startsWith('/internal/bizzblox/v1/') ||
    pathname.startsWith('/public/v1/')
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

  const allowed =
    routeMatches(ROUTES, method, pathname) ||
    (isLoopback(request.remoteAddress) &&
      routeMatches(LOOPBACK_ROUTES, method, pathname));
  if (!allowed) {
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

  return { allowed: true };
}

type MiddlewareRequest = Readonly<{
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Readonly<Record<string, string | string[] | undefined>>;
  socket?: Readonly<{ remoteAddress?: string }>;
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
    remoteAddress: request.socket?.remoteAddress,
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
