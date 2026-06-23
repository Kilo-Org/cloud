const mockGetWorkerDb = jest.fn();
const mockCreatePendingEphemeralDeployment = jest.fn();
const mockActivateEphemeralDeployment = jest.fn();
const mockMarkEphemeralDeploymentForCleanup = jest.fn();
const mockCompleteUnclaimedEphemeralDeploymentCleanup = jest.fn();
const mockDeploy = jest.fn();
const mockSetSlugMapping = jest.fn();
const mockDeleteSlugMapping = jest.fn();
const mockEnableBanner = jest.fn();
const mockDisableBanner = jest.fn();
const mockDeleteWorker = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('@kilocode/db/client', () => ({
  getWorkerDb: mockGetWorkerDb,
}));
jest.mock('@kilocode/worker-utils/kilo-token-auth', () => ({
  verifyKiloBearerAgainstCurrentPepper: jest.fn(async () => ({ userId: 'user-uuid' })),
}));
jest.mock('@sentry/cloudflare', () => ({
  captureException: mockCaptureException,
}));
jest.mock('../cloudflare-api', () => ({
  CloudflareAPI: jest.fn().mockImplementation(() => ({
    deleteWorker: mockDeleteWorker,
  })),
}));
jest.mock('../deployer', () => ({
  Deployer: jest.fn().mockImplementation(() => ({
    deploy: mockDeploy,
  })),
}));
jest.mock('../html-deploy/dispatcher-client', () => {
  const HtmlDeployDispatcherClient = jest.fn();
  HtmlDeployDispatcherClient.prototype.setSlugMapping = mockSetSlugMapping;
  HtmlDeployDispatcherClient.prototype.deleteSlugMapping = mockDeleteSlugMapping;
  HtmlDeployDispatcherClient.prototype.enableBanner = mockEnableBanner;
  HtmlDeployDispatcherClient.prototype.disableBanner = mockDisableBanner;
  return { HtmlDeployDispatcherClient };
});
jest.mock('../html-deploy/repository', () => ({
  createPendingEphemeralDeployment: mockCreatePendingEphemeralDeployment,
  activateEphemeralDeployment: mockActivateEphemeralDeployment,
  markEphemeralDeploymentForCleanup: mockMarkEphemeralDeploymentForCleanup,
  completeUnclaimedEphemeralDeploymentCleanup: mockCompleteUnclaimedEphemeralDeploymentCleanup,
}));
jest.mock('../assets/static.worker.js', () => 'export default {}', { virtual: true });

import { HtmlDeployDispatcherClient } from '../html-deploy/dispatcher-client';
import { htmlDeployHandler } from '../html-deploy/handler';

const pendingDeployment = {
  created: true,
  deployment: {
    id: 'deployment-uuid',
    internalWorkerName: 'unused-by-handler',
  },
};

function createEmptySelectQuery() {
  return {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => []),
  };
}

const db = {
  select: jest.fn(() => createEmptySelectQuery()),
};

function createContext(
  options: {
    expiresIn?: string;
    rateLimitSuccess?: boolean;
    requestBody?: BodyInit;
  } = {}
) {
  const requestBody = options.requestBody ?? '<!doctype html>';
  const request = new Request('https://builder.test/deploy-html', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token',
      ...(requestBody instanceof FormData ? {} : { 'Content-Type': 'text/html' }),
      ...(options.expiresIn === undefined ? {} : { 'X-Expires-In': options.expiresIn }),
    },
    body: requestBody,
  });

  return {
    req: {
      raw: request,
      header(name: string) {
        return request.headers.get(name) ?? undefined;
      },
    },
    env: {
      NEXTAUTH_SECRET: {},
      WORKER_ENV: 'test',
      HYPERDRIVE: { connectionString: 'postgres://test' },
      HtmlDeployRateLimiter: {
        limit: jest.fn(async () => ({ success: options.rateLimitSuccess ?? true })),
      },
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'token',
      BACKEND_AUTH_TOKEN: 'backend-token',
      DISPATCHER_AUTH_TOKEN: 'dispatcher-token',
      DEPLOY_HOSTNAME_BASE: 'd.kiloapps.io',
      DeployDispatcher: {},
    },
    json(body: unknown, status: number) {
      return Response.json(body, { status });
    },
  };
}

function expectNoPendingInsertOrDeployment(): void {
  expect(mockCreatePendingEphemeralDeployment).not.toHaveBeenCalled();
  expect(mockDeploy).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetWorkerDb.mockReturnValue(db);
  mockCreatePendingEphemeralDeployment.mockResolvedValue(pendingDeployment);
  mockActivateEphemeralDeployment.mockResolvedValue(true);
  mockMarkEphemeralDeploymentForCleanup.mockResolvedValue(true);
  mockCompleteUnclaimedEphemeralDeploymentCleanup.mockResolvedValue(true);
  mockDeploy.mockResolvedValue(undefined);
  mockSetSlugMapping.mockResolvedValue(true);
  mockDeleteSlugMapping.mockResolvedValue(undefined);
  mockEnableBanner.mockResolvedValue(undefined);
  mockDisableBanner.mockResolvedValue(undefined);
  mockDeleteWorker.mockResolvedValue(undefined);
});

describe('HTML deployment admission', () => {
  it('denies a rate-limited request before parsing or inserting a pending deployment', async () => {
    const context = createContext({ rateLimitSuccess: false });

    const response = await htmlDeployHandler(context as never);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: 'Too many HTML deployment requests' });
    expect(context.env.HtmlDeployRateLimiter.limit).toHaveBeenCalledWith({ key: 'user-uuid' });
    expect(context.req.raw.bodyUsed).toBe(false);
    expectNoPendingInsertOrDeployment();
  });

  it('rejects a malformed TTL before parsing or inserting a pending deployment', async () => {
    const context = createContext({ expiresIn: '3600seconds' });

    const response = await htmlDeployHandler(context as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'X-Expires-In must be a positive base-10 integer',
    });
    expect(context.req.raw.bodyUsed).toBe(false);
    expectNoPendingInsertOrDeployment();
  });

  it('returns a parse failure before inserting a pending deployment or deploying', async () => {
    const response = await htmlDeployHandler(createContext({ requestBody: '' }) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Empty body' });
    expectNoPendingInsertOrDeployment();
  });

  it('returns an empty multipart upload failure before inserting a pending deployment or deploying', async () => {
    const response = await htmlDeployHandler(
      createContext({ requestBody: new FormData() }) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'No files provided' });
    expectNoPendingInsertOrDeployment();
  });

  it('returns a validation failure before inserting a pending deployment or deploying', async () => {
    const form = new FormData();
    form.append('main.html', new Blob(['<!doctype html>'], { type: 'text/html' }), 'main.html');

    const response = await htmlDeployHandler(createContext({ requestBody: form }) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'index.html is required at the root' });
    expectNoPendingInsertOrDeployment();
  });

  it('returns a fixed unauthorized response when the pending owner is unavailable', async () => {
    mockCreatePendingEphemeralDeployment.mockResolvedValueOnce({
      created: false,
      reason: 'owner_unavailable',
    });

    const response = await htmlDeployHandler(createContext() as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid or expired token' });
    expect(mockCreatePendingEphemeralDeployment).toHaveBeenCalledTimes(1);
    expect(mockDeploy).not.toHaveBeenCalled();
  });

  it('returns a fixed server error when inserting the pending deployment fails', async () => {
    mockCreatePendingEphemeralDeployment.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await htmlDeployHandler(createContext() as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to record deployment' });
    expect(mockDeploy).not.toHaveBeenCalled();
  });
});

describe('HTML deployment lifecycle', () => {
  it('records a pending deployment before deploying, mapping, and activating it', async () => {
    const attempted: string[] = [];
    const context = createContext();
    mockCreatePendingEphemeralDeployment.mockImplementationOnce(async () => {
      attempted.push('pending-insert');
      return pendingDeployment;
    });
    mockDeploy.mockImplementationOnce(async () => {
      attempted.push('deploy');
    });
    mockSetSlugMapping.mockImplementationOnce(async () => {
      attempted.push('map');
      return true;
    });
    mockEnableBanner.mockImplementationOnce(async () => {
      attempted.push('enable-banner');
    });
    mockActivateEphemeralDeployment.mockImplementationOnce(async () => {
      attempted.push('activate');
      return true;
    });

    const response = await htmlDeployHandler(context as never);

    expect(response.status).toBe(200);
    expect(attempted).toEqual(['pending-insert', 'deploy', 'map', 'enable-banner', 'activate']);
    expect(HtmlDeployDispatcherClient).toHaveBeenCalledWith(
      context.env.DeployDispatcher,
      'dispatcher-token',
      'd.kiloapps.io'
    );
  });

  it('marks cleanup and independently tears down resources when deployment fails', async () => {
    const attempted: string[] = [];
    mockDeploy.mockRejectedValueOnce(new Error('Cloudflare unavailable'));
    mockMarkEphemeralDeploymentForCleanup.mockImplementationOnce(async () => {
      attempted.push('cleanup-mark');
      return true;
    });
    mockDeleteSlugMapping.mockImplementationOnce(async () => {
      attempted.push('delete-mapping');
      throw new Error('dispatcher unavailable');
    });
    mockDisableBanner.mockImplementationOnce(async () => {
      attempted.push('disable-banner');
    });
    mockDeleteWorker.mockImplementationOnce(async () => {
      attempted.push('delete-worker');
    });

    const response = await htmlDeployHandler(createContext() as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Deployment failed: Cloudflare unavailable',
    });
    expect(attempted).toEqual([
      'cleanup-mark',
      'delete-mapping',
      'disable-banner',
      'delete-worker',
    ]);
    expect(mockCompleteUnclaimedEphemeralDeploymentCleanup).not.toHaveBeenCalled();
  });

  it('runs cleanup when slug mapping fails', async () => {
    mockSetSlugMapping.mockRejectedValueOnce(new Error('dispatcher unavailable'));

    const response = await htmlDeployHandler(createContext() as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to allocate an available deployment URL',
    });
    expect(mockMarkEphemeralDeploymentForCleanup).toHaveBeenCalledTimes(1);
    expect(mockDeleteSlugMapping).toHaveBeenCalledTimes(1);
    expect(mockDisableBanner).toHaveBeenCalledTimes(1);
    expect(mockDeleteWorker).toHaveBeenCalledTimes(1);
  });

  it('continues activation when badge enablement fails', async () => {
    const error = new Error('dispatcher unavailable');
    mockEnableBanner.mockRejectedValueOnce(error);

    const response = await htmlDeployHandler(createContext() as never);

    expect(response.status).toBe(200);
    expect(mockActivateEphemeralDeployment).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      extra: {
        slug: expect.any(String),
        workerName: expect.stringMatching(/^qdpl-/),
        action: 'html-deploy-enable-banner',
      },
    });
    expect(mockMarkEphemeralDeploymentForCleanup).not.toHaveBeenCalled();
    expect(mockDeleteSlugMapping).not.toHaveBeenCalled();
    expect(mockDisableBanner).not.toHaveBeenCalled();
    expect(mockDeleteWorker).not.toHaveBeenCalled();
  });

  it('runs cleanup when activation loses its pending compare-and-swap', async () => {
    mockActivateEphemeralDeployment.mockResolvedValueOnce(false);

    const response = await htmlDeployHandler(createContext() as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to record deployment' });
    expect(mockMarkEphemeralDeploymentForCleanup).toHaveBeenCalledTimes(1);
    expect(mockDeleteSlugMapping).toHaveBeenCalledTimes(1);
    expect(mockDisableBanner).toHaveBeenCalledTimes(1);
    expect(mockDeleteWorker).toHaveBeenCalledTimes(1);
  });

  it('returns the successful expiry as a strict UTC ISO timestamp', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-03T12:34:56.789Z'));

    try {
      const response = await htmlDeployHandler(createContext({ expiresIn: '3600' }) as never);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        slug: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z2-7]{8}$/),
        url: expect.stringMatching(/^https:\/\/[a-z]+-[a-z]+-[a-z2-7]{8}\.d\.kiloapps\.io$/),
        expires_at: '2026-06-03T13:34:56.789Z',
      });
      expect(mockActivateEphemeralDeployment).toHaveBeenCalledWith(db, {
        deploymentId: 'deployment-uuid',
        deploymentSlug: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z2-7]{8}$/),
        expiresAt: '2026-06-03T13:34:56.789Z',
        now: '2026-06-03T12:34:56.789Z',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
