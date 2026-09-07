const mockGetWorkerDb = jest.fn();
const mockCreatePending = jest.fn();
const mockActivate = jest.fn();
const mockDeploy = jest.fn();
const mockCaptureException = jest.fn();
const mockLogError = jest.fn();

jest.mock('@kilocode/db/client', () => ({ getWorkerDb: mockGetWorkerDb }));
jest.mock('@sentry/cloudflare', () => ({ captureException: mockCaptureException }));
jest.mock('../assets/static.worker.js', () => 'export default {}', { virtual: true });
jest.mock('../cloudflare-api', () => ({
  CloudflareAPI: jest.fn().mockImplementation(() => ({ deleteWorker: jest.fn() })),
}));
jest.mock('../deployer', () => ({
  Deployer: jest.fn().mockImplementation(() => ({ deploy: mockDeploy })),
}));
jest.mock('../html-deploy/dispatcher-client', () => ({
  HtmlDeployDispatcherClient: jest.fn().mockImplementation(() => ({
    setSlugMapping: jest.fn(async () => true),
    enableBanner: jest.fn(),
    deleteSlugMapping: jest.fn(),
    disableBanner: jest.fn(),
  })),
}));
jest.mock('../html-deploy/stored-slug', () => ({
  isStoredDeploymentSlug: jest.fn(async () => false),
}));
jest.mock('../html-deploy/repository', () => ({
  createPendingEphemeralDeployment: mockCreatePending,
  activateEphemeralDeployment: mockActivate,
  markEphemeralDeploymentForCleanup: jest.fn(async () => true),
  completeUnclaimedEphemeralDeploymentCleanup: jest.fn(async () => true),
}));

import { clearSecretCacheForTest, createErrorHandler } from '@kilocode/worker-utils';
import { HTML_DEPLOY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { signKiloToken } from '@kilocode/worker-utils/kilo-token';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { htmlDeployHandler } from '../html-deploy/handler';
import type { HonoEnv } from '../types';

const SECRET = 'test-secret-that-is-long-enough-for-hs256';
const USER_ID = 'user-uuid';
const CURRENT_PEPPER = 'pepper-current';

type Account = { pepper: string | null; blockedReason: string | null } | null;

let account: Account;
let failLookup = false;
let lookupCount = 0;
let rateLimit = jest.fn();

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signClaims(claims: Record<string, unknown>, secret = SECRET): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function rawToken(overrides: Record<string, unknown> = {}, secret = SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  return signClaims(
    {
      version: 3,
      kiloUserId: USER_ID,
      apiTokenPepper: CURRENT_PEPPER,
      env: 'production',
      iat: now,
      exp: now + 3600,
      ...overrides,
    },
    secret
  );
}

async function token(
  options: {
    audience?: string;
    pepper?: string | null;
    env?: string;
    expiresInSeconds?: number;
    extra?: { tokenSource?: string; deviceSessionId?: string };
  } = {}
): Promise<string> {
  return (
    await signKiloToken({
      userId: USER_ID,
      secret: SECRET,
      pepper: 'pepper' in options ? options.pepper : CURRENT_PEPPER,
      env: 'env' in options ? options.env : 'production',
      audience: options.audience,
      expiresInSeconds: options.expiresInSeconds ?? 3600,
      extra: options.extra,
    })
  ).token;
}

function createApp(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.post('/deploy-html', htmlDeployHandler);
  const errorHandler = createErrorHandler({ error: mockLogError }, { includeMessage: false });
  app.onError((error, c) => {
    mockCaptureException(error, { extra: { path: c.req.path, method: c.req.method } });
    return errorHandler(error, c);
  });
  return app;
}

function env(secret: string | null | Error = SECRET): HonoEnv['Bindings'] {
  return {
    NEXTAUTH_SECRET: {
      get: async (): Promise<string | null> => {
        if (secret instanceof Error) throw secret;
        return secret;
      },
    },
    WORKER_ENV: 'production',
    HYPERDRIVE: { connectionString: 'postgres://test' },
    HtmlDeployRateLimiter: { limit: (options: { key: string }) => rateLimit(options) },
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_API_TOKEN: 'token',
    BACKEND_AUTH_TOKEN: 'backend-token',
    DISPATCHER_AUTH_TOKEN: 'dispatcher-token',
    DEPLOY_HOSTNAME_BASE: 'd.kiloapps.io',
    DeployDispatcher: {},
  } as HonoEnv['Bindings'];
}

function request(value: string | null, body = '<!doctype html><title>Test</title>'): Request {
  return new Request('https://builder.test/deploy-html', {
    method: 'POST',
    headers: {
      ...(value === null ? {} : { Authorization: `Bearer ${value}` }),
      'Content-Type': 'text/html',
    },
    body,
  });
}

async function fetch(tokenValue: string | null, options: { secret?: string | null | Error } = {}) {
  const req = request(tokenValue);
  const response = await createApp().fetch(req, env(options.secret));
  return { req, response };
}

function expectNoAdmissionSideEffects(req: Request): void {
  expect(rateLimit).not.toHaveBeenCalled();
  expect(req.bodyUsed).toBe(false);
  expect(mockCreatePending).not.toHaveBeenCalled();
  expect(mockActivate).not.toHaveBeenCalled();
  expect(mockDeploy).not.toHaveBeenCalled();
}

beforeEach(() => {
  clearSecretCacheForTest();
  account = { pepper: CURRENT_PEPPER, blockedReason: null };
  failLookup = false;
  lookupCount = 0;
  rateLimit = jest.fn(async () => ({ success: false }));
  mockCreatePending.mockResolvedValue({
    created: true,
    deployment: { id: 'deployment-uuid', internalWorkerName: 'unused' },
  });
  mockActivate.mockResolvedValue(true);
  mockDeploy.mockResolvedValue(undefined);
  mockGetWorkerDb.mockImplementation(() => ({
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn(async () => {
        lookupCount++;
        if (failLookup) throw new Error('database unavailable');
        return account === null
          ? []
          : [{ api_token_pepper: account.pepper, blocked_reason: account.blockedReason }];
      }),
    })),
  }));
  jest.clearAllMocks();
});

describe('HTML deploy bearer authentication', () => {
  it('accepts the intended string and array audience before rate limiting', async () => {
    for (const value of [
      await token({ audience: HTML_DEPLOY_AUDIENCE }),
      rawToken({ aud: ['another-resource', HTML_DEPLOY_AUDIENCE] }),
    ]) {
      const { req, response } = await fetch(value);
      expect(response.status).toBe(429);
      expect(req.bodyUsed).toBe(false);
    }
    expect(rateLimit).toHaveBeenCalledTimes(2);
    expect(rateLimit).toHaveBeenLastCalledWith({ key: USER_ID });
    expect(mockCreatePending).not.toHaveBeenCalled();
    expect(mockDeploy).not.toHaveBeenCalled();
  });

  it('accepts legacy five-year API and one-hour device tokens', async () => {
    for (const value of [
      await token({ expiresInSeconds: 157_680_000 }),
      await token({ expiresInSeconds: 3600, extra: { deviceSessionId: 'test-device-session' } }),
    ]) {
      expect((await fetch(value)).response.status).toBe(429);
    }
    expect(rateLimit).toHaveBeenCalledTimes(2);
  });

  it('completes an authenticated HTML deployment', async () => {
    rateLimit.mockResolvedValue({ success: true });
    const { response } = await fetch(await token({ audience: HTML_DEPLOY_AUDIENCE }));

    expect(response.status).toBe(200);
    expect(mockCreatePending).toHaveBeenCalledTimes(1);
    expect(mockDeploy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no authorization', null],
    ['malformed JWT', 'not-a-jwt'],
    ['expired JWT', rawToken({ exp: Math.floor(Date.now() / 1000) - 1 })],
    ['wrong signature', rawToken({}, 'a-different-secret-that-is-long-enough')],
    ['API audience', rawToken({ aud: 'kilo-api' })],
    ['gateway audience', rawToken({ aud: 'kilo-gateway' })],
    ['worker audience', rawToken({ aud: 'worker' })],
    ['null audience', rawToken({ aud: null })],
    ['blank audience', rawToken({ aud: '' })],
    ['padded audience', rawToken({ aud: ` ${HTML_DEPLOY_AUDIENCE} ` })],
    ['invalid token version', rawToken({ version: 2, aud: HTML_DEPLOY_AUDIENCE })],
    ['empty audience array', rawToken({ aud: [] })],
    ['duplicate audience array', rawToken({ aud: [HTML_DEPLOY_AUDIENCE, HTML_DEPLOY_AUDIENCE] })],
    ['non-string audience array', rawToken({ aud: [HTML_DEPLOY_AUDIENCE, 1] })],
  ])('rejects %s before admission side effects', async (_name, value) => {
    const { req, response } = await fetch(value);

    expect(response.status).toBe(401);
    expectNoAdmissionSideEffects(req);
    expect(lookupCount).toBe(0);
  });

  it.each([
    [
      'stale pepper',
      { apiTokenPepper: 'pepper-stale' },
      { pepper: CURRENT_PEPPER, blockedReason: null },
    ],
    ['null pepper', { apiTokenPepper: null }, { pepper: CURRENT_PEPPER, blockedReason: null }],
    ['missing account', {}, null],
    ['blocked account', {}, { pepper: CURRENT_PEPPER, blockedReason: 'manual block' }],
  ])(
    'rejects %s after account verification but before admission',
    async (_name, claims, nextAccount) => {
      account = nextAccount;
      const value = rawToken({ aud: HTML_DEPLOY_AUDIENCE, ...claims });
      const { req, response } = await fetch(value);

      expect(response.status).toBe(401);
      expect(lookupCount).toBe(1);
      expectNoAdmissionSideEffects(req);
    }
  );

  it.each([undefined, 'staging'])(
    'rejects environment %s before account lookup',
    async environment => {
      const { req, response } = await fetch(
        rawToken({ aud: HTML_DEPLOY_AUDIENCE, env: environment })
      );
      expect(response.status).toBe(401);
      expect(lookupCount).toBe(0);
      expect(mockGetWorkerDb).not.toHaveBeenCalled();
      expectNoAdmissionSideEffects(req);
    }
  );

  it('allows absent pepper claims for the resource audience', async () => {
    const absentPepper = rawToken({
      aud: HTML_DEPLOY_AUDIENCE,
      apiTokenPepper: undefined,
    });
    expect((await fetch(absentPepper)).response.status).toBe(429);
  });

  it.each([null, ''])('treats missing or empty secret %s as a server error', async secret => {
    const { req, response } = await fetch(rawToken({ aud: HTML_DEPLOY_AUDIENCE }), { secret });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mockGetWorkerDb).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expectNoAdmissionSideEffects(req);
  });

  it.each(['secret provider', 'database'])(
    'surfaces %s failures to the global error handler',
    async kind => {
      const value = await token({ audience: HTML_DEPLOY_AUDIENCE });
      if (kind === 'database') failLookup = true;
      const { response } = await fetch(value, {
        ...(kind === 'secret provider' ? { secret: new Error('secrets store unavailable') } : {}),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(rateLimit).not.toHaveBeenCalled();
      expect(mockCreatePending).not.toHaveBeenCalled();
      expect(mockDeploy).not.toHaveBeenCalled();
    }
  );
});
