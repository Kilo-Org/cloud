import { Container } from '@cloudflare/containers';
import { Hono } from 'hono';
import { extractBearerToken, verifyKiloToken } from '@kilocode/worker-utils';
import { verifyCfAccess } from './cf-access';

export type KiloOpsEnv = {
  Bindings: Env;
  Variables: {
    userIdentity: string;
  };
};

const GRAFANA_DO_ID = 'grafana';

export class GrafanaContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = '5m';

  override async fetch(request: Request): Promise<Response> {
    const state = await this.getState();
    const needsStart =
      state.status !== 'running' &&
      state.status !== 'healthy' &&
      state.status !== 'stopping';

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
        GF_SECRET_KEY: gfSecretKey,
      };
    }

    return super.fetch(request);
  }
}

function getGrafanaContainerStub(env: Env) {
  return env.GRAFANA_CONTAINER.get(env.GRAFANA_CONTAINER.idFromName(GRAFANA_DO_ID));
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

app.all('/*', async c => {
  const userIdentity = await authenticate(c.req.raw, c.env);
  if (!userIdentity) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(c.req.url);
  const container = getGrafanaContainerStub(c.env);

  const STRIPPED_HEADERS = new Set([
    'x-webauth-user',
    'authorization',
    'cf-access-jwt-assertion',
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

async function authenticate(request: Request, env: Env): Promise<string | null> {
  const bearerToken = extractBearerToken(request.headers.get('Authorization'));
  if (bearerToken) {
    const identity = await verifyKiloJwt(bearerToken, env);
    if (identity) return identity;
  }

  return verifyCfAccess(request, env.CF_ACCESS_TEAM, env.CF_ACCESS_AUD);
}

async function verifyKiloJwt(token: string, env: Env): Promise<string | null> {
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) return null;

  try {
    const payload = await verifyKiloToken(token, secret);
    if (payload.isAdmin !== true) return null;
    return payload.kiloUserId;
  } catch {
    return null;
  }
}

export default app;
