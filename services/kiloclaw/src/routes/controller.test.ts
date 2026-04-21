import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { controller } from './controller';
import { deriveGatewayToken } from '../auth/gateway-token';
import { encryptWithSymmetricKey } from '@kilocode/encryption';

type AnalyticsEngineDataPoint = {
  blobs: string[];
  doubles: number[];
  indexes: string[];
};

vi.mock('cloudflare:workers', () => ({
  waitUntil: (p: Promise<unknown>) => p,
}));

const {
  mockGetWorkerDb,
  mockFindEmailByUserId,
  mockGetInstanceBySandboxId,
  mockGetGoogleOAuthConnectionByInstanceId,
  mockUpdateGoogleOAuthConnectionTokenData,
} = vi.hoisted(() => ({
  mockGetWorkerDb: vi.fn().mockReturnValue({}),
  mockFindEmailByUserId: vi.fn().mockResolvedValue('user@example.com'),
  mockGetInstanceBySandboxId: vi.fn(),
  mockGetGoogleOAuthConnectionByInstanceId: vi.fn(),
  mockUpdateGoogleOAuthConnectionTokenData: vi.fn(),
}));

vi.mock('../db', () => ({
  getWorkerDb: mockGetWorkerDb,
  findEmailByUserId: mockFindEmailByUserId,
  getInstanceBySandboxId: mockGetInstanceBySandboxId,
  getGoogleOAuthConnectionByInstanceId: mockGetGoogleOAuthConnectionByInstanceId,
  updateGoogleOAuthConnectionTokenData: mockUpdateGoogleOAuthConnectionTokenData,
}));

type CaptureEventArg = {
  apiKey: string;
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
};

const mockCapturePostHogEvent = vi
  .fn<(event: CaptureEventArg) => Promise<void>>()
  .mockResolvedValue(undefined);
vi.mock('../lib/posthog', () => ({
  capturePostHogEvent: (event: CaptureEventArg) => mockCapturePostHogEvent(event),
}));

const sandboxId = 'dXNlci0x';

function makeEnv(options?: {
  gatewayTokenSecret?: string;
  kilocodeApiKey?: string;
  writeDataPoint?: (payload: AnalyticsEngineDataPoint) => void;
  posthogKey?: string;
  hyperdriveConnectionString?: string;
  workerEnv?: string;
  tryMarkInstanceReady?: Mock;
  internalApiSecret?: string;
  googleWorkspaceOauthClientId?: string;
  googleWorkspaceOauthClientSecret?: string;
  googleWorkspaceRefreshTokenEncryptionKey?: string;
}) {
  const getConfig = vi.fn().mockResolvedValue({
    kilocodeApiKey: options?.kilocodeApiKey ?? 'kilo-key-1',
  });
  const getStatus = vi.fn().mockResolvedValue({
    userId: 'user-1',
    botName: 'Milo',
    botNature: 'Operations copilot',
    botVibe: 'Dry wit',
    botEmoji: '🤖',
  });
  const tryMarkInstanceReady =
    options?.tryMarkInstanceReady ??
    vi.fn().mockResolvedValue({ shouldNotify: false, userId: null });
  const updateGoogleOAuthConnection = vi.fn().mockResolvedValue({
    googleOAuthConnected: true,
    googleOAuthStatus: 'active',
  });

  return {
    GATEWAY_TOKEN_SECRET: options?.gatewayTokenSecret ?? 'gateway-secret',
    WORKER_ENV: options?.workerEnv ?? 'production',
    INTERNAL_API_SECRET: options?.internalApiSecret,
    KILOCLAW_INSTANCE: {
      idFromName: (userId: string) => userId,
      get: () => ({ getConfig, getStatus, tryMarkInstanceReady, updateGoogleOAuthConnection }),
    },
    KILOCLAW_CONTROLLER_AE: options?.writeDataPoint
      ? {
          writeDataPoint: options.writeDataPoint,
        }
      : undefined,
    BACKEND_API_URL: 'https://kilo.test',
    NEXT_PUBLIC_POSTHOG_KEY: options?.posthogKey,
    HYPERDRIVE: options?.hyperdriveConnectionString
      ? { connectionString: options.hyperdriveConnectionString }
      : undefined,
    GOOGLE_WORKSPACE_OAUTH_CLIENT_ID:
      options?.googleWorkspaceOauthClientId ?? 'test-google-client-id',
    GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET:
      options?.googleWorkspaceOauthClientSecret ?? 'test-google-client-secret',
    GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY:
      options?.googleWorkspaceRefreshTokenEncryptionKey ?? Buffer.alloc(32, 7).toString('base64'),
  } as never;
}

function makeBody(overrides?: Record<string, unknown>) {
  return {
    sandboxId,
    machineId: 'machine-1',
    controllerVersion: '2026.3.22',
    controllerCommit: 'abc1234',
    openclawVersion: '2026.3.13',
    openclawCommit: 'def5678',
    supervisorState: 'running',
    totalRestarts: 2,
    restartsSinceLastCheckin: 1,
    uptimeSeconds: 3600,
    loadAvg5m: 0.42,
    bandwidthBytesIn: 1024,
    bandwidthBytesOut: 2048,
    ...overrides,
  };
}

function makeProductTelemetry() {
  return {
    openclawVersion: '2026.3.13',
    defaultModel: 'kilocode/anthropic/claude-opus-4.6',
    channelCount: 2,
    enabledChannels: ['telegram', 'discord'],
    toolsProfile: 'full',
    execSecurity: 'allowlist',
    browserEnabled: true,
  };
}

async function makeAuthHeaders(targetSandboxId = sandboxId) {
  const gatewayToken = await deriveGatewayToken(targetSandboxId, 'gateway-secret');
  return {
    'content-type': 'application/json',
    authorization: 'Bearer kilo-key-1',
    'x-kiloclaw-gateway-token': gatewayToken,
    'fly-region': 'dfw',
  };
}

function makeGoogleConnection(encryptionKey: string, overrides?: Record<string, unknown>) {
  return {
    instance_id: 'instance-1',
    provider: 'google',
    account_email: 'user@example.com',
    account_subject: 'google-subject-1',
    credential_profile: 'kilo_owned',
    oauth_client_id: null,
    oauth_client_secret_encrypted: null,
    refresh_token_encrypted: encryptWithSymmetricKey('refresh-token-1', encryptionKey),
    capabilities: ['calendar_read'],
    grants_by_source: { oauth: ['calendar_read'] },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    status: 'active',
    connected_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function getInstanceStub(env: unknown): { updateGoogleOAuthConnection: Mock } {
  const kiloInstance = env as {
    KILOCLAW_INSTANCE: {
      get: () => { updateGoogleOAuthConnection: Mock };
    };
  };
  return kiloInstance.KILOCLAW_INSTANCE.get();
}

function analyticsEvents(writeDataPoint: Mock): AnalyticsEngineDataPoint[] {
  const calls = writeDataPoint.mock.calls as [AnalyticsEngineDataPoint][];
  return calls.map(([call]) => call);
}

function firstAnalyticsEvent(writeDataPoint: Mock): AnalyticsEngineDataPoint {
  const [call] = analyticsEvents(writeDataPoint);
  expect(call).toBeDefined();
  return call;
}

describe('POST /checkin', () => {
  beforeEach(() => {
    mockFindEmailByUserId.mockReset().mockResolvedValue('user@example.com');
    mockGetInstanceBySandboxId.mockReset();
    mockGetGoogleOAuthConnectionByInstanceId.mockReset();
    mockUpdateGoogleOAuthConnectionTokenData.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when required auth headers are missing', async () => {
    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeBody()),
      },
      makeEnv()
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when gateway token is invalid', async () => {
    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer kilo-key-1',
          'x-kiloclaw-gateway-token': 'wrong-token',
        },
        body: JSON.stringify(makeBody()),
      },
      makeEnv()
    );

    expect(response.status).toBe(403);
  });

  it('returns 401 when authorization header is malformed', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/status',
      {
        method: 'POST',
        headers: {
          ...headers,
          authorization: 'Token kilo-key-1',
        },
        body: JSON.stringify({ sandboxId }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when api key does not match durable object config', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/status',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId }),
      },
      makeEnv({
        hyperdriveConnectionString: 'postgres://example',
        kilocodeApiKey: 'different-key',
      })
    );

    expect(response.status).toBe(403);
  });

  it('returns 204 and writes AE datapoint when both tokens are valid', async () => {
    const writeDataPoint = vi.fn<(payload: AnalyticsEngineDataPoint) => void>();
    const env = makeEnv({ writeDataPoint });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      { method: 'POST', headers, body: JSON.stringify(makeBody()) },
      env
    );

    expect(response.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);

    const call = firstAnalyticsEvent(writeDataPoint);
    expect(call.doubles).toHaveLength(8);
    expect(call.doubles[6]).toBe(0);
    expect(call.doubles[7]).toBe(0);
  });

  it('writes disk usage doubles when disk stats are present', async () => {
    const writeDataPoint = vi.fn<(payload: AnalyticsEngineDataPoint) => void>();
    const env = makeEnv({ writeDataPoint });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ diskUsedBytes: 1024000, diskTotalBytes: 5368709120 })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);

    const call = firstAnalyticsEvent(writeDataPoint);
    expect(call.doubles).toHaveLength(8);
    expect(call.doubles[6]).toBe(1024000);
    expect(call.doubles[7]).toBe(5368709120);
  });

  it('normalizes null disk usage doubles to zero', async () => {
    const writeDataPoint = vi.fn<(payload: AnalyticsEngineDataPoint) => void>();
    const env = makeEnv({ writeDataPoint });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ diskUsedBytes: null, diskTotalBytes: null })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);

    const call = firstAnalyticsEvent(writeDataPoint);
    expect(call.doubles).toHaveLength(8);
    expect(call.doubles[6]).toBe(0);
    expect(call.doubles[7]).toBe(0);
  });

  it('clamps negative disk usage doubles to zero', async () => {
    const writeDataPoint = vi.fn<(payload: AnalyticsEngineDataPoint) => void>();
    const env = makeEnv({ writeDataPoint });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ diskUsedBytes: -1, diskTotalBytes: -1 })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);

    const call = firstAnalyticsEvent(writeDataPoint);
    expect(call.doubles).toHaveLength(8);
    expect(call.doubles[6]).toBe(0);
    expect(call.doubles[7]).toBe(0);
  });

  it('still returns 204 when AE write throws', async () => {
    const writeDataPoint = vi
      .fn<(payload: AnalyticsEngineDataPoint) => Promise<void>>()
      .mockRejectedValue(new Error('AE error'));
    const env = makeEnv({ writeDataPoint });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      { method: 'POST', headers, body: JSON.stringify(makeBody()) },
      env
    );

    expect(response.status).toBe(204);
  });

  it('does not call PostHog when productTelemetry is absent', async () => {
    mockCapturePostHogEvent.mockClear();
    const headers = await makeAuthHeaders();
    const env = makeEnv({ posthogKey: 'phc_test' });

    const response = await controller.request(
      '/checkin',
      { method: 'POST', headers, body: JSON.stringify(makeBody()) },
      env
    );

    expect(response.status).toBe(204);
    expect(mockCapturePostHogEvent).not.toHaveBeenCalled();
  });

  it('does not call PostHog when NEXT_PUBLIC_POSTHOG_KEY is unset', async () => {
    mockCapturePostHogEvent.mockClear();
    const headers = await makeAuthHeaders();
    const env = makeEnv(); // no posthogKey

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ productTelemetry: makeProductTelemetry() })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(mockCapturePostHogEvent).not.toHaveBeenCalled();
  });

  it('does not call PostHog in development mode', async () => {
    mockCapturePostHogEvent.mockClear();
    const headers = await makeAuthHeaders();
    const env = makeEnv({ posthogKey: 'phc_test', workerEnv: 'development' });

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ productTelemetry: makeProductTelemetry() })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(mockCapturePostHogEvent).not.toHaveBeenCalled();
  });

  it('calls PostHog capture when productTelemetry is present and key is set', async () => {
    mockCapturePostHogEvent.mockClear();
    const headers = await makeAuthHeaders();
    const env = makeEnv({
      posthogKey: 'phc_test',
      hyperdriveConnectionString: 'postgresql://fake',
    });

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ productTelemetry: makeProductTelemetry() })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(mockCapturePostHogEvent).toHaveBeenCalledTimes(1);

    const captured = mockCapturePostHogEvent.mock.calls[0][0];
    expect(captured.apiKey).toBe('phc_test');
    expect(captured.distinctId).toBe('user@example.com');
    expect(captured.event).toBe('kc_instance_product_telemetry');
    expect(captured.properties?.defaultModel).toBe('kilocode/anthropic/claude-opus-4.6');
    expect(captured.properties?.channelCount).toBe(2);
    expect(captured.properties?.enabledChannels).toEqual(['telegram', 'discord']);
    expect(captured.properties?.sandboxId).toBe(sandboxId);
    expect(captured.properties?.flyRegion).toBe('dfw');
    expect(captured.properties?.userId).toBe('user-1');
  });

  it('falls back to userId as distinctId when Hyperdrive is unavailable', async () => {
    mockCapturePostHogEvent.mockClear();
    const headers = await makeAuthHeaders();
    const env = makeEnv({ posthogKey: 'phc_test' }); // no hyperdriveConnectionString

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ productTelemetry: makeProductTelemetry() })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(mockCapturePostHogEvent).toHaveBeenCalledTimes(1);
    expect(mockCapturePostHogEvent.mock.calls[0][0].distinctId).toBe('user-1');
  });

  it('returns 204 even when PostHog capture throws', async () => {
    mockCapturePostHogEvent.mockClear();
    mockCapturePostHogEvent.mockRejectedValueOnce(new Error('PostHog timeout'));
    const headers = await makeAuthHeaders();
    const env = makeEnv({
      posthogKey: 'phc_test',
      hyperdriveConnectionString: 'postgresql://fake',
    });

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ productTelemetry: makeProductTelemetry() })),
      },
      env
    );

    expect(response.status).toBe(204);
  });

  it('calls tryMarkInstanceReady when loadAvg5m is below threshold', async () => {
    const tryMarkInstanceReady = vi.fn().mockResolvedValue({ shouldNotify: false, userId: null });
    const env = makeEnv({ tryMarkInstanceReady });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ loadAvg5m: 0.05 })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(tryMarkInstanceReady).toHaveBeenCalledTimes(1);
  });

  it('does not call tryMarkInstanceReady when loadAvg5m is above threshold', async () => {
    const tryMarkInstanceReady = vi.fn();
    const env = makeEnv({ tryMarkInstanceReady });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ loadAvg5m: 0.5 })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(tryMarkInstanceReady).not.toHaveBeenCalled();
  });

  it('does not fail checkin when tryMarkInstanceReady throws', async () => {
    const tryMarkInstanceReady = vi.fn().mockRejectedValue(new Error('DO error'));
    const env = makeEnv({ tryMarkInstanceReady });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ loadAvg5m: 0.05 })),
      },
      env
    );

    expect(response.status).toBe(204);
  });

  it('includes instanceId when dispatching instance-ready notifications for instance-keyed sandboxes', async () => {
    const tryMarkInstanceReady = vi.fn().mockResolvedValue({ shouldNotify: true, userId: null });
    const env = makeEnv({ tryMarkInstanceReady, internalApiSecret: 'internal-secret' });
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const instanceSandboxId = 'ki_11111111111141118111111111111111';
    const headers = await makeAuthHeaders(instanceSandboxId);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ sandboxId: instanceSandboxId, loadAvg5m: 0.05 })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://kilo.test/api/internal/kiloclaw/instance-ready',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': 'internal-secret',
        },
        body: JSON.stringify({
          userId: 'user-1',
          sandboxId: instanceSandboxId,
          instanceId,
          shouldNotify: true,
        }),
      }
    );
  });

  it('still dispatches instance-ready notification when the one-time email gate is closed', async () => {
    const tryMarkInstanceReady = vi.fn().mockResolvedValue({ shouldNotify: false, userId: null });
    const env = makeEnv({ tryMarkInstanceReady, internalApiSecret: 'internal-secret' });
    const headers = await makeAuthHeaders();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const response = await controller.request(
      '/checkin',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(makeBody({ loadAvg5m: 0.05 })),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://kilo.test/api/internal/kiloclaw/instance-ready',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': 'internal-secret',
        },
        body: JSON.stringify({
          userId: 'user-1',
          sandboxId,
          shouldNotify: false,
        }),
      }
    );
  });
});

describe('POST /google/token', () => {
  beforeEach(() => {
    mockGetInstanceBySandboxId.mockReset();
    mockGetGoogleOAuthConnectionByInstanceId.mockReset();
    mockUpdateGoogleOAuthConnectionTokenData.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when auth headers are missing', async () => {
    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(401);
  });

  it('returns 401 when authorization header is malformed', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers: {
          ...headers,
          authorization: 'Token kilo-key-1',
        },
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when gateway token is invalid', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers: {
          ...headers,
          'x-kiloclaw-gateway-token': 'wrong-token',
        },
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(403);
  });

  it('returns 401 when authorization header is malformed', async () => {
    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Token kilo-key-1',
          'x-kiloclaw-gateway-token': 'gateway-token',
        },
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: ['calendar_read'],
        }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when api key does not match durable object config', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: ['calendar_read'],
        }),
      },
      makeEnv({
        hyperdriveConnectionString: 'postgres://example',
        kilocodeApiKey: 'different-key',
      })
    );

    expect(response.status).toBe(403);
  });

  it('returns migrated false when kilo_owned connection is already active with same grants', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const execute = vi.fn().mockResolvedValue(undefined);
    mockGetWorkerDb.mockReturnValue({ execute });
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(
      makeGoogleConnection(encryptionKey, {
        id: 'conn-kilo',
        credential_profile: 'kilo_owned',
        status: 'active',
        capabilities: ['calendar_read'],
        grants_by_source: { oauth: ['calendar_read'] },
      })
    );

    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: [],
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      migrated: false,
      reason: 'kilo_owned_already_active',
    });
    expect(mockUpdateGoogleOAuthConnectionTokenData).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).not.toHaveBeenCalled();
  });

  it('returns 403 when api key does not match durable object config', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      makeEnv({
        hyperdriveConnectionString: 'postgres://example',
        kilocodeApiKey: 'different-key',
      })
    );

    expect(response.status).toBe(403);
  });

  it('returns 400 when capabilities is an empty list', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: [] }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(400);
  });

  it('returns 404 when no google oauth connection exists for the instance', async () => {
    const env = makeEnv({ hyperdriveConnectionString: 'postgres://example' });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(null);

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      env
    );

    expect(response.status).toBe(404);
  });

  it('returns 409 when connection is not active', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(
      makeGoogleConnection(encryptionKey, { status: 'action_required' })
    );

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      env
    );

    expect(response.status).toBe(409);
  });

  it('returns 412 when requested capability is not granted', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(
      makeGoogleConnection(encryptionKey, { capabilities: ['calendar_read'] })
    );

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['drive_read'] }),
      },
      env
    );

    expect(response.status).toBe(412);
  });

  it('returns 400 when unsupported capabilities are requested', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(makeGoogleConnection(encryptionKey));

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['unsupported_capability'] }),
      },
      env
    );

    expect(response.status).toBe(400);
  });

  it('returns an access token for active calendar oauth connections', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(makeGoogleConnection(encryptionKey));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'ya29.test',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.readonly',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      env
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(
      expect.objectContaining({
        accessToken: 'ya29.test',
        accountEmail: 'user@example.com',
      })
    );
    const scopes = (payload as { scopes?: unknown }).scopes;
    expect(Array.isArray(scopes)).toBe(true);
    expect(mockUpdateGoogleOAuthConnectionTokenData).toHaveBeenCalledWith(
      expect.any(Object),
      'instance-1',
      expect.objectContaining({ status: 'active' })
    );
    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' })
    );
  });

  it('marks oauth connection action_required on invalid_grant', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(makeGoogleConnection(encryptionKey));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired' }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      env
    );

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toEqual(expect.objectContaining({ reason: 'invalid_grant' }));
    expect(mockUpdateGoogleOAuthConnectionTokenData).toHaveBeenCalledWith(
      expect.any(Object),
      'instance-1',
      expect.objectContaining({ status: 'action_required' })
    );
    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'action_required' })
    );
  });

  it('marks oauth connection action_required on deleted_client', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(makeGoogleConnection(encryptionKey));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'deleted_client', error_description: 'client is deleted' }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(mockUpdateGoogleOAuthConnectionTokenData).toHaveBeenCalledWith(
      expect.any(Object),
      'instance-1',
      expect.objectContaining({ status: 'action_required' })
    );
    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'action_required' })
    );
  });

  it('returns 502 on unmapped google refresh errors without flipping status', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(makeGoogleConnection(encryptionKey));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    );

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      env
    );

    expect(response.status).toBe(502);
    expect(mockUpdateGoogleOAuthConnectionTokenData).not.toHaveBeenCalledWith(
      {},
      'instance-1',
      expect.objectContaining({ status: 'action_required' })
    );
  });

  it('marks oauth connection action_required when refresh token decryption fails', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(
      makeGoogleConnection(encryptionKey, { refresh_token_encrypted: 'not-encrypted-token' })
    );

    const response = await controller.request(
      '/google/token',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId, capabilities: ['calendar_read'] }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(mockUpdateGoogleOAuthConnectionTokenData).toHaveBeenCalledWith(
      expect.any(Object),
      'instance-1',
      expect.objectContaining({
        status: 'action_required',
        lastError: 'refresh_token_decryption_failed',
      })
    );
    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'action_required',
        lastError: 'refresh_token_decryption_failed',
      })
    );
  });
});

describe('POST /google/status', () => {
  beforeEach(() => {
    mockGetInstanceBySandboxId.mockReset();
    mockGetGoogleOAuthConnectionByInstanceId.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when auth headers are missing', async () => {
    const response = await controller.request(
      '/google/status',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when gateway token is invalid', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/status',
      {
        method: 'POST',
        headers: {
          ...headers,
          'x-kiloclaw-gateway-token': 'wrong-token',
        },
        body: JSON.stringify({ sandboxId }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(403);
  });

  it('returns disconnected payload when no row exists', async () => {
    const env = makeEnv({ hyperdriveConnectionString: 'postgres://example' });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(null);

    const response = await controller.request(
      '/google/status',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ connected: false, accounts: [] });
  });

  it('returns connected false for non-active status while listing account', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({ hyperdriveConnectionString: 'postgres://example' });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(
      makeGoogleConnection(encryptionKey, { status: 'action_required' })
    );

    const response = await controller.request(
      '/google/status',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId }),
      },
      env
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(
      expect.objectContaining({
        connected: false,
        accounts: [
          expect.objectContaining({ email: 'user@example.com', status: 'action_required' }),
        ],
      })
    );
  });

  it('returns connected true when status is active', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({ hyperdriveConnectionString: 'postgres://example' });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(makeGoogleConnection(encryptionKey));

    const response = await controller.request(
      '/google/status',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sandboxId }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ connected: true, accounts: [expect.any(Object)] })
    );
  });
});

describe('POST /google/migrate-legacy', () => {
  beforeEach(() => {
    mockGetWorkerDb.mockReset().mockReturnValue({ execute: vi.fn().mockResolvedValue(undefined) });
    mockGetInstanceBySandboxId.mockReset();
    mockGetGoogleOAuthConnectionByInstanceId.mockReset();
    mockUpdateGoogleOAuthConnectionTokenData.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when auth headers are missing', async () => {
    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: ['calendar_read'],
        }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when gateway token is invalid', async () => {
    const headers = await makeAuthHeaders();
    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers: {
          ...headers,
          'x-kiloclaw-gateway-token': 'wrong-token',
        },
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: ['calendar_read'],
        }),
      },
      makeEnv({ hyperdriveConnectionString: 'postgres://example' })
    );

    expect(response.status).toBe(403);
  });

  it('inserts a legacy oauth row when none exists and mirrors active status to DO', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const execute = vi.fn().mockResolvedValue(undefined);
    mockGetWorkerDb.mockReturnValue({ execute });
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValueOnce(null).mockResolvedValueOnce(
      makeGoogleConnection(encryptionKey, {
        credential_profile: 'legacy',
        account_email: 'legacy@example.com',
        account_subject: 'legacy-subject',
        oauth_client_id: 'legacy-client-id',
        oauth_client_secret_encrypted: encryptWithSymmetricKey(
          'legacy-client-secret',
          encryptionKey
        ),
        refresh_token_encrypted: encryptWithSymmetricKey('legacy-refresh-token', encryptionKey),
        grants_by_source: { legacy: ['calendar_read'] },
        capabilities: ['calendar_read'],
        status: 'active',
      })
    );

    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: ['calendar_read'],
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ migrated: true, profile: 'legacy' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mockUpdateGoogleOAuthConnectionTokenData).not.toHaveBeenCalled();
    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' })
    );
  });

  it('does not clobber concurrent kilo_owned row when migration insert conflicts', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const execute = vi.fn().mockResolvedValue(undefined);
    mockGetWorkerDb.mockReturnValue({ execute });
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValueOnce(null).mockResolvedValueOnce(
      makeGoogleConnection(encryptionKey, {
        credential_profile: 'kilo_owned',
        account_email: 'existing@example.com',
        account_subject: 'existing-subject',
        capabilities: ['calendar_read'],
        grants_by_source: { oauth: ['calendar_read'] },
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        status: 'action_required',
        last_error: 'invalid_grant',
      })
    );

    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: [
            'https://www.googleapis.com/auth/calendar.readonly',
            'https://www.googleapis.com/auth/gmail.readonly',
          ],
          capabilities: ['gmail_read'],
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ migrated: true, profile: 'kilo_owned' });
    expect(mockUpdateGoogleOAuthConnectionTokenData).not.toHaveBeenCalled();

    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'action_required',
        accountEmail: 'existing@example.com',
        accountSubject: 'existing-subject',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        capabilities: ['calendar_read', 'gmail_read'],
        lastError: 'invalid_grant',
      })
    );
  });

  it('updates an existing legacy row in place and mirrors active status to DO', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const execute = vi.fn().mockResolvedValue(undefined);
    mockGetWorkerDb.mockReturnValue({ execute });
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue(
      makeGoogleConnection(encryptionKey, {
        id: 'conn-legacy',
        credential_profile: 'legacy',
        oauth_client_id: 'legacy-client-id',
        oauth_client_secret_encrypted: encryptWithSymmetricKey(
          'legacy-client-secret',
          encryptionKey
        ),
        grants_by_source: { legacy: ['calendar_read'] },
      })
    );

    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: ['calendar_read', 'gmail_read'],
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ migrated: true, profile: 'legacy' });
    expect(mockUpdateGoogleOAuthConnectionTokenData).toHaveBeenCalledWith(
      expect.any(Object),
      'instance-1',
      expect.objectContaining({
        credentialProfile: 'legacy',
        status: 'active',
      })
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' })
    );
  });

  it('merges legacy grants into an existing kilo_owned connection without overwriting token profile', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue({
      id: 'conn-1',
      instance_id: 'instance-1',
      provider: 'google',
      account_email: 'existing@example.com',
      account_subject: 'existing-subject',
      credential_profile: 'kilo_owned',
      refresh_token_encrypted: encryptWithSymmetricKey('refresh-token-1', encryptionKey),
      oauth_client_secret_encrypted: null,
      oauth_client_id: 'oauth-client-id',
      capabilities: ['calendar_read'],
      grants_by_source: { oauth: ['calendar_read'] },
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      status: 'active',
    });

    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: [
            'https://www.googleapis.com/auth/calendar.readonly',
            'https://www.googleapis.com/auth/gmail.readonly',
          ],
          capabilities: ['calendar_read', 'gmail_read'],
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ migrated: true, profile: 'kilo_owned' });
    expect(mockUpdateGoogleOAuthConnectionTokenData).not.toHaveBeenCalled();

    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        accountEmail: 'existing@example.com',
        accountSubject: 'existing-subject',
        capabilities: ['calendar_read', 'gmail_read'],
      })
    );
  });

  it('preserves non-active kilo_owned status/scopes/error while merging legacy grants into DO state', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue({
      id: 'conn-1',
      instance_id: 'instance-1',
      provider: 'google',
      account_email: 'existing@example.com',
      account_subject: 'existing-subject',
      credential_profile: 'kilo_owned',
      refresh_token_encrypted: encryptWithSymmetricKey('refresh-token-1', encryptionKey),
      oauth_client_secret_encrypted: null,
      oauth_client_id: 'oauth-client-id',
      capabilities: ['calendar_read'],
      grants_by_source: { oauth: ['calendar_read'] },
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      status: 'action_required',
      last_error: 'invalid_grant',
    });

    const response = await controller.request(
      '/google/migrate-legacy',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sandboxId,
          accountEmail: 'legacy@example.com',
          accountSubject: 'legacy-subject',
          oauthClientId: 'legacy-client-id',
          oauthClientSecret: 'legacy-client-secret',
          refreshToken: 'legacy-refresh-token',
          scopes: [
            'https://www.googleapis.com/auth/calendar.readonly',
            'https://www.googleapis.com/auth/gmail.readonly',
          ],
          capabilities: ['calendar_read', 'gmail_read'],
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ migrated: true, profile: 'kilo_owned' });
    expect(mockUpdateGoogleOAuthConnectionTokenData).not.toHaveBeenCalled();

    const instanceStub = getInstanceStub(env);
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'action_required',
        accountEmail: 'existing@example.com',
        accountSubject: 'existing-subject',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        capabilities: ['calendar_read', 'gmail_read'],
        lastError: 'invalid_grant',
      })
    );
  });
});
