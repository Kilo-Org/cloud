import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerFileRoutes } from './routes/files';
import { registerKiloCliRunRoutes } from './routes/kilo-cli-run';
import { registerHealthRoute } from './routes/health';
import { registerConfigRoutes } from './routes/config';
import { createSupervisor } from './supervisor';
import type { ControllerStateRef } from './bootstrap';

const TOKEN = 'test-token';

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TOKEN}` };
}

describe('degraded route availability', () => {
  it('keeps recovery routes available when degraded after route activation', async () => {
    const app = new Hono();
    const stateRef: ControllerStateRef = {
      current: { state: 'degraded', error: 'Startup failed during doctor' },
    };
    const supervisor = createSupervisor({ args: ['gateway', '--port', '3001'] });

    registerHealthRoute(app, supervisor, TOKEN, stateRef);
    registerConfigRoutes(app, supervisor, TOKEN);
    registerFileRoutes(app, TOKEN, '/root/.openclaw');
    registerKiloCliRunRoutes(app, TOKEN);

    const [healthResp, configResp, filesResp, cliResp] = await Promise.all([
      app.request('/_kilo/health'),
      app.request('/_kilo/config/read', { headers: authHeaders() }),
      app.request('/_kilo/files/tree', { headers: authHeaders() }),
      app.request('/_kilo/cli-run/status', { headers: authHeaders() }),
    ]);

    expect(healthResp.status).toBe(200);
    expect(configResp.status).not.toBe(503);
    expect(filesResp.status).not.toBe(503);
    expect(cliResp.status).toBe(200);
  });
});
