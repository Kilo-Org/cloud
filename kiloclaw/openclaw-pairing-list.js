#!/usr/bin/env node
// List pending pairing requests across all configured channels.
// Called via Fly exec from the worker. Outputs a single JSON blob:
// { "requests": [{ "code": "...", "id": "...", "channel": "telegram", ... }] }
const { execFileSync } = require('child_process');
const fs = require('fs');

// Fly exec sets HOME=/ — hardcode to /root where openclaw config and pairing store live
process.env.HOME = '/root';

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

const allRequests = [];
for (const channel of channels) {
  try {
    const output = execFileSync('openclaw', ['pairing', 'list', channel, '--json'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: '/root' },
    });
    const match = output.match(/\{"requests"[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      for (const req of data.requests || []) {
        allRequests.push({ ...req, channel });
      }
    }
  } catch (err) {
    // Log to stderr so the caller can see what went wrong
    const msg = err && err.stderr ? err.stderr.toString().trim() : String(err);
    process.stderr.write(`[pairing-list] ${channel}: ${msg}\n`);
  }
}

console.log(JSON.stringify({ requests: allRequests }));
