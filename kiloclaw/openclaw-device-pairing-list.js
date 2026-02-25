#!/usr/bin/env node
// List pending device pairing requests.
// Called via Fly exec from the worker. Outputs a single JSON blob:
// { "requests": [{ "requestId": "...", "deviceId": "...", "role": "operator", ... }] }
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Fly exec sets HOME=/ — hardcode to /root where openclaw config and pairing store live
process.env.HOME = '/root';

(async () => {
  const { stdout } = await execFileAsync('/usr/local/bin/openclaw', ['devices', 'list', '--json'], {
    encoding: 'utf8',
    timeout: 45000,
    env: { ...process.env, HOME: '/root' },
  });

  const data = JSON.parse(stdout.trim());
  const pending = Array.isArray(data.pending) ? data.pending : [];

  // Strip sensitive fields (publicKey) before returning to the worker
  const requests = pending.map(req => ({
    requestId: req.requestId,
    deviceId: req.deviceId,
    role: req.role,
    platform: req.platform,
    clientId: req.clientId,
    ts: req.ts,
  }));

  console.log(JSON.stringify({ requests }));
})().catch(err => {
  const stderr = err && err.stderr ? err.stderr.toString().trim() : '';
  const msg = stderr || String(err);
  process.stderr.write(`[device-pairing-list] fatal: ${msg}\n`);
  console.log(JSON.stringify({ requests: [] }));
  process.exitCode = 1;
});
