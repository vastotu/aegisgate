import { AEGIS_HEADERS } from '@aegisgate/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applyDecisionHeaders, runGatewayCheck } from './check';
import { SHOWCASE_DEMO_KEYS } from './demo-keys';

const UPSTREAM_TIMEOUT_MS = 5_000;
const MOCK_HEADER = 'x-aegis-mock-upstream';

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const STRIPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  AEGIS_HEADERS.API_KEY,
  MOCK_HEADER,
  'x-aegis-admin-secret',
]);
const STRIPPED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'content-length', 'content-encoding', 'set-cookie']);

const headerValue = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Splits `/proxy/<slug>/<path>?<query>` into the raw upstream path and query (minus `demo`). */
function splitUpstreamTarget(url: string): { rawPath: string; search: string } {
  const qIdx = url.indexOf('?');
  const pathPart = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const afterProxy = pathPart.slice('/proxy/'.length);
  const slash = afterProxy.indexOf('/');
  const rawPath = slash >= 0 ? afterProxy.slice(slash) : '/';

  const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : '');
  params.delete('demo');
  const query = params.toString();
  return { rawPath, search: query ? `?${query}` : '' };
}

function isSyntheticUpstream(upstreamUrl: string, request: FastifyRequest): boolean {
  if (headerValue(request.headers[MOCK_HEADER]) === 'true') return true;
  try {
    const host = new URL(upstreamUrl).hostname;
    return host === 'example.com' || host.endsWith('.example.com');
  } catch {
    return true;
  }
}

function forwardHeaders(request: FastifyRequest, requestId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(name)) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const priorXff = out['x-forwarded-for'];
  out['x-forwarded-for'] = priorXff ? `${priorXff}, ${request.ip}` : request.ip;
  out[AEGIS_HEADERS.REQUEST_ID] = requestId;
  return out;
}

function forwardBody(request: FastifyRequest): string | Buffer | undefined {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const body = request.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

export function registerProxyRoutes(app: FastifyInstance): void {
  app.all('/proxy/:slug/*', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const route = `/${(request.params as Record<string, string | undefined>)['*'] ?? ''}`;
    const demo = (request.query as Record<string, unknown> | undefined)?.demo === 'true';
    const rawKey = headerValue(request.headers[AEGIS_HEADERS.API_KEY]) ?? (demo ? SHOWCASE_DEMO_KEYS[slug] : undefined);

    const decision = await runGatewayCheck({
      rawKey,
      route,
      method: request.method,
      clientIp: request.ip,
      expectedSlug: slug,
    });

    if (!decision.body.allowed || !decision.tenant) {
      applyDecisionHeaders(reply, decision);
      return reply.code(decision.httpStatus).send(decision.body);
    }

    const { project } = decision.tenant;
    const synthetic = (upstream: 'synthetic' | 'unreachable-fallback') => {
      applyDecisionHeaders(reply, decision);
      return reply
        .code(200)
        .header('x-aegis-upstream', upstream)
        .send({ proxied: true, project: slug, route, message: 'Protected by AegisGate Edge Proxy', upstream });
    };

    if (isSyntheticUpstream(project.upstreamUrl, request)) return synthetic('synthetic');

    const { rawPath, search } = splitUpstreamTarget(request.url);
    const target = `${project.upstreamUrl.replace(/\/+$/, '')}${rawPath}${search}`;

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers: forwardHeaders(request, decision.body.requestId),
        body: forwardBody(request),
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      request.log.warn({ target, err: err instanceof Error ? err.message : String(err) }, 'upstream unreachable');
      return synthetic('unreachable-fallback');
    }

    upstream.headers.forEach((value, name) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(name)) reply.header(name, value);
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) reply.header('set-cookie', cookies);

    applyDecisionHeaders(reply, decision);
    const payload = Buffer.from(await upstream.arrayBuffer());
    return reply.code(upstream.status).send(payload);
  });
}
