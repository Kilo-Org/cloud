import type { Context, Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { Supervisor } from '../supervisor';
import type { ControllerStateRef } from '../bootstrap';
import { CONTROLLER_COMMIT, CONTROLLER_VERSION } from '../version';
import { getBearerToken } from './gateway';
import { getOpenclawVersion } from '../openclaw-version';

export { parseOpenclawVersion } from '../openclaw-version';

export function registerHealthRoute(
  app: Hono,
  supervisor: Supervisor | null,
  expectedToken?: string,
  stateRef?: ControllerStateRef
): void {
  // Eagerly resolve so the first /_kilo/version request doesn't wait on the subprocess.
  void getOpenclawVersion();

  // /_kilo/health: returns controller lifecycle state for the CF worker.
  // Always returns HTTP 200 + status: 'ok' so Fly health probes stay happy.
  // Gateway process state is available separately via /_kilo/gateway/status (auth-gated).
  app.get('/_kilo/health', (c: Context) => {
    if (stateRef) {
      const s = stateRef.current;
      const base = { status: 'ok' as const };
      if (s.state === 'bootstrapping') {
        return c.json({ ...base, state: s.state, phase: s.phase });
      }
      if (s.state === 'degraded') {
        return c.json({ ...base, state: s.state, error: s.error });
      }
      return c.json({ ...base, state: s.state });
    }
    return c.json({ status: 'ok' });
  });

  // Bare /health for Fly probes — no state details, always 200.
  app.get('/health', (c: Context) => c.json({ status: 'ok' }));

  // Authenticated version/diagnostics endpoint.
  app.get('/_kilo/version', async c => {
    if (expectedToken) {
      const token = getBearerToken(c.req.header('authorization'));
      if (!timingSafeTokenEqual(token, expectedToken)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    const openclaw = await getOpenclawVersion();
    return c.json({
      version: CONTROLLER_VERSION,
      commit: CONTROLLER_COMMIT,
      openclawVersion: openclaw.version,
      openclawCommit: openclaw.commit,
      gateway: supervisor?.getStats() ?? null,
      ...(stateRef ? { controllerState: stateRef.current } : {}),
    });
  });
}
