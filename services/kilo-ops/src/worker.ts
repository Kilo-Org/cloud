import { Container, ContainerProxy } from '@cloudflare/containers';
import { Hono } from 'hono';
import { withCloudflareAccess } from './cf-access.middleware';

export { ContainerProxy };

export type KiloOpsEnv = {
  Bindings: Env;
  Variables: {
    userIdentity: string;
  };
};

const DEFAULT_COUNTRY = 'US';

// Hostname the Grafana datasource uses. Requests to this host are caught by
// the outbound handler and forwarded to the real Cloudflare AE SQL API from
// the Worker runtime (the container cannot reach api.cloudflare.com itself).
const AE_PROXY_HOST = 'cf-ae';

export class GrafanaContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = '1h';

  override async fetch(request: Request): Promise<Response> {
    const state = await this.getState();
    const needsStart =
      state.status !== 'running' && state.status !== 'healthy' && state.status !== 'stopping';

    if (needsStart) {
      const gfSecretKey = await resolveSecret(this.env.GF_SECRET_KEY);
      if (!gfSecretKey) {
        return new Response('Grafana secrets unavailable; cannot start container', {
          status: 503,
        });
      }
      this.envVars = {
        // Datasource URL points at the fake internal host; outbound handler
        // proxies to the real Cloudflare AE SQL API and injects the token.
        CF_CLICKHOUSE_URL: `http://${AE_PROXY_HOST}/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/analytics_engine/sql`,
        CF_ACCOUNT_ID: this.env.CF_ACCOUNT_ID,
        GF_SECURITY_SECRET_KEY: gfSecretKey,
      };
    }

    return super.fetch(request);
  }
}

GrafanaContainer.outboundByHost = {
  [AE_PROXY_HOST]: async (request, env) => {
    // ClickHouse HTTP protocol supports both:
    //   GET  /?query=SELECT...
    //   POST /  (SQL in body)
    // Grafana's ClickHouse datasource uses GET for simple SELECTs. Whatever
    // path the container sends, force the upstream path to the AE SQL
    // endpoint and only preserve the query string — this keeps the handler
    // locked to a single upstream regardless of what the container requests.
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    const token = await resolveSecret(env.CF_ANALYTICS_API_KEY);
    if (!token) {
      return new Response('Analytics Engine token unavailable', { status: 503 });
    }

    const src = new URL(request.url);
    const target = new URL(env.CF_CLICKHOUSE_URL);
    target.search = src.search;

    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.delete('host');

    // Buffer the body (empty for GET) to avoid the Workers `fetch`
    // streaming-body duplex requirement. AE SQL payloads are small.
    const body = request.method === 'GET' ? undefined : await request.arrayBuffer();

    return fetch(target, { method: request.method, headers, body });
  },
};

function getGrafanaContainerStub(env: Env, country: string) {
  return env.GRAFANA_CONTAINER.get(env.GRAFANA_CONTAINER.idFromName(`grafana-${country}`));
}

async function resolveSecret(binding: SecretsStoreSecret | string): Promise<string | null> {
  if (typeof binding === 'string') return binding;
  try {
    return await binding.get();
  } catch (err) {
    console.error(
      '[resolveSecret] Secrets Store fetch failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

const app = new Hono<KiloOpsEnv>();

app.get('/healthz', c => c.json({ ok: true }));

app.use('/*', async (c, next) => {
  if (c.env.ENVIRONMENT === 'development') {
    c.set('userIdentity', 'dev@kilo.dev');
    return next();
  }

  const mw = withCloudflareAccess({
    team: c.env.CF_ACCESS_TEAM,
    audience: c.env.CF_ACCESS_AUD,
  });
  return mw(c as Parameters<typeof mw>[0], next);
});

app.all('/*', async c => {
  const userIdentity = c.get('userIdentity');

  const url = new URL(c.req.url);
  const country = (c.req.header('cf-ipcountry') ?? DEFAULT_COUNTRY).toUpperCase();
  const container = getGrafanaContainerStub(c.env, country);

  const STRIPPED_HEADERS = new Set([
    'x-webauth-user',
    'authorization',
    'cf-access-jwt-assertion',
    'cookie',
  ]);
  const headers = new Headers();
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (STRIPPED_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set('X-WEBAUTH-USER', userIdentity);

  const init: RequestInit = {
    method: c.req.method,
    headers,
  };

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const body = await c.req.raw.arrayBuffer();
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  const containerUrl = `http://container${url.pathname}${url.search}`;
  const response = await container.fetch(containerUrl, init);

  if (response.status === 101) return response;

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

export default app;
