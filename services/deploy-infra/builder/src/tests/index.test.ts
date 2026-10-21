const backendAuthMiddleware = jest.fn(
  (getToken: (context: { env: { BACKEND_AUTH_TOKEN: string } }) => string) =>
    async (
      context: {
        env: { BACKEND_AUTH_TOKEN: string };
        req: { header(name: string): string | undefined };
        json(body: unknown, status: number): Response;
      },
      next: () => Promise<void>
    ) => {
      if (context.req.header('Authorization') !== `Bearer ${getToken(context)}`) {
        return context.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    }
);
const runEphemeralDeploymentCleanup = jest.fn().mockResolvedValue(undefined);
const captureException = jest.fn();
const htmlDeployHandler = jest.fn((context: Context<HonoEnv>) =>
  context.json({ slug: 'html-site' }, 200)
);

jest.mock('cloudflare:workers', () => ({ DurableObject: class {} }), { virtual: true });
jest.mock('../assets/static.worker.js', () => 'export default {}', { virtual: true });
jest.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
jest.mock('@kilocode/worker-utils', () => ({
  backendAuthMiddleware,
  createErrorHandler: jest.fn(() => () => new Response('error', { status: 500 })),
  createNotFoundHandler: jest.fn(() => () => new Response('not found', { status: 404 })),
}));
jest.mock('@kilocode/worker-utils/kilo-token-auth', () => ({
  verifyKiloBearerAgainstCurrentPepper: jest.fn(),
}));
jest.mock('@sentry/cloudflare', () => ({
  captureException,
  instrumentDurableObjectWithSentry: jest.fn((_options, durableObject) => durableObject),
  withSentry: jest.fn((_options, handler) => handler),
}));
jest.mock('../html-deploy/ephemeral-cleanup', () => ({
  runEphemeralDeploymentCleanup,
}));
jest.mock('../html-deploy/handler', () => ({ htmlDeployHandler }));

import type { Context } from 'hono';
import builder from '../index';
import type { Env, HonoEnv } from '../types';

function createEnv(): Env {
  return {
    BACKEND_AUTH_TOKEN: 'backend-token',
  } as unknown as Env;
}

beforeEach(() => {
  runEphemeralDeploymentCleanup.mockReset().mockResolvedValue(undefined);
  captureException.mockClear();
  htmlDeployHandler.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(['/deploy', '/deploy-archive'])('legacy POST %s', path => {
  it.each([
    [
      'valid',
      JSON.stringify({
        slug: 'legacy-site',
        provider: 'github',
        repoSource: 'owner/repo',
        cancelBuildIds: ['existing-build'],
      }),
    ],
    ['malformed', '{invalid-json'],
    ['empty', undefined],
  ])('returns 410 for %s payloads without deployment work', async (_description, body) => {
    const envAccess = jest.fn(Reflect.get);
    const env = new Proxy(createEnv(), { get: envAccess });
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
    const request = new Request(`https://builder.test${path}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer backend-token',
        'Content-Type': path === '/deploy' ? 'application/json' : 'application/gzip',
        'X-Slug': 'legacy-site',
        'X-Env-Vars': '[]',
      },
      body,
    });
    const json = jest.spyOn(request, 'json');
    const arrayBuffer = jest.spyOn(request, 'arrayBuffer');

    const response = await builder.fetch?.(request, env, {} as ExecutionContext);

    expect(response?.status).toBe(410);
    expect(response?.headers.get('Content-Type')).toContain('application/json');
    expect(await response?.json()).toEqual({
      error:
        'Deploy has reached end of life. New deployments and redeployments are no longer available.',
    });
    expect(json).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(envAccess.mock.calls.map(([, key]) => key)).toEqual(['BACKEND_AUTH_TOKEN']);
    expect(fetch).not.toHaveBeenCalled();
    expect(htmlDeployHandler).not.toHaveBeenCalled();
    expect(runEphemeralDeploymentCleanup).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer wrong-token'])('preserves 401 for authorization %s', async token => {
    const response = await builder.fetch?.(
      new Request(`https://builder.test${path}`, {
        method: 'POST',
        headers: token ? { Authorization: token } : {},
        body: '{invalid-json',
      }),
      createEnv(),
      {} as ExecutionContext
    );

    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: 'Unauthorized' });
    expect(htmlDeployHandler).not.toHaveBeenCalled();
  });
});

describe('HTML publishing route', () => {
  it('still routes to the HTML handler without backend authentication', async () => {
    const envAccess = jest.fn(Reflect.get);
    const response = await builder.fetch?.(
      new Request('https://builder.test/deploy-html', {
        method: 'POST',
        headers: { Authorization: 'Bearer html-publishing-token', 'Content-Type': 'text/html' },
        body: '<html><body>Published site</body></html>',
      }),
      new Proxy(createEnv(), { get: envAccess }),
      {} as ExecutionContext
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ slug: 'html-site' });
    expect(htmlDeployHandler).toHaveBeenCalledTimes(1);
    expect(envAccess).not.toHaveBeenCalled();
  });
});

describe('builder entrypoint export shape', () => {
  it('exports callable fetch and scheduled members', () => {
    expect(builder).toEqual(
      expect.objectContaining({
        fetch: expect.any(Function),
        scheduled: expect.any(Function),
      })
    );
  });

  it('runs Postgres cleanup under waitUntil when scheduled', async () => {
    const env = createEnv();
    const waitUntil = jest.fn();

    await builder.scheduled?.({} as ScheduledController, env, {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(runEphemeralDeploymentCleanup).toHaveBeenCalledWith(env);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
  });

  it('reports Postgres cleanup failures', async () => {
    const postgresError = new Error('Postgres unavailable');
    runEphemeralDeploymentCleanup.mockRejectedValue(postgresError);
    const waitUntil = jest.fn();

    await builder.scheduled?.({} as ScheduledController, createEnv(), {
      waitUntil,
    } as unknown as ExecutionContext);
    await waitUntil.mock.calls[0][0];

    expect(captureException).toHaveBeenCalledWith(postgresError, {
      extra: { action: 'html-deploy-postgres-cleanup-sweep' },
    });
  });
});
