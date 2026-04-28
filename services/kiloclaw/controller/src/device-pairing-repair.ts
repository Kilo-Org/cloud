import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './atomic-write.js';

const DEFAULT_OPENCLAW_STATE_DIR = '/root/.openclaw';
const GATEWAY_CLIENT_ID = 'gateway-client';
const BACKEND_CLIENT_MODE = 'backend';
const OPERATOR_ROLE = 'operator';
const OPERATOR_APPROVALS_SCOPE = 'operator.approvals';

type JsonRecord = Record<string, unknown>;

export type DevicePairingRepairResult = {
  status: 'noop' | 'repaired' | 'warning';
  pairedDevicesRepaired: number;
  pendingRequestsRemoved: number;
  operatorTokenScopesUpdated: boolean;
  warnings: string[];
};

type DevicePairingRepairOptions = {
  stateDir?: string;
};

type ReadJsonRecordResult =
  | { ok: true; exists: boolean; value: JsonRecord }
  | { ok: false; warning: string };

function resolveOpenClawStateDir(stateDir?: string): string {
  return stateDir?.trim() || process.env.OPENCLAW_STATE_DIR?.trim() || DEFAULT_OPENCLAW_STATE_DIR;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getStringArray(record: JsonRecord, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string');
}

function mergeStrings(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item)) continue;
      seen.add(item);
      merged.push(item);
    }
  }
  return merged;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isOperatorRecord(record: JsonRecord): boolean {
  return (
    getString(record, 'role') === OPERATOR_ROLE ||
    getStringArray(record, 'roles').includes(OPERATOR_ROLE)
  );
}

function isGatewayClientBackendRecord(
  record: JsonRecord,
  options: { allowMissingClientMode?: boolean } = {}
): boolean {
  const clientMode = getString(record, 'clientMode');
  return (
    getString(record, 'clientId') === GATEWAY_CLIENT_ID &&
    (clientMode === BACKEND_CLIENT_MODE ||
      (clientMode === undefined && options.allowMissingClientMode === true)) &&
    isOperatorRecord(record)
  );
}

function requestsOnlySafeInternalScopes(record: JsonRecord): boolean {
  const scopes = getStringArray(record, 'scopes');
  if (!scopes.includes(OPERATOR_APPROVALS_SCOPE)) return false;
  return scopes.every(scope => scope === 'operator.read' || scope === OPERATOR_APPROVALS_SCOPE);
}

function isGatewayClientBackendPendingRequest(record: JsonRecord): boolean {
  return (
    isGatewayClientBackendRecord(record, { allowMissingClientMode: true }) &&
    requestsOnlySafeInternalScopes(record)
  );
}

function readJsonRecord(filePath: string): ReadJsonRecordResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, exists: false, value: {} };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `could not read ${path.basename(filePath)}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `could not parse ${path.basename(filePath)}: ${message}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, warning: `${path.basename(filePath)} did not contain a JSON object` };
  }
  return { ok: true, exists: true, value: parsed };
}

function writeJsonRecord(filePath: string, value: JsonRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, undefined, { mode: 0o600 });
}

function hasOperatorApprovals(record: JsonRecord): boolean {
  return (
    getStringArray(record, 'approvedScopes').includes(OPERATOR_APPROVALS_SCOPE) &&
    getStringArray(record, 'scopes').includes(OPERATOR_APPROVALS_SCOPE)
  );
}

function repairPairedDevice(record: JsonRecord): {
  record: JsonRecord;
  changed: boolean;
  tokenScopesUpdated: boolean;
} {
  const next: JsonRecord = { ...record };
  let changed = false;
  let tokenScopesUpdated = false;

  const desiredScopes = mergeStrings(
    getStringArray(record, 'approvedScopes'),
    getStringArray(record, 'scopes'),
    [OPERATOR_APPROVALS_SCOPE]
  );
  if (!arraysEqual(getStringArray(record, 'approvedScopes'), desiredScopes)) {
    next.approvedScopes = desiredScopes;
    changed = true;
  }
  if (!arraysEqual(getStringArray(record, 'scopes'), desiredScopes)) {
    next.scopes = desiredScopes;
    changed = true;
  }

  if (getString(record, 'role') !== OPERATOR_ROLE) {
    next.role = OPERATOR_ROLE;
    changed = true;
  }
  const desiredRoles = mergeStrings(getStringArray(record, 'roles'), [OPERATOR_ROLE]);
  if (!arraysEqual(getStringArray(record, 'roles'), desiredRoles)) {
    next.roles = desiredRoles;
    changed = true;
  }

  if (isRecord(record.tokens)) {
    const operatorToken = record.tokens[OPERATOR_ROLE];
    if (isRecord(operatorToken) && operatorToken.revokedAtMs === undefined) {
      const desiredTokenScopes = mergeStrings(getStringArray(operatorToken, 'scopes'), [
        OPERATOR_APPROVALS_SCOPE,
      ]);
      if (!arraysEqual(getStringArray(operatorToken, 'scopes'), desiredTokenScopes)) {
        next.tokens = {
          ...record.tokens,
          [OPERATOR_ROLE]: {
            ...operatorToken,
            scopes: desiredTokenScopes,
          },
        };
        changed = true;
        tokenScopesUpdated = true;
      }
    }
  }

  return { record: next, changed, tokenScopesUpdated };
}

export function repairInternalGatewayClientPairingState(
  options: DevicePairingRepairOptions = {}
): DevicePairingRepairResult {
  const stateDir = resolveOpenClawStateDir(options.stateDir);
  const devicesDir = path.join(stateDir, 'devices');
  const pendingPath = path.join(devicesDir, 'pending.json');
  const pairedPath = path.join(devicesDir, 'paired.json');

  const pending = readJsonRecord(pendingPath);
  const paired = readJsonRecord(pairedPath);
  if (!pending.ok || !paired.ok) {
    const warnings: string[] = [];
    if (!pending.ok) warnings.push(pending.warning);
    if (!paired.ok) warnings.push(paired.warning);
    return {
      status: 'warning',
      pairedDevicesRepaired: 0,
      pendingRequestsRemoved: 0,
      operatorTokenScopesUpdated: false,
      warnings,
    };
  }

  let pairedDevicesRepaired = 0;
  let pendingRequestsRemoved = 0;
  let operatorTokenScopesUpdated = false;
  let pairedChanged = false;
  let pendingChanged = false;

  const pairedByDeviceId: JsonRecord = { ...paired.value };
  const pendingByRequestId: JsonRecord = { ...pending.value };

  const internalPendingDeviceIds = new Set<string>();
  for (const request of Object.values(pendingByRequestId)) {
    if (!isRecord(request)) continue;
    if (!isGatewayClientBackendPendingRequest(request)) continue;
    const deviceId = getString(request, 'deviceId');
    if (deviceId) {
      internalPendingDeviceIds.add(deviceId);
    }
  }

  for (const [deviceId, device] of Object.entries(pairedByDeviceId)) {
    if (!isRecord(device)) continue;
    if (
      !isGatewayClientBackendRecord(device, {
        allowMissingClientMode: internalPendingDeviceIds.has(deviceId),
      })
    )
      continue;
    const needsScopeRepair = !hasOperatorApprovals(device);
    if (!needsScopeRepair && !internalPendingDeviceIds.has(deviceId)) continue;

    const repaired = repairPairedDevice(device);
    if (repaired.changed) {
      pairedByDeviceId[deviceId] = repaired.record;
      pairedChanged = true;
      pairedDevicesRepaired += 1;
      operatorTokenScopesUpdated = operatorTokenScopesUpdated || repaired.tokenScopesUpdated;
    }
  }

  for (const [requestId, request] of Object.entries(pendingByRequestId)) {
    if (!isRecord(request)) continue;
    if (!isGatewayClientBackendPendingRequest(request)) continue;
    const deviceId = getString(request, 'deviceId');
    if (!deviceId) continue;
    const pairedDevice = pairedByDeviceId[deviceId];
    if (
      !isRecord(pairedDevice) ||
      !isGatewayClientBackendRecord(pairedDevice, { allowMissingClientMode: true })
    )
      continue;

    delete pendingByRequestId[requestId];
    pendingChanged = true;
    pendingRequestsRemoved += 1;
  }

  if (pairedChanged) {
    writeJsonRecord(pairedPath, pairedByDeviceId);
  }
  if (pendingChanged || (pending.exists && pendingRequestsRemoved > 0)) {
    writeJsonRecord(pendingPath, pendingByRequestId);
  }

  const repaired = pairedDevicesRepaired > 0 || pendingRequestsRemoved > 0;
  return {
    status: repaired ? 'repaired' : 'noop',
    pairedDevicesRepaired,
    pendingRequestsRemoved,
    operatorTokenScopesUpdated,
    warnings: [],
  };
}
