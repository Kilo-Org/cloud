import { describe, expect, it, vi, type Mock } from 'vitest';
import { controller } from './controller';
import { deriveGatewayToken } from '../auth/gateway-token';

vi.mock('cloudflare:workers', () => ({
  waitUntil: (p: Promise<unknown>) => p,
}));

vi.mock('../db', () => ({
  getWorkerDb: () => ({}),
  findEmailByUserId: vi.fn().mockResolvedValue('user@example.com'),
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
  writeDataPoint?: (payload: unknown) => void;
  posthogKey?: string;
  hyperdriveConnectionString?: string;
  workerEnv?: string;
  tryMarkInstanceReady?: Mock;
  internalApiSecret?: string;
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
  const recordDiskStats = vi.fn().mockResolvedValue(undefined);
  const tryMarkInstanceReady =
    options?.tryMarkInstanceReady ??
    vi.fn().mockResolvedValue({ shouldNotify: false, userId: null });

  return {
    GATEWAY_TOKEN_SECRET: options?.gatewayTokenSecret ?? 'gateway-secret',
    WORKER_ENV: options?.workerEnv ?? 'production',
    INTERNAL_API_SECRET: options?.internalApiSecret,
    KILOCLAW_INSTANCE: {
      idFromName: (userId: string) => userId,
      get: () => ({ getConfig, getStatus, recordDiskStats, tryMarkInstanceReady }),
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

describe('POST /checkin', () => {
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
    const writeDataPoint = vi.fn();
    const env = makeEnv({ writeDataPoint });
    const headers = await makeAuthHeaders();

    const response = await controller.request(
      '/checkin',
      { method: 'POST', headers, body: JSON.stringify(makeBody()) },
      env
    );

    expect(response.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
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
