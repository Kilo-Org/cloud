import { handleLatencyIngest } from './ingest.js';

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'latency-ingest',
        timestamp: new Date().toISOString(),
      });
    }

    return handleLatencyIngest(request, {
      rateLimiter: env.LATENCY_RATE_LIMITER,
      minAppVersion: env.MIN_APP_VERSION,
      log: line => console.log(JSON.stringify(line)),
    });
  },
};
