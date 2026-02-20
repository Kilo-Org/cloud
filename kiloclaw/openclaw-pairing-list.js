#!/usr/bin/env node
// List pending pairing requests across all configured channels.
// Called via Fly exec from the worker. Outputs a single JSON blob:
// { "requests": [{ "code": "...", "id": "...", "channel": "telegram", ... }] }
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execFileAsync = promisify(execFile);

// Fly exec sets HOME=/ — hardcode to /root where openclaw config and pairing store live
process.env.HOME = '/root';

(async () => {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
  } catch {
    console.log(JSON.stringify({ requests: [] }));
    process.exit(0);
  }

  const ch = cfg.channels || {};
  const channels = [];
  if (ch.telegram?.enabled && ch.telegram?.botToken) channels.push('telegram');
  if (ch.discord?.enabled && ch.discord?.token) channels.push('discord');
  if (ch.slack?.enabled && (ch.slack?.botToken || ch.slack?.appToken)) channels.push('slack');

  const results = await Promise.allSettled(
    channels.map(async channel => {
      const { stdout } = await execFileAsync('openclaw', ['pairing', 'list', channel, '--json'], {
        encoding: 'utf8',
        timeout: 45000,
        env: { ...process.env, HOME: '/root' },
      });
      const data = JSON.parse(stdout.trim());
      return (data.requests || []).map(req => ({ ...req, channel }));
    })
  );

  const allRequests = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allRequests.push(...result.value);
    } else {
      const err = result.reason;
      const msg = err && err.stderr ? err.stderr.toString().trim() : String(err);
      process.stderr.write(`[pairing-list] ${channels[i]}: ${msg}\n`);
    }
  }

  console.log(JSON.stringify({ requests: allRequests }));
})().catch(err => {
  process.stderr.write(`[pairing-list] fatal: ${err}\n`);
  console.log(JSON.stringify({ requests: [] }));
  process.exitCode = 1;
});
