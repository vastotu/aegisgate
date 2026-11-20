import { AegisGateClient, toAegisHeaders, type AegisGateConfig } from './client';

/** Pass a config to create a client, or share one existing client across adapters. */
export type AegisMiddlewareConfig = AegisGateConfig | AegisGateClient;

const toClient = (config: AegisMiddlewareConfig): AegisGateClient =>
  config instanceof AegisGateClient ? config : new AegisGateClient(config);

const pathOf = (url: string): string => url.split('?')[0] || '/';

// ---------------------------------------------------------------------------
// Express / Connect
// ---------------------------------------------------------------------------

export interface ExpressLikeRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  /** Respects Express `trust proxy`. */
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface ExpressLikeResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

export type ExpressLikeNext = (err?: unknown) => void;

export function createExpressMiddleware(config: AegisMiddlewareConfig) {
  const client = toClient(config);
  return function aegisGateMiddleware(req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressLikeNext): void {
    client
      .check({
        route: pathOf(req.originalUrl ?? req.url ?? '/'),
        method: req.method ?? 'GET',
        clientIp: req.ip ?? req.socket?.remoteAddress ?? '0.0.0.0',
      })
      .then((result) => {
        for (const [name, value] of Object.entries(toAegisHeaders(result))) res.setHeader(name, value);
        if (!result.allowed) {
          res.status(result.statusCode).json({ error: 'Protected by AegisGate', ...result });
          return;
        }
        next();
      }, next);
  };
}

// ---------------------------------------------------------------------------
// Fastify
// ---------------------------------------------------------------------------

export interface FastifyLikeRequest {
  method: string;
  url: string;
  ip: string;
}

export interface FastifyLikeReply {
  header(name: string, value: string): unknown;
  code(statusCode: number): { send(payload?: unknown): unknown };
}

/** Usage: `app.addHook('onRequest', createFastifyHook({ apiKey }))`. */
export function createFastifyHook(config: AegisMiddlewareConfig) {
  const client = toClient(config);
  return async function aegisGateOnRequest(request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<unknown> {
    const result = await client.check({ route: pathOf(request.url), method: request.method, clientIp: request.ip });
    for (const [name, value] of Object.entries(toAegisHeaders(result))) reply.header(name, value);
    if (!result.allowed) {
      // Returning the reply tells Fastify the request has been answered.
      return reply.code(result.statusCode).send({ error: 'Protected by AegisGate', ...result });
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Next.js App Router (and any Fetch API handler)
// ---------------------------------------------------------------------------

/** First hop of x-forwarded-for / x-real-ip. Only trustworthy behind a proxy that sets these (e.g. Vercel). */
function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headers.get('x-real-ip') ?? '0.0.0.0';
}

export function withAegisGateNextHandler<Args extends unknown[]>(
  config: AegisMiddlewareConfig,
  handler: (req: Request, ...args: Args) => Response | Promise<Response>,
): (req: Request, ...args: Args) => Promise<Response> {
  const client = toClient(config);
  return async (req: Request, ...args: Args): Promise<Response> => {
    const result = await client.check({
      route: new URL(req.url).pathname,
      method: req.method,
      clientIp: clientIpFromHeaders(req.headers),
    });
    const aegisHeaders = toAegisHeaders(result);

    if (!result.allowed) {
      return new Response(JSON.stringify({ error: 'Protected by AegisGate', ...result }), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json', ...aegisHeaders },
      });
    }

    const response = await handler(req, ...args);
    // Copy into a fresh Response: handler responses may have immutable headers.
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(aegisHeaders)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
