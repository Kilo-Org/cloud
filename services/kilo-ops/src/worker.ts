import { Container } from '@cloudflare/containers';
import { Hono } from 'hono';
import { withCloudflareAccess } from './cf-access.middleware';

export type KiloOpsEnv = {
  Bindings: Env;
  Variables: {
    userIdentity: string;
  };
};

const DEFAULT_COUNTRY = 'US';

export class GrafanaContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = '1h';

  override async fetch(request: Request): Promise<Response> {
    const state = await this.getState();
    const needsStart =
      state.status !== 'running' && state.status !== 'healthy' && state.status !== 'stopping';

    if (needsStart) {
      const analyticsApiKey = await resolveSecret(this.env.CF_ANALYTICS_API_KEY);
      const gfSecretKey = await resolveSecret(this.env.GF_SECRET_KEY);
      if (!analyticsApiKey || !gfSecretKey) {
        return new Response('Grafana secrets unavailable; cannot start container', {
          status: 503,
        });
      }
      this.envVars = {
        CF_CLICKHOUSE_URL: this.env.CF_CLICKHOUSE_URL,
        CF_ACCOUNT_ID: this.env.CF_ACCOUNT_ID,
        CF_ANALYTICS_API_KEY: analyticsApiKey,
        GF_SECURITY_SECRET_KEY: gfSecretKey,
        GF_SERVER_ROOT_URL: this.env.GF_SERVER_ROOT_URL,
      };
    }

    return super.fetch(request);
  }
}

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
