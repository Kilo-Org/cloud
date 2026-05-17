import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';
import * as fly from '../fly/client';
import type * as FlyClient from '../fly/client';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock('../fly/client', async () => {
  const actual = await vi.importActual<typeof FlyClient>('../fly/client');
  return {
    ...actual,
    getMachine: vi.fn(),
  };
});

/**
 * Coverage for the polling-endpoint short-circuit guard in
 * services/kiloclaw/src/routes/platform.ts (`shortCircuitIfNotRunning`).
 *
 * Background: Fly's HTTPS edge proxy will wake a stopped machine to serve
 * a request even when `services[0].autostart: false` is set, because the
 * flag is treated as a hint rather than a guarantee in single-machine apps.
 * The admin UI polls runtime-status endpoints every ~10s. Without the guard,
 * each poll while stopped causes the proxy to resurrect the machine,
 * making any "stop and perform stopped-only operation" workflow (resize,
 * tier change, volume work) effectively unusable.
 *
 * The guard has two layers:
 *
 * 1. Cheap DO cached-state read. Catches the common case where DO and Fly
 *    agree, plus admin-UI-initiated stops where the DO has already updated
 *    its cached state.
 *
 * 2. Live Fly Machines API check, only when the DO says `running`. Catches
 *    drift cases: out-of-band stops (Fly CLI, dashboard, health crash) and
 *    in-flight stops where `DO.stop()` is still waiting on
 *    `Fly.stopMachine` (DO state stays `running` until that call returns,
 *    so a concurrent poll would otherwise fall through). The Machines REST
 *    API call does NOT go through Fly's HTTPS edge proxy and does not wake
 *    the machine.
 *
 * Fail-open on Fly API errors so a Fly outage degrades to current behavior
 * rather than breaking polling globally.
 */

const FLY_API_TOKEN = 'test-token';

function envWith(stubFields: Record<string, unknown>, opts?: { flyApiToken?: string | null }) {
  // Default to having FLY_API_TOKEN so the Fly verification layer exercises
  // by default. Pass `flyApiToken: null` to simulate dev environments
  // without Fly creds (Fly check is skipped, DO state trusted).
  const flyApiToken = opts?.flyApiToken === undefined ? FLY_API_TOKEN : opts.flyApiToken;
  return {
    FLY_API_TOKEN: flyApiToken ?? undefined,
    KILOCLAW_INSTANCE: {
      idFromName: (id: string) => id,
      get: () => stubFields,
    },
    KILOCLAW_AE: { writeDataPoint: vi.fn() },
    KV_CLAW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
    },
  } as never;
}

const runningStatus = {
  status: 'running',
  provider: 'fly',
  flyMachineId: 'm-1',
  flyAppName: 'app-1',
};

beforeEach(() => {
  vi.mocked(fly.getMachine).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Sentinel shape per route. Most guarded routes return the unified
// `{ ok, reason, status }` shape, but `/gateway/ready` keeps its existing
// `{ ready, reason, status }` shape so consumers that already check
// `gatewayReady?.ready` keep working unchanged. Parameterising this lets
// the same matrix exercise both shapes.
type SentinelBuilder = (status: string | null) => Record<string, unknown>;
const unifiedSentinel: SentinelBuilder = status => ({
  ok: false,
  reason: 'instance_not_running',
  status,
});
const readySentinel: SentinelBuilder = status => ({
  ready: false,
  reason: 'instance_not_running',
  status,
});

describe('polling endpoint short-circuit guard', () => {
  describe.each([
    {
      path: '/gateway/status?userId=user-1',
      proxiedMethod: 'getGatewayProcessStatus' as const,
      okPayload: { state: 'running', pid: 42, uptime: 10, restarts: 0, lastExit: null },
      sentinelFor: unifiedSentinel,
    },
    {
      path: '/controller-version?userId=user-1',
      proxiedMethod: 'getControllerVersion' as const,
      okPayload: { version: '2026.5.12', commit: 'abc' },
      sentinelFor: unifiedSentinel,
    },
    {
      path: '/morning-briefing/status?userId=user-1',
      proxiedMethod: 'getMorningBriefingStatus' as const,
      okPayload: { ok: true, enabled: true, reconcileState: 'idle' },
      sentinelFor: unifiedSentinel,
    },
    {
      // /gateway/ready is polled every 5s on the user dashboard — the
      // highest-frequency wake vector. Shares the same guard but returns
      // a ready-shaped sentinel rather than the unified one.
      path: '/gateway/ready?userId=user-1',
      proxiedMethod: 'getGatewayReady' as const,
      okPayload: { ready: true, settled: true },
      sentinelFor: readySentinel,
    },
  ])('$path', ({ path, proxiedMethod, okPayload, sentinelFor }) => {
    describe('layer 1: DO cached state says not running', () => {
      it('returns the sentinel and skips both proxy and Fly API when DO says stopped', async () => {
        const getStatus = vi.fn().mockResolvedValue({ status: 'stopped', provider: 'fly' });
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(sentinelFor('stopped'));
        // No proxy traffic.
        expect(proxiedFn).not.toHaveBeenCalled();
        // No Fly API call either — the cheap DO check was enough.
        expect(vi.mocked(fly.getMachine)).not.toHaveBeenCalled();
      });

      it('short-circuits on transient states (starting, stopping, restarting)', async () => {
        const getStatus = vi.fn().mockResolvedValue({ status: 'starting', provider: 'fly' });
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(sentinelFor('starting'));
        expect(proxiedFn).not.toHaveBeenCalled();
        expect(vi.mocked(fly.getMachine)).not.toHaveBeenCalled();
      });
    });

    describe('layer 2: DO says running, verify live Fly state', () => {
      it('forwards when Fly also reports started', async () => {
        const getStatus = vi.fn().mockResolvedValue(runningStatus);
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        vi.mocked(fly.getMachine).mockResolvedValue({ state: 'started' } as never);
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(vi.mocked(fly.getMachine)).toHaveBeenCalledTimes(1);
        expect(proxiedFn).toHaveBeenCalledTimes(1);
        expect(await response.json()).toMatchObject(okPayload);
      });

      it('returns the sentinel when Fly reports stopped (DO state is stale)', async () => {
        // Out-of-band stop scenario: someone hit Stop in the Fly dashboard
        // or Fly's health check killed the machine. DO cache still says
        // running but Fly is authoritative.
        const getStatus = vi.fn().mockResolvedValue(runningStatus);
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        vi.mocked(fly.getMachine).mockResolvedValue({ state: 'stopped' } as never);
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(sentinelFor('stopped'));
        // Critical: no proxy traffic. This is what prevents the wake.
        expect(proxiedFn).not.toHaveBeenCalled();
      });

      it.each([
        ['stopping', 'stopped'],
        ['suspended', 'stopped'],
        ['failed', 'stopped'],
        ['destroying', 'stopped'],
        ['starting', 'starting'],
        ['created', 'starting'],
        ['replacing', 'starting'],
      ])('Fly state %s maps to sentinel status %s', async (flyState, expectedStatus) => {
        const getStatus = vi.fn().mockResolvedValue(runningStatus);
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        vi.mocked(fly.getMachine).mockResolvedValue({ state: flyState } as never);
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(sentinelFor(expectedStatus));
        expect(proxiedFn).not.toHaveBeenCalled();
      });

      it('fails open when the Fly API throws — trust DO state, forward request, log warning', async () => {
        // Trade-off: failing closed during Fly API outages would break
        // polling for every customer. Failing open re-introduces the wake
        // bug only when DO state is also stale AND Fly is down — narrow
        // intersection. Warning log makes the failure visible.
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const getStatus = vi.fn().mockResolvedValue(runningStatus);
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        vi.mocked(fly.getMachine).mockRejectedValue(new Error('Fly API 503'));
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(proxiedFn).toHaveBeenCalledTimes(1);
        expect(await response.json()).toMatchObject(okPayload);
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Fly state check failed'),
          expect.objectContaining({ error: 'Fly API 503' })
        );
      });
    });

    describe('layer 2 is skipped when Fly state is not verifiable', () => {
      it('skips the Fly check when the instance has no flyMachineId (e.g. pre-provisioning)', async () => {
        const getStatus = vi.fn().mockResolvedValue({
          status: 'running',
          provider: 'fly',
          flyMachineId: null,
          flyAppName: null,
        });
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(vi.mocked(fly.getMachine)).not.toHaveBeenCalled();
        expect(proxiedFn).toHaveBeenCalledTimes(1);
      });

      it('skips the Fly check for non-Fly providers (docker-local, northflank)', async () => {
        const getStatus = vi.fn().mockResolvedValue({
          status: 'running',
          provider: 'northflank',
          flyMachineId: null,
          flyAppName: null,
        });
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(vi.mocked(fly.getMachine)).not.toHaveBeenCalled();
        expect(proxiedFn).toHaveBeenCalledTimes(1);
      });

      it('skips the Fly check when FLY_API_TOKEN is not configured (dev environments)', async () => {
        const getStatus = vi.fn().mockResolvedValue(runningStatus);
        const proxiedFn = vi.fn().mockResolvedValue(okPayload);
        const env = envWith({ getStatus, [proxiedMethod]: proxiedFn }, { flyApiToken: null });

        const response = await platform.request(path, {}, env);

        expect(response.status).toBe(200);
        expect(vi.mocked(fly.getMachine)).not.toHaveBeenCalled();
        expect(proxiedFn).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('debug-status reads DO storage only (no proxy hop) and is NOT guarded', async () => {
    // `getDebugState` is a pure DO storage read — it does not proxy through
    // Fly's edge to port 18789, so the wake-up bug doesn't apply. The guard
    // is intentionally absent on this route, including the Fly verification
    // layer.
    const getStatus = vi.fn().mockResolvedValue({ status: 'stopped', provider: 'fly' });
    const getDebugState = vi.fn().mockResolvedValue({
      userId: 'user-1',
      status: 'stopped',
      flyMachineId: 'm1',
    });
    const env = envWith({ getStatus, getDebugState });

    const response = await platform.request('/debug-status?userId=user-1', {}, env);

    expect(response.status).toBe(200);
    expect(getDebugState).toHaveBeenCalledTimes(1);
    expect(getStatus).not.toHaveBeenCalled();
    expect(vi.mocked(fly.getMachine)).not.toHaveBeenCalled();
  });
});
