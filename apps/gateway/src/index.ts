import './env';
import { queryClient } from '@aegisgate/db';
import {
  AEGIS_HEADERS,
  CheckRateLimitRequestSchema,
  SimulateBurstRequestSchema,
  simulateBurst,
} from '@aegisgate/shared';
import cors from '@fastify/cors';
import Fastify, { type FastifyError } from 'fastify';
import { z } from 'zod';
import { ADMIN_SECRET_HEADER, registerAdminRoutes } from './admin';
import { getWorkerMetrics, startBatchWorker, stopBatchWorker } from './batch-worker';
import { applyDecisionHeaders, runGatewayCheck } from './check';
import { isDatabaseUnavailable } from './db-errors';
import { closeRateLimiter, connectRateLimiter, getLimiterBackend } from './limiter';
import { registerProxyRoutes } from './proxy';

const CheckBodySchema = CheckRateLimitRequestSchema.extend({ apiKey: z.string().min(1).optional() });

const headerValue = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export async function buildServer() {
  // Default 'warn' keeps per-request access logs (info) off the hot path. Set LOG_LEVEL=info to see them.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
    exposedHeaders: [...Object.values(AEGIS_HEADERS), 'retry-after', 'x-aegis-upstream'],
    allowedHeaders: ['content-type', AEGIS_HEADERS.API_KEY, ADMIN_SECRET_HEADER, 'x-aegis-mock-upstream'],
  });

  // Accept any body type so the reverse proxy can forward it untouched.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.name, reason: error.message });
    }
    if (isDatabaseUnavailable(error)) {
      request.log.warn({ code: error.code }, 'database unavailable');
      return reply.code(503).send({ error: 'Service Unavailable', reason: 'DATABASE_UNAVAILABLE' });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'aegisgate-core',
    timestamp: new Date().toISOString(),
    rateLimiterBackend: getLimiterBackend(),
    worker: getWorkerMetrics(),
  }));

  app.post('/v1/check', async (request, reply) => {
    const parsed = CheckBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });

    const decision = await runGatewayCheck({
      rawKey: parsed.data.apiKey ?? headerValue(request.headers[AEGIS_HEADERS.API_KEY]),
      route: parsed.data.route,
      method: parsed.data.method,
      clientIp: parsed.data.clientIp,
      costOverride: parsed.data.costOverride,
    });
    applyDecisionHeaders(reply, decision);
    return reply.code(decision.httpStatus).send(decision.body);
  });

  registerProxyRoutes(app);

  app.post('/v1/simulate-burst', async (request, reply) => {
    const parsed = SimulateBurstRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    return simulateBurst(parsed.data);
  });

  await registerAdminRoutes(app);

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  const backend = await connectRateLimiter();
  startBatchWorker();

  const port = Number(process.env.GATEWAY_PORT) || 4000;
  const host = process.env.GATEWAY_HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  console.info(`[gateway] AegisGate listening on http://${host}:${port} (rate limiter: ${backend})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[gateway] ${signal} received, shutting down`);
    try {
      await app.close();
      const final = await stopBatchWorker();
      if (final.error) console.warn(`[gateway] final flush incomplete (${getWorkerMetrics().bufferSize} events buffered)`);
      await closeRateLimiter();
      await queryClient.end({ timeout: 5 });
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[gateway] Failed to start:', err);
  process.exit(1);
});
