export interface SnippetContext {
  apiKey: string;
  slug: string;
  gatewayUrl: string;
  route: string;
}

export interface Snippet {
  id: string;
  label: string;
  language: string;
  code: string;
}

export function sdkSnippets({ apiKey, gatewayUrl }: SnippetContext): Snippet[] {
  return [
    {
      id: 'express',
      label: 'Express',
      language: 'ts',
      code: `import { createExpressMiddleware } from '@aegisgate/sdk';

app.use(createExpressMiddleware({ apiKey: '${apiKey}', gatewayUrl: '${gatewayUrl}' }));`,
    },
    {
      id: 'fastify',
      label: 'Fastify',
      language: 'ts',
      code: `import { createFastifyHook } from '@aegisgate/sdk';

app.addHook('onRequest', createFastifyHook({ apiKey: '${apiKey}', gatewayUrl: '${gatewayUrl}' }));`,
    },
    {
      id: 'nextjs',
      label: 'Next.js',
      language: 'ts',
      code: `// app/api/hello/route.ts
import { withAegisGateNextHandler } from '@aegisgate/sdk';

export const GET = withAegisGateNextHandler({ apiKey: '${apiKey}', gatewayUrl: '${gatewayUrl}' }, async () =>
  Response.json({ ok: true }),
);`,
    },
    {
      id: 'websocket',
      label: 'WebSocket Anti-Cheat',
      language: 'ts',
      code: `import { AegisGateClient } from '@aegisgate/sdk';

const aegis = new AegisGateClient({ apiKey: '${apiKey}', gatewayUrl: '${gatewayUrl}', l1FrameLimitPerSec: 60 });

wss.on('connection', (socket, req) => {
  const playerId = String(req.headers['x-player-id'] ?? req.socket.remoteAddress);
  socket.on('message', (frame) => {
    const verdict = aegis.checkWebSocketFrame(playerId); // sync L1 sliding 1s counter
    if (!verdict.allowed) return; // drop speed-hack packets above 60 FPS
    handleMovement(playerId, frame);
  });
  socket.on('close', () => aegis.releaseWebSocketClient(playerId));
});`,
    },
  ];
}

export function integrationSnippets(ctx: SnippetContext): Snippet[] {
  return [
    ...sdkSnippets(ctx),
    {
      id: 'proxy',
      label: 'Reverse Proxy',
      language: 'bash',
      code: `# Zero-code mode: point clients at the edge proxy instead of the upstream
curl -i -H "x-aegis-key: ${ctx.apiKey}" ${ctx.gatewayUrl}/proxy/${ctx.slug}${ctx.route}`,
    },
    {
      id: 'cli',
      label: 'CLI Benchmark',
      language: 'bash',
      code: `npx pnpm@9.12.0 cli:bench -- --key ${ctx.apiKey} --route ${ctx.route} --requests 200 --concurrency 20
npx pnpm@9.12.0 cli:top`,
    },
  ];
}
