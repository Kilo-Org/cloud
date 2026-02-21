import http from 'node:http';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { createHttpProxy, handleWebSocketUpgrade } from './proxy';
import { createSupervisor } from './supervisor';
import { registerHealthRoute } from './routes/health';
import { registerGatewayRoutes } from './routes/gateway';

export type RuntimeConfig = {
  port: number;
  expectedToken: string;
  requireProxyToken: boolean;
  gatewayArgs: string[];
};

function parseBoolean(value: string | undefined): boolean {
  return (value ?? '').toLowerCase() === 'true';
}

function parseGatewayArgs(value: string | undefined): string[] {
  if (!value) {
    throw new Error('KILOCLAW_GATEWAY_ARGS is required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('KILOCLAW_GATEWAY_ARGS must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) {
    throw new Error('KILOCLAW_GATEWAY_ARGS must be a JSON array of strings');
  }
  return parsed;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const expectedToken = env.OPENCLAW_GATEWAY_TOKEN;
  if (!expectedToken) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is required');
  }

  return {
    port: Number(env.PORT ?? 18789),
    expectedToken,
    requireProxyToken: parseBoolean(env.REQUIRE_PROXY_TOKEN),
    gatewayArgs: parseGatewayArgs(env.KILOCLAW_GATEWAY_ARGS),
  };
}

async function handleHttpRequest(
  app: Hono,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const method = (req.method ?? 'GET').toUpperCase();

  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: req.headers as HeadersInit,
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = req as unknown as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }

  const response = await app.fetch(new Request(url, init));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body as never).pipe(res);
}

export async function startController(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadRuntimeConfig(env);
  const supervisor = createSupervisor({
    gatewayArgs: config.gatewayArgs,
  });

  const app = new Hono();
  registerHealthRoute(app, supervisor);
  registerGatewayRoutes(app, supervisor, config.expectedToken);
  app.all(
    '*',
    createHttpProxy({
      expectedToken: config.expectedToken,
      requireProxyToken: config.requireProxyToken,
    })
  );

  const server = http.createServer((req, res) => {
    void handleHttpRequest(app, req, res).catch(error => {
      console.error('[controller] HTTP handler failed:', error);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    });
  });

  server.on('upgrade', (req, socket, head) => {
    handleWebSocketUpgrade(req, socket, head, {
      expectedToken: config.expectedToken,
      requireProxyToken: config.requireProxyToken,
    });
  });

  await supervisor.start();

  await new Promise<void>(resolve => {
    server.listen(config.port, '0.0.0.0', () => {
      console.log(
        `[controller] Listening on :${config.port} requireProxyToken=${config.requireProxyToken}`
      );
      resolve();
    });
  });

  let shuttingDown = false;
  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[controller] Received ${signal}, shutting down`);

    await supervisor.shutdown(signal);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void onSignal('SIGTERM');
  });
  process.on('SIGINT', () => {
    void onSignal('SIGINT');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startController().catch(error => {
    console.error('[controller] Fatal startup error:', error);
    process.exit(1);
  });
}
