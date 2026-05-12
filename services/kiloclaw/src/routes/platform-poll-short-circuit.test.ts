import { describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

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
 * The guard short-circuits at the worker layer when DO state isn't
 * `running`, returning a 200 sentinel (mirrors the `/gateway/ready` pattern)
 * so the frontend's high-frequency polling doesn't generate a wall of 5xx
 * in logs / Sentry. The downstream DO method is never called, which means
 * no traffic ever reaches the Fly proxy for that machine.
 */

function envWith(stubFields: Record<string, unknown>) {
  return {
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

describe('polling endpoints short-circuit when DO state is not running', () => {
  describe.each([
    {
      path: '/gateway/status?userId=user-1',
      proxiedMethod: 'getGatewayProcessStatus' as const,
      okPayload: { state: 'running', pid: 42, uptime: 10, restarts: 0, lastExit: null },
    },
    {
      path: '/controller-version?userId=user-1',
      proxiedMethod: 'getControllerVersion' as const,
      okPayload: { version: '2026.5.12', commit: 'abc' },
    },
    {
      path: '/morning-briefing/status?userId=user-1',
      proxiedMethod: 'getMorningBriefingStatus' as const,
      okPayload: { ok: true, enabled: true, reconcileState: 'idle' },
    },
  ])('$path', ({ path, proxiedMethod, okPayload }) => {
    it('returns 200 sentinel and does NOT proxy to the machine when DO state is stopped', async () => {
      // Both methods are mocked so the test can assert the proxied one
      // is never invoked. If the guard ever regresses to forwarding while
      // stopped, this assertion fails.
      const getStatus = vi.fn().mockResolvedValue({ status: 'stopped' });
      const proxiedFn = vi.fn().mockResolvedValue(okPayload);
      const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

      const response = await platform.request(path, {}, env);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: false,
        reason: 'instance_not_running',
        status: 'stopped',
      });
      // Critical: no DO method that proxies to port 18789 was called.
      expect(proxiedFn).not.toHaveBeenCalled();
    });

    it('forwards the request and returns the OK payload when DO state is running', async () => {
      const getStatus = vi.fn().mockResolvedValue({ status: 'running' });
      const proxiedFn = vi.fn().mockResolvedValue(okPayload);
      const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

      const response = await platform.request(path, {}, env);

      expect(response.status).toBe(200);
      expect(proxiedFn).toHaveBeenCalledTimes(1);
      expect(await response.json()).toMatchObject(okPayload);
    });

    it('short-circuits on transient stopped states (starting, stopping, etc.)', async () => {
      // Any state other than `running` means the gateway controller process
      // is not guaranteed to be responsive; we'd rather return a stable
      // sentinel than risk an in-flight transition request waking the machine.
      const getStatus = vi.fn().mockResolvedValue({ status: 'starting' });
      const proxiedFn = vi.fn().mockResolvedValue(okPayload);
      const env = envWith({ getStatus, [proxiedMethod]: proxiedFn });

      const response = await platform.request(path, {}, env);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: false,
        reason: 'instance_not_running',
        status: 'starting',
      });
      expect(proxiedFn).not.toHaveBeenCalled();
    });
  });

  it('debug-status reads DO storage only (no proxy hop) and is NOT guarded', async () => {
    // `getDebugState` is a pure DO storage read — it does not proxy through
    // Fly's edge to port 18789, so the wake-up bug doesn't apply. The guard
    // is intentionally absent on this route.
    const getStatus = vi.fn().mockResolvedValue({ status: 'stopped' });
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
  });
});
