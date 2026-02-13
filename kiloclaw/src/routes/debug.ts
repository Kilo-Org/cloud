import { Hono } from 'hono';
import type { AppEnv } from '../types';
import * as fly from '../fly/client';
import type { FlyClientConfig } from '../fly/client';

/**
 * Debug routes for inspecting Fly Machine state.
 *
 * All debug routes require a ?sandboxId= or ?machineId= query parameter.
 * Gated by debugRoutesGate (internal API key or debug secret).
 */
const debug = new Hono<AppEnv>();

function getFlyConfig(env: AppEnv['Bindings']): FlyClientConfig | null {
  if (!env.FLY_API_TOKEN || !env.FLY_APP_NAME) return null;
  return { apiToken: env.FLY_API_TOKEN, appName: env.FLY_APP_NAME };
}

// GET /debug/machine - Get machine state from Fly API
debug.get('/machine', async c => {
  const machineId = c.req.query('machineId');
  if (!machineId) return c.json({ error: 'machineId query parameter is required' }, 400);

  const flyConfig = getFlyConfig(c.env);
  if (!flyConfig) return c.json({ error: 'Fly API not configured' }, 503);

  try {
    const machine = await fly.getMachine(flyConfig, machineId);
    return c.json(machine);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/gateway-api - Probe the OpenClaw gateway HTTP API via Fly Proxy
debug.get('/gateway-api', async c => {
  const machineId = c.req.query('machineId');
  if (!machineId) return c.json({ error: 'machineId query parameter is required' }, 400);

  const flyConfig = getFlyConfig(c.env);
  if (!flyConfig) return c.json({ error: 'Fly API not configured' }, 503);

  const path = c.req.query('path') || '/';

  try {
    const url = `https://${flyConfig.appName}.fly.dev${path}`;
    const response = await fetch(url, {
      headers: {
        'fly-force-instance-id': machineId,
      },
    });
    const contentType = response.headers.get('content-type') || '';

    let body: string | object;
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return c.json({ path, status: response.status, contentType, body });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, path }, 500);
  }
});

// GET /debug/ws-test - Interactive WebSocket debug page
debug.get('/ws-test', async c => {
  const host = c.req.header('host') || 'localhost';
  const protocol = c.req.header('x-forwarded-proto') || 'https';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>WebSocket Debug</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1a1a1a; color: #0f0; }
    #log { white-space: pre-wrap; background: #000; padding: 10px; height: 400px; overflow-y: auto; border: 1px solid #333; }
    button { margin: 5px; padding: 10px; }
    input { padding: 10px; width: 300px; }
    .error { color: #f00; }
    .sent { color: #0ff; }
    .received { color: #0f0; }
    .info { color: #ff0; }
  </style>
</head>
<body>
  <h1>WebSocket Debug Tool</h1>
  <div>
    <button id="connect">Connect</button>
    <button id="disconnect" disabled>Disconnect</button>
    <button id="clear">Clear Log</button>
  </div>
  <div style="margin: 10px 0;">
    <input id="message" placeholder="JSON message to send..." />
    <button id="send" disabled>Send</button>
  </div>
  <div id="log"></div>
  
  <script>
    const wsUrl = '${wsProtocol}://${host}/';
    let ws = null;
    
    const log = (msg, className = '') => {
      const logEl = document.getElementById('log');
      const time = new Date().toISOString().substr(11, 12);
      logEl.innerHTML += '<span class="' + className + '">[' + time + '] ' + msg + '</span>\\n';
      logEl.scrollTop = logEl.scrollHeight;
    };
    
    document.getElementById('connect').onclick = () => {
      log('Connecting to ' + wsUrl + '...', 'info');
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        log('Connected!', 'info');
        document.getElementById('connect').disabled = true;
        document.getElementById('disconnect').disabled = false;
        document.getElementById('send').disabled = false;
      };
      ws.onmessage = (e) => log('RECV: ' + e.data, 'received');
      ws.onerror = (e) => log('ERROR: ' + JSON.stringify(e), 'error');
      ws.onclose = (e) => {
        log('Closed: code=' + e.code + ' reason=' + e.reason, 'info');
        document.getElementById('connect').disabled = false;
        document.getElementById('disconnect').disabled = true;
        document.getElementById('send').disabled = true;
        ws = null;
      };
    };
    
    document.getElementById('disconnect').onclick = () => { if (ws) ws.close(); };
    document.getElementById('clear').onclick = () => { document.getElementById('log').innerHTML = ''; };
    document.getElementById('send').onclick = () => {
      const msg = document.getElementById('message').value;
      if (ws && msg) { log('SEND: ' + msg, 'sent'); ws.send(msg); }
    };
    document.getElementById('message').onkeypress = (e) => {
      if (e.key === 'Enter') document.getElementById('send').click();
    };
  </script>
</body>
</html>`;

  return c.html(html);
});

// GET /debug/env - Show environment configuration (sanitized)
debug.get('/env', async c => {
  return c.json({
    has_kilocode_base_url_override: !!c.env.KILOCODE_API_BASE_URL,
    has_fly_api_token: !!c.env.FLY_API_TOKEN,
    fly_app_name: c.env.FLY_APP_NAME ?? null,
    fly_region: c.env.FLY_REGION ?? null,
    dev_mode: c.env.DEV_MODE,
    debug_routes: c.env.DEBUG_ROUTES,
  });
});

export { debug };
