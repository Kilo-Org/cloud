import { Container, ContainerProxy } from '@cloudflare/containers';
import { Hono } from 'hono';
import { withCloudflareAccess } from './cf-access.middleware';
import { readSecretState } from './secrets';

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
      const gfSecretKey = await readSecretState(this.env, 'GF_SECRET_KEY', this.ctx);
      if (gfSecretKey.state !== 'value' || !gfSecretKey.value) {
        return new Response('Grafana secrets unavailable; cannot start container', {
          status: 503,
        });
      }
      this.envVars = {
        // Datasource URL points at the fake internal host; outbound handler
        // proxies to the real Cloudflare AE SQL API and injects the token.
        CF_CLICKHOUSE_URL: `http://${AE_PROXY_HOST}/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/analytics_engine/sql`,
        CF_ACCOUNT_ID: this.env.CF_ACCOUNT_ID,
        GF_SECURITY_SECRET_KEY: gfSecretKey.value,
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

    // Interception runs in the containers package's `ContainerProxy` WorkerEntrypoint, whose
    // outbound handler receives no `ExecutionContext`, so this read cannot hand a bundle
    // revalidation to `waitUntil`. A refresh started between the 240 s revalidate point and the
    // 300 s cache TTL lasts only as long as this outbound request; if the request ends first the
    // client counts the attempt as failed and serves the bundle it already holds while it backs
    // off, never beyond the 24 h stale cap. So the cost after that point is a slower read, not a
    // fetch per request and not an unboundedly stale bundle. The DO's own `GF_SECRET_KEY` read
    // passes `this.ctx`.
    const token = await readSecretState(env, 'O11Y_CF_AE_API_TOKEN');
    if (token.state === 'off') {
      // The `dev` block binds no Analytics Engine token: none has been minted for dev, and a
      // non-production block of a config that binds STS may not read a production-named store
      // secret. That deployment therefore runs this proxy off; adding a `_DEV` store entry and its
      // dev binding turns it back on with no code change. Answer it as a missing feature, not a
      // broken read.
      return new Response('Analytics Engine proxy is not configured for this deployment', {
        status: 503,
      });
    }
    if (token.state !== 'value' || !token.value) {
      return new Response('Analytics Engine token unavailable', { status: 503 });
    }

    const src = new URL(request.url);
    const target = new URL(env.CF_CLICKHOUSE_URL);
    target.search = src.search;

    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${token.value}`);
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

const app = new Hono<KiloOpsEnv>();

app.get('/healthz', c => c.json({ ok: true }));

const LOCAL_DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

app.use('/*', async (c, next) => {
  // The dev-mode CF Access bypass requires BOTH ENVIRONMENT=development AND a
  // localhost hostname. Guarding on ENVIRONMENT alone would make a single
  // misconfigured `wrangler deploy --env dev` on the production route enough
  // to turn every public visitor into a Grafana admin.
  const hostname = new URL(c.req.url).hostname;
  if (c.env.ENVIRONMENT === 'development' && LOCAL_DEV_HOSTNAMES.has(hostname)) {
    c.set('userIdentity', 'dev@kilo.dev');
    return next();
  }

  const mw = withCloudflareAccess({
    team: c.env.CF_ACCESS_TEAM,
    audience: c.env.CF_ACCESS_AUD,
  });
  return mw(c as Parameters<typeof mw>[0], next);
});

const STRIPPED_REQUEST_HEADERS = new Set([
  'x-webauth-user',
  'authorization',
  'cf-access-jwt-assertion',
  'cookie',
]);

app.all('/*', async c => {
  const userIdentity = c.get('userIdentity');

  const country = (c.req.header('cf-ipcountry') ?? DEFAULT_COUNTRY).toUpperCase();
  const container = getGrafanaContainerStub(c.env, country);

  // Rewrite scheme+host so pathname, search, fragment, and any other URL
  // components carry through to the container without string concatenation.
  const target = new URL(c.req.url);
  target.protocol = 'http:';
  target.host = 'container';

  // Forward the raw request so the body streams to the container instead of
  // being buffered into Worker memory. Dashboard imports and plugin uploads
  // can be multi-MB — buffering would risk the 128 MB isolate limit.
  const forwarded = new Request(target, c.req.raw);
  for (const name of STRIPPED_REQUEST_HEADERS) forwarded.headers.delete(name);
  forwarded.headers.set('X-WEBAUTH-USER', userIdentity);
  const response = await container.fetch(forwarded);

  if (response.status === 101) return response;

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

export default app;
