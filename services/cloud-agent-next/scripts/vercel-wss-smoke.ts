#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VercelSandboxRestClient } from '../src/agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { parseVercelSandboxRuntimeConfig } from '../src/agent-sandbox/vercel/vercel-runtime-config.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_VARS_PATH = resolve(PACKAGE_ROOT, '.dev.vars');
const SMOKE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 45_000;

function parseDevVars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    vars[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
  }
  return vars;
}

function requireValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function log(message: string): void {
  process.stderr.write(`[wss-smoke] ${message}\n`);
}

const bunClientSource = `
const url = process.env.SANDBOX_CONTROL_URL;
const credential = process.env.SANDBOX_CONTROL_TOKEN;
const instanceId = process.env.SANDBOX_CONTROL_INSTANCE_ID;
if (!url || !credential || !instanceId) {
  console.error('missing env');
  process.exit(2);
}

function once(ws, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(type + ' timeout')), timeoutMs);
    ws.addEventListener(type, (event) => {
      clearTimeout(timer);
      resolve(event);
    }, { once: true });
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(event.error ?? new Error(type + ' error'));
    }, { once: true });
  });
}

async function handshake(label) {
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + credential } });
  await once(ws, 'open', 15000);
  const requestId = crypto.randomUUID();
  ws.send(JSON.stringify({
    type: 'request',
    requestId,
    operation: 'sandbox.hello',
    payload: { protocolVersion: 1, providerInstanceId: instanceId },
  }));
  const helloEvent = await once(ws, 'message', 15000);
  const hello = JSON.parse(String(helloEvent.data));
  if (hello.type !== 'response' || hello.requestId !== requestId || hello.ok !== true) {
    throw new Error(label + ' hello failed');
  }
  const statusEvent = await once(ws, 'message', 15000);
  const status = JSON.parse(String(statusEvent.data));
  if (status.type !== 'request' || status.operation !== 'sandbox.status') {
    throw new Error(label + ' missing status probe');
  }
  ws.send(JSON.stringify({ type: 'response', requestId: status.requestId, ok: true }));
  return ws;
}

const first = await handshake('first');
first.close();
await once(first, 'close', 5000);
const second = await handshake('reconnect');
second.close();
console.log('ok');
`;

async function main(): Promise<void> {
  const local = parseDevVars(readFileSync(DEV_VARS_PATH, 'utf8'));
  const workerHttpUrl = requireValue('WORKER_URL', process.env.WORKER_URL ?? local.WORKER_URL);
  const internalSecret = requireValue(
    'INTERNAL_API_SECRET',
    process.env.INTERNAL_API_SECRET ?? local.INTERNAL_API_SECRET
  );
  const runtime = parseVercelSandboxRuntimeConfig({
    VERCEL_TOKEN: process.env.VERCEL_TOKEN ?? local.VERCEL_TOKEN,
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID ?? local.VERCEL_TEAM_ID,
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID ?? local.VERCEL_PROJECT_ID,
    VERCEL_SANDBOX_SNAPSHOT_ID:
      process.env.VERCEL_SANDBOX_SNAPSHOT_ID ?? local.VERCEL_SANDBOX_SNAPSHOT_ID,
    VERCEL_SANDBOX_RUNTIME_BUILD_ID:
      process.env.VERCEL_SANDBOX_RUNTIME_BUILD_ID ?? local.VERCEL_SANDBOX_RUNTIME_BUILD_ID,
    VERCEL_SANDBOX_RUNTIME: process.env.VERCEL_SANDBOX_RUNTIME ?? local.VERCEL_SANDBOX_RUNTIME,
    VERCEL_SANDBOX_INITIAL_TIMEOUT_MS:
      process.env.VERCEL_SANDBOX_INITIAL_TIMEOUT_MS ?? local.VERCEL_SANDBOX_INITIAL_TIMEOUT_MS,
    VERCEL_SANDBOX_EXTEND_DURATION_MS:
      process.env.VERCEL_SANDBOX_EXTEND_DURATION_MS ?? local.VERCEL_SANDBOX_EXTEND_DURATION_MS,
  });
  if (!runtime) throw new Error('Vercel runtime config is incomplete');

  const sandboxId = `ses-wss-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const seedResponse = await fetch(
    `${workerHttpUrl.replace(/\/+$/, '')}/internal/sandbox-control/seed`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': internalSecret,
      },
      body: JSON.stringify({ sandboxId }),
    }
  );
  if (!seedResponse.ok) {
    throw new Error(`seed failed: ${seedResponse.status}`);
  }
  const seeded = (await seedResponse.json()) as { credential?: unknown };
  if (typeof seeded.credential !== 'string' || seeded.credential.length === 0) {
    throw new Error('seed did not return a credential');
  }

  const workerUrl = new URL(workerHttpUrl);
  workerUrl.protocol = workerUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  workerUrl.pathname = `/sandbox-control/${sandboxId}`;
  workerUrl.search = '';
  workerUrl.hash = '';

  const client = new VercelSandboxRestClient({
    accessToken: runtime.accessToken,
    teamId: runtime.teamId,
    projectId: runtime.projectId,
    fetch,
  });

  log(`creating vercel sandbox ${sandboxId}`);
  const created = await client.createSandbox({
    name: sandboxId,
    operationId: `wss-smoke-${sandboxId}`,
    runtimeBuildId: runtime.runtimeBuildId,
    snapshotId: runtime.snapshotId,
    runtime: runtime.runtime,
    timeoutMs: Math.min(runtime.initialTimeoutMs, SMOKE_TIMEOUT_MS),
  });
  const sessionId = created.session.id;
  try {
    log('running bun websocket client inside sandbox');
    const result = await client.executeCommand(sessionId, {
      command: 'bun',
      args: ['-e', bunClientSource],
      env: {
        SANDBOX_CONTROL_URL: workerUrl.toString(),
        SANDBOX_CONTROL_TOKEN: seeded.credential,
        SANDBOX_CONTROL_INSTANCE_ID: sessionId,
      },
      sudo: false,
      wait: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.finished.exitCode !== 0) {
      throw new Error(`sandbox client exited ${result.finished.exitCode}`);
    }
    log('pass: authenticated wss hello, status probe, drop, reconnect');
  } finally {
    log('stopping vercel sandbox');
    await client.stopSession(sessionId, sandboxId).catch(() => undefined);
  }
}

main().catch(error => {
  process.stderr.write(`[wss-smoke] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
