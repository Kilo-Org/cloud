#!/usr/bin/env node
// Locally approve KiloClaw's internal gateway-client device pairing request.
// This intentionally bypasses `openclaw devices approve`, which first attempts
// gateway RPC and can deadlock when gateway-client itself is blocked on pairing.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const OPENCLAW_DIST_DIR =
  process.env.OPENCLAW_DIST_DIR || '/usr/local/lib/node_modules/openclaw/dist';
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || '/root/.openclaw';
const PENDING_PATH = path.join(STATE_DIR, 'devices', 'pending.json');
const GATEWAY_CLIENT_ID = 'gateway-client';
const OPERATOR_ROLE = 'operator';
const FULL_OPERATOR_SCOPES = [
  'operator.read',
  'operator.admin',
  'operator.approvals',
  'operator.pairing',
  'operator.write',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roleList(entry) {
  const roles = new Set();
  if (Array.isArray(entry.roles)) {
    for (const role of entry.roles) {
      if (typeof role !== 'string') continue;
      const trimmed = role.trim();
      if (trimmed) roles.add(trimmed);
    }
  }
  if (typeof entry.role === 'string') {
    const trimmed = entry.role.trim();
    if (trimmed) roles.add(trimmed);
  }
  return [...roles];
}

function sameScopeSet(value) {
  if (!Array.isArray(value) || value.length !== FULL_OPERATOR_SCOPES.length) return false;
  const expected = new Set(FULL_OPERATOR_SCOPES);
  return value.every(scope => typeof scope === 'string' && expected.has(scope));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

function loadPendingRequest(requestId) {
  if (!fs.existsSync(PENDING_PATH)) {
    return { status: 'missing-pending-file' };
  }
  const pendingFile = readJsonFile(PENDING_PATH);
  if (!isRecord(pendingFile)) {
    return { status: 'invalid-pending-file' };
  }
  const entry = pendingFile[requestId];
  if (!isRecord(entry)) {
    return { status: 'missing-request' };
  }
  return { status: 'found', pendingFile, entry };
}

function validateGatewayClientRequest(entry) {
  if (entry.clientId !== GATEWAY_CLIENT_ID) {
    return { ok: false, reason: 'not-gateway-client' };
  }
  if (!roleList(entry).includes(OPERATOR_ROLE)) {
    return { ok: false, reason: 'not-operator' };
  }
  return { ok: true };
}

function widenPendingRequestScopes(requestId, pendingFile, entry) {
  if (sameScopeSet(entry.scopes)) return false;
  pendingFile[requestId] = {
    ...entry,
    scopes: [...FULL_OPERATOR_SCOPES],
  };
  writeJsonAtomic(PENDING_PATH, pendingFile);
  return true;
}

async function importApproveDevicePairing() {
  const files = fs
    .readdirSync(OPENCLAW_DIST_DIR)
    .filter(name => /^device-pairing-.*\.js$/.test(name))
    .sort();
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one OpenClaw device-pairing dist chunk, found ${files.length}`
    );
  }
  const modulePath = path.join(OPENCLAW_DIST_DIR, files[0]);
  const mod = await import(pathToFileURL(modulePath).href);
  for (const value of Object.values(mod)) {
    if (typeof value === 'function' && value.name === 'approveDevicePairing') {
      return value;
    }
  }
  throw new Error(`approveDevicePairing export not found in ${files[0]}`);
}

function printResult(result) {
  console.log(JSON.stringify(result));
}

async function main() {
  process.env.HOME = '/root';
  const requestId = process.argv[2];
  if (!requestId || !UUID_RE.test(requestId)) {
    printResult({ approved: false, status: 'invalid-request-id' });
    process.exitCode = 2;
    return;
  }

  const pending = loadPendingRequest(requestId);
  if (pending.status !== 'found') {
    printResult({ approved: false, status: pending.status, requestId });
    return;
  }

  const validation = validateGatewayClientRequest(pending.entry);
  if (!validation.ok) {
    printResult({ approved: false, status: validation.reason, requestId });
    process.exitCode = 2;
    return;
  }

  const scopesWidened = widenPendingRequestScopes(requestId, pending.pendingFile, pending.entry);
  const approveDevicePairing = await importApproveDevicePairing();
  const approved = await approveDevicePairing(requestId, { callerScopes: FULL_OPERATOR_SCOPES });

  if (!approved) {
    printResult({ approved: false, status: 'missing-request', requestId, scopesWidened });
    return;
  }
  if (approved.status !== 'approved') {
    printResult({
      approved: false,
      status: approved.status,
      reason: approved.reason,
      scope: approved.scope,
      role: approved.role,
      requestId,
      scopesWidened,
    });
    process.exitCode = 2;
    return;
  }

  printResult({
    approved: true,
    status: 'approved',
    requestId,
    deviceId: approved.device.deviceId,
    scopesWidened,
  });
}

main().catch(err => {
  process.stderr.write(
    `[gateway-client-approve] fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exitCode = 1;
});
