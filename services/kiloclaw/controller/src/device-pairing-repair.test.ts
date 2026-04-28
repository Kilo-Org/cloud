import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repairInternalGatewayClientPairingState } from './device-pairing-repair.js';

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiloclaw-pairing-repair-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'devices'), { recursive: true });
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function pairedPath(stateDir: string): string {
  return path.join(stateDir, 'devices', 'paired.json');
}

function pendingPath(stateDir: string): string {
  return path.join(stateDir, 'devices', 'pending.json');
}

function staleGatewayClientDevice(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    deviceId: 'gateway-device',
    publicKey: 'public-key-redacted',
    clientId: 'gateway-client',
    clientMode: 'backend',
    role: 'operator',
    roles: ['operator'],
    scopes: ['operator.read'],
    approvedScopes: ['operator.read'],
    tokens: {
      operator: {
        token: 'token-redacted',
        role: 'operator',
        scopes: ['operator.read'],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 2,
    ...overrides,
  };
}

function pendingGatewayClientRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    requestId: 'request-1',
    deviceId: 'gateway-device',
    publicKey: 'public-key-redacted',
    clientId: 'gateway-client',
    clientMode: 'backend',
    role: 'operator',
    roles: ['operator'],
    scopes: ['operator.approvals'],
    ts: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('repairInternalGatewayClientPairingState', () => {
  it('repairs a stale paired gateway-client backend even without a pending request', () => {
    const stateDir = makeStateDir();
    writeJson(pairedPath(stateDir), { 'gateway-device': staleGatewayClientDevice() });
    writeJson(pendingPath(stateDir), {});

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result).toEqual({
      status: 'repaired',
      pairedDevicesRepaired: 1,
      pendingRequestsRemoved: 0,
      operatorTokenScopesUpdated: true,
      warnings: [],
    });
    const paired = readJson(pairedPath(stateDir));
    const device = paired['gateway-device'] as Record<string, unknown>;
    expect(device.scopes).toEqual(['operator.read', 'operator.approvals']);
    expect(device.approvedScopes).toEqual(['operator.read', 'operator.approvals']);
    expect((device.tokens as Record<string, Record<string, unknown>>).operator.scopes).toEqual([
      'operator.read',
      'operator.approvals',
    ]);
    expect((device.tokens as Record<string, Record<string, unknown>>).operator.token).toBe(
      'token-redacted'
    );
  });

  it('removes a matching pending internal gateway-client request after repair', () => {
    const stateDir = makeStateDir();
    writeJson(pairedPath(stateDir), { 'gateway-device': staleGatewayClientDevice() });
    writeJson(pendingPath(stateDir), {
      'request-1': pendingGatewayClientRequest(),
    });

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.status).toBe('repaired');
    expect(result.pairedDevicesRepaired).toBe(1);
    expect(result.pendingRequestsRemoved).toBe(1);
    expect(readJson(pendingPath(stateDir))).toEqual({});
  });

  it('removes matching pending request when the paired baseline already has operator.approvals', () => {
    const stateDir = makeStateDir();
    writeJson(pairedPath(stateDir), {
      'gateway-device': staleGatewayClientDevice({
        scopes: ['operator.read', 'operator.approvals'],
        approvedScopes: ['operator.read', 'operator.approvals'],
        tokens: {
          operator: {
            token: 'token-redacted',
            role: 'operator',
            scopes: ['operator.read', 'operator.approvals'],
            createdAtMs: 1,
          },
        },
      }),
    });
    writeJson(pendingPath(stateDir), { 'request-1': pendingGatewayClientRequest() });

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.status).toBe('repaired');
    expect(result.pairedDevicesRepaired).toBe(0);
    expect(result.pendingRequestsRemoved).toBe(1);
    expect(readJson(pendingPath(stateDir))).toEqual({});
  });

  it('does not grant admin or write scopes while repairing approvals', () => {
    const stateDir = makeStateDir();
    writeJson(pairedPath(stateDir), { 'gateway-device': staleGatewayClientDevice() });
    writeJson(pendingPath(stateDir), {
      'request-1': pendingGatewayClientRequest({
        scopes: ['operator.approvals', 'operator.admin', 'operator.write'],
      }),
    });

    const result = repairInternalGatewayClientPairingState({ stateDir });

    const paired = readJson(pairedPath(stateDir));
    const device = paired['gateway-device'] as Record<string, unknown>;
    expect(device.scopes).toEqual(['operator.read', 'operator.approvals']);
    expect(device.approvedScopes).toEqual(['operator.read', 'operator.approvals']);
    expect((device.tokens as Record<string, Record<string, unknown>>).operator.scopes).toEqual([
      'operator.read',
      'operator.approvals',
    ]);
    expect(result.pendingRequestsRemoved).toBe(0);
    expect(Object.keys(readJson(pendingPath(stateDir)))).toEqual(['request-1']);
  });

  it('does not create token material when the operator token is absent', () => {
    const stateDir = makeStateDir();
    writeJson(pairedPath(stateDir), {
      'gateway-device': staleGatewayClientDevice({ tokens: {} }),
    });
    writeJson(pendingPath(stateDir), {});

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.operatorTokenScopesUpdated).toBe(false);
    const paired = readJson(pairedPath(stateDir));
    const device = paired['gateway-device'] as Record<string, unknown>;
    expect(device.tokens).toEqual({});
  });

  it('does not modify revoked operator tokens', () => {
    const stateDir = makeStateDir();
    writeJson(pairedPath(stateDir), {
      'gateway-device': staleGatewayClientDevice({
        tokens: {
          operator: {
            token: 'token-redacted',
            role: 'operator',
            scopes: ['operator.read'],
            createdAtMs: 1,
            revokedAtMs: 2,
          },
        },
      }),
    });
    writeJson(pendingPath(stateDir), {});

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.operatorTokenScopesUpdated).toBe(false);
    const paired = readJson(pairedPath(stateDir));
    const device = paired['gateway-device'] as Record<string, unknown>;
    expect((device.tokens as Record<string, Record<string, unknown>>).operator.scopes).toEqual([
      'operator.read',
    ]);
  });

  it('does not modify non-gateway-client records', () => {
    const stateDir = makeStateDir();
    const otherDevice = staleGatewayClientDevice({ clientId: 'mobile-app' });
    writeJson(pairedPath(stateDir), { 'mobile-device': otherDevice });
    writeJson(pendingPath(stateDir), {
      'request-1': pendingGatewayClientRequest({ clientId: 'mobile-app' }),
    });

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.status).toBe('noop');
    expect(readJson(pairedPath(stateDir))).toEqual({ 'mobile-device': otherDevice });
    expect(Object.keys(readJson(pendingPath(stateDir)))).toEqual(['request-1']);
  });

  it('does not modify gateway-client records with a non-backend mode', () => {
    const stateDir = makeStateDir();
    const uiDevice = staleGatewayClientDevice({ clientMode: 'webchat' });
    writeJson(pairedPath(stateDir), { 'gateway-device': uiDevice });
    writeJson(pendingPath(stateDir), {
      'request-1': pendingGatewayClientRequest({ clientMode: 'webchat' }),
    });

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.status).toBe('noop');
    expect(readJson(pairedPath(stateDir))).toEqual({ 'gateway-device': uiDevice });
    expect(Object.keys(readJson(pendingPath(stateDir)))).toEqual(['request-1']);
  });

  it('does not repair paired gateway-client records with missing mode unless a matching pending request exists', () => {
    const stateDir = makeStateDir();
    const ambiguousDevice = staleGatewayClientDevice({ clientMode: undefined });
    writeJson(pairedPath(stateDir), { 'gateway-device': ambiguousDevice });
    writeJson(pendingPath(stateDir), {});

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.status).toBe('noop');
    expect(readJson(pairedPath(stateDir))).toEqual({ 'gateway-device': ambiguousDevice });
  });

  it('repairs paired gateway-client records with missing mode when a matching internal pending request exists', () => {
    const stateDir = makeStateDir();
    writeJson(pairedPath(stateDir), {
      'gateway-device': staleGatewayClientDevice({ clientMode: undefined }),
    });
    writeJson(pendingPath(stateDir), { 'request-1': pendingGatewayClientRequest() });

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.status).toBe('repaired');
    expect(result.pairedDevicesRepaired).toBe(1);
    expect(result.pendingRequestsRemoved).toBe(1);
    const paired = readJson(pairedPath(stateDir));
    const device = paired['gateway-device'] as Record<string, unknown>;
    expect(device.scopes).toEqual(['operator.read', 'operator.approvals']);
  });

  it('treats missing pairing files as a no-op', () => {
    const stateDir = makeStateDir();
    fs.rmSync(pairedPath(stateDir), { force: true });
    fs.rmSync(pendingPath(stateDir), { force: true });

    expect(repairInternalGatewayClientPairingState({ stateDir })).toEqual({
      status: 'noop',
      pairedDevicesRepaired: 0,
      pendingRequestsRemoved: 0,
      operatorTokenScopesUpdated: false,
      warnings: [],
    });
  });

  it('returns a warning without writing when pairing JSON is malformed', () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(pairedPath(stateDir), '{not-json');
    writeJson(pendingPath(stateDir), {});

    const result = repairInternalGatewayClientPairingState({ stateDir });

    expect(result.status).toBe('warning');
    expect(result.pairedDevicesRepaired).toBe(0);
    expect(result.pendingRequestsRemoved).toBe(0);
    expect(result.warnings[0]).toContain('could not parse paired.json');
    expect(fs.readFileSync(pairedPath(stateDir), 'utf8')).toBe('{not-json');
  });

  it('writes repaired files with owner-only permissions', () => {
    const stateDir = makeStateDir();
    writeJson(pairedPath(stateDir), { 'gateway-device': staleGatewayClientDevice() });
    writeJson(pendingPath(stateDir), { 'request-1': pendingGatewayClientRequest() });

    repairInternalGatewayClientPairingState({ stateDir });

    expect(fs.statSync(pairedPath(stateDir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(pendingPath(stateDir)).mode & 0o777).toBe(0o600);
  });
});
