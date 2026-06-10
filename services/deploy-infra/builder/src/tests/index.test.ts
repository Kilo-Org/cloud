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

import builder from '../index';
import type { Env } from '../types';

function createEnv(): Env {
  return {
    BACKEND_AUTH_TOKEN: 'backend-token',
  } as unknown as Env;
}

beforeEach(() => {
  runEphemeralDeploymentCleanup.mockReset().mockResolvedValue(undefined);
  captureException.mockClear();
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
