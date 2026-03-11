import type { KiloClawEnv } from '../../types';
import * as fly from '../../fly/client';
import type { InstanceMutableState } from './types';
import { getFlyConfig } from './types';

const PAIRING_CACHE_TTL_SECONDS = 120;
const DEVICE_PAIRING_CACHE_TTL_SECONDS = 120;

// ──────────────────────────────────────────────────────────────────────
// Channel pairing
// ──────────────────────────────────────────────────────────────────────

function pairingCacheKey(state: InstanceMutableState): string | null {
  const { flyAppName, flyMachineId } = state;
  if (!flyAppName || !flyMachineId) return null;
  return `pairing:${flyAppName}:${flyMachineId}`;
}

type PairingRequest = {
  code: string;
  id: string;
  channel: string;
  meta?: unknown;
  createdAt?: string;
};

/**
 * List pending channel pairing requests. Cached in KV for 2 minutes.
 */
export async function listPairingRequests(
  state: InstanceMutableState,
  env: KiloClawEnv,
  forceRefresh = false
): Promise<{ requests: PairingRequest[] }> {
  const { flyMachineId } = state;
  if (state.status !== 'running' || !flyMachineId) {
    return { requests: [] };
  }

  const cacheKey = pairingCacheKey(state);
  if (cacheKey && !forceRefresh) {
    const cached = await env.KV_CLAW_CACHE.get(cacheKey, 'json');
    if (
      cached &&
      typeof cached === 'object' &&
      'requests' in cached &&
      Array.isArray(cached.requests)
    ) {
      console.log(`[DO] pairing list served from KV cache (key=${cacheKey})`);
      return { requests: cached.requests as PairingRequest[] };
    }
  }

  const flyConfig = getFlyConfig(env, state);

  const result = await fly.execCommand(
    flyConfig,
    flyMachineId,
    ['/usr/bin/env', 'HOME=/root', 'node', '/usr/local/bin/openclaw-pairing-list.js'],
    60
  );

  const empty: { requests: PairingRequest[] } = { requests: [] };

  if (result.exit_code !== 0) {
    console.error('[DO] pairing list failed:', result.stderr);
    return empty;
  }

  let pairing = empty;
  try {
    const data = JSON.parse(result.stdout.trim()) as unknown;
    if (data && typeof data === 'object' && 'requests' in data && Array.isArray(data.requests)) {
      pairing = { requests: data.requests as PairingRequest[] };
    }
  } catch {
    console.error('[DO] pairing list parse error:', result.stdout);
  }

  if (cacheKey) {
    await env.KV_CLAW_CACHE.put(cacheKey, JSON.stringify(pairing), {
      expirationTtl: PAIRING_CACHE_TTL_SECONDS,
    });
  }

  return pairing;
}

/**
 * Approve a pending channel pairing request.
 */
export async function approvePairingRequest(
  state: InstanceMutableState,
  env: KiloClawEnv,
  channel: string,
  code: string
): Promise<{ success: boolean; message: string }> {
  const { flyMachineId } = state;
  if (state.status !== 'running' || !flyMachineId) {
    return { success: false, message: 'Instance is not running' };
  }

  const flyConfig = getFlyConfig(env, state);

  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(channel)) {
    return { success: false, message: 'Invalid channel name' };
  }
  if (!/^[A-Za-z0-9]{1,32}$/.test(code)) {
    return { success: false, message: 'Invalid pairing code' };
  }

  const result = await fly.execCommand(
    flyConfig,
    flyMachineId,
    ['/usr/bin/env', 'HOME=/root', 'openclaw', 'pairing', 'approve', channel, code, '--notify'],
    60
  );

  const success = result.exit_code === 0;

  if (success) {
    const cacheKey = pairingCacheKey(state);
    if (cacheKey) {
      await env.KV_CLAW_CACHE.delete(cacheKey);
    }
  }

  if (!success) {
    console.error('[DO] pairing approve failed:', result.stderr || result.stdout);
  }

  return {
    success,
    message: success ? 'Pairing approved' : 'Approval failed',
  };
}

// ──────────────────────────────────────────────────────────────────────
// Device pairing
// ──────────────────────────────────────────────────────────────────────

function devicePairingCacheKey(state: InstanceMutableState): string | null {
  const { flyAppName, flyMachineId } = state;
  if (!flyAppName || !flyMachineId) return null;
  return `device-pairing:${flyAppName}:${flyMachineId}`;
}

type DevicePairingRequest = {
  requestId: string;
  deviceId: string;
  role?: string;
  platform?: string;
  clientId?: string;
  ts?: number;
};

/**
 * List pending device pairing requests. Cached in KV for 2 minutes.
 */
export async function listDevicePairingRequests(
  state: InstanceMutableState,
  env: KiloClawEnv,
  forceRefresh = false
): Promise<{ requests: DevicePairingRequest[] }> {
  const { flyMachineId } = state;
  if (state.status !== 'running' || !flyMachineId) {
    return { requests: [] };
  }

  const cacheKey = devicePairingCacheKey(state);
  if (cacheKey && !forceRefresh) {
    const cached = await env.KV_CLAW_CACHE.get(cacheKey, 'json');
    if (
      cached &&
      typeof cached === 'object' &&
      'requests' in cached &&
      Array.isArray(cached.requests)
    ) {
      console.log(`[DO] device pairing list served from KV cache (key=${cacheKey})`);
      return { requests: cached.requests as DevicePairingRequest[] };
    }
  }

  const flyConfig = getFlyConfig(env, state);

  const result = await fly.execCommand(
    flyConfig,
    flyMachineId,
    ['/usr/bin/env', 'HOME=/root', 'node', '/usr/local/bin/openclaw-device-pairing-list.js'],
    60
  );

  const empty: { requests: DevicePairingRequest[] } = { requests: [] };

  const logCtx = `sandboxId=${state.sandboxId} appId=${state.flyAppName}`;
  if (result.exit_code !== 0) {
    console.error(`[DO] device pairing list failed: ${result.stderr} ${logCtx}`);
    return empty;
  }

  let pairing = empty;
  try {
    const data = JSON.parse(result.stdout.trim()) as unknown;
    if (data && typeof data === 'object' && 'requests' in data && Array.isArray(data.requests)) {
      pairing = { requests: data.requests as DevicePairingRequest[] };
    }
  } catch {
    console.error(`[DO] device pairing list parse error: ${result.stdout} ${logCtx}`);
  }

  if (cacheKey) {
    await env.KV_CLAW_CACHE.put(cacheKey, JSON.stringify(pairing), {
      expirationTtl: DEVICE_PAIRING_CACHE_TTL_SECONDS,
    });
  }

  return pairing;
}

/**
 * Approve a pending device pairing request.
 */
export async function approveDevicePairingRequest(
  state: InstanceMutableState,
  env: KiloClawEnv,
  requestId: string
): Promise<{ success: boolean; message: string }> {
  const { flyMachineId } = state;
  if (state.status !== 'running' || !flyMachineId) {
    return { success: false, message: 'Instance is not running' };
  }

  const flyConfig = getFlyConfig(env, state);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return { success: false, message: 'Invalid request ID' };
  }

  const result = await fly.execCommand(
    flyConfig,
    flyMachineId,
    ['/usr/bin/env', 'HOME=/root', 'openclaw', 'devices', 'approve', requestId],
    60
  );

  const success = result.exit_code === 0;

  if (success) {
    const cacheKey = devicePairingCacheKey(state);
    if (cacheKey) {
      await env.KV_CLAW_CACHE.delete(cacheKey);
    }
  }

  if (!success) {
    console.error('[DO] device pairing approve failed:', result.stderr || result.stdout);
  }

  return {
    success,
    message: success ? 'Device pairing approved' : 'Approval failed',
  };
}

// ──────────────────────────────────────────────────────────────────────
// Doctor command
// ──────────────────────────────────────────────────────────────────────

/**
 * Run `openclaw doctor --fix --non-interactive` on the machine.
 */
export async function runDoctor(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{ success: boolean; output: string }> {
  const { flyMachineId } = state;
  if (state.status !== 'running' || !flyMachineId) {
    return { success: false, output: 'Instance is not running' };
  }

  const flyConfig = getFlyConfig(env, state);

  const result = await fly.execCommand(
    flyConfig,
    flyMachineId,
    ['/usr/bin/env', 'HOME=/root', 'openclaw', 'doctor', '--fix', '--non-interactive'],
    60
  );

  const output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
  return { success: result.exit_code === 0, output };
}
