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

  it('returns an access token for active calendar oauth connections', async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const env = makeEnv({
      hyperdriveConnectionString: 'postgres://example',
      googleWorkspaceRefreshTokenEncryptionKey: encryptionKey,
    });
    const headers = await makeAuthHeaders();

    mockGetInstanceBySandboxId.mockResolvedValue({ id: 'instance-1' });
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue({
      instance_id: 'instance-1',
      provider: 'google',
      account_email: 'user@example.com',
      account_subject: 'google-subject-1',
      refresh_token_encrypted: encryptWithSymmetricKey('refresh-token-1', encryptionKey),
      capabilities: ['calendar_read'],
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      status: 'active',
    });

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
      {},
      'instance-1',
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
    mockGetGoogleOAuthConnectionByInstanceId.mockResolvedValue({
      instance_id: 'instance-1',
      provider: 'google',
      account_email: 'user@example.com',
      account_subject: 'google-subject-1',
      refresh_token_encrypted: encryptWithSymmetricKey('refresh-token-1', encryptionKey),
      capabilities: ['calendar_read'],
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      status: 'active',
    });

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
      {},
      'instance-1',
      expect.objectContaining({ status: 'action_required' })
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

    const instanceStub = (env as any).KILOCLAW_INSTANCE.get();
    expect(instanceStub.updateGoogleOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        accountEmail: 'existing@example.com',
        accountSubject: 'existing-subject',
        capabilities: ['calendar_read', 'gmail_read'],
      })
    );
  });
});
