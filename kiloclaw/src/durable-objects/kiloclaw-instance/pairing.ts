import type { KiloClawEnv } from '../../types';
import * as fly from '../../fly/client';
import type { InstanceMutableState } from './types';
import { getFlyConfig } from './types';
import { callGatewayController, isErrorUnknownRoute } from './gateway';
import {
  GatewayControllerError,
  ControllerChannelPairingResponseSchema,
  ControllerDevicePairingResponseSchema,
  ControllerPairingApproveResponseSchema,
} from '../gateway-controller-types';

const CACHE_TTL_SECONDS = 120;

function makeCacheKey(prefix: string, state: InstanceMutableState): string | null {
  const { flyAppName, flyMachineId } = state;
  if (!flyAppName || !flyMachineId) return null;
  return `${prefix}:${flyAppName}:${flyMachineId}`;
}

/**
 * Extract the `requests` array from a parsed JSON object, returning null
 * if the shape is unexpected.
 */
function parseCachedRequests<T>(cached: unknown): T[] | null {
  if (
    cached &&
    typeof cached === 'object' &&
    'requests' in cached &&
    Array.isArray(cached.requests)
  ) {
    return cached.requests as T[];
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Channel pairing
// ──────────────────────────────────────────────────────────────────────

type PairingRequest = {
  code: string;
  id: string;
  channel: string;
  meta?: unknown;
  createdAt?: string;
};

/**
 * List pending channel pairing requests. Prefers the gateway controller's
 * in-memory cache; falls back to fly exec with KV caching.
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

  // Try controller first
  try {
    const path = forceRefresh ? '/_kilo/pairing/channels?refresh=true' : '/_kilo/pairing/channels';
    const result = await callGatewayController(
      state,
      env,
      path,
      'GET',
      ControllerChannelPairingResponseSchema
    );
    return { requests: result.requests };
  } catch (error) {
    if (isErrorUnknownRoute(error)) {
      // Fall through to fly exec
    } else {
      throw error;
    }
  }

  const cacheKey = makeCacheKey('pairing', state);
  if (cacheKey && !forceRefresh) {
    const cached = await env.KV_CLAW_CACHE.get(cacheKey, 'json');
    const requests = parseCachedRequests<PairingRequest>(cached);
    if (requests) {
      console.log(`[DO] pairing list served from KV cache (key=${cacheKey})`);
      return { requests };
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
    const requests = parseCachedRequests<PairingRequest>(data);
    if (requests) {
      pairing = { requests };
    }
  } catch {
    console.error('[DO] pairing list parse error:', result.stdout);
  }

  if (cacheKey) {
    try {
      await env.KV_CLAW_CACHE.put(cacheKey, JSON.stringify(pairing), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (kvErr) {
      console.warn('[DO] Failed to write pairing cache to KV:', kvErr);
    }
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

  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(channel)) {
    return { success: false, message: 'Invalid channel name' };
  }
  if (!/^[A-Za-z0-9]{1,32}$/.test(code)) {
    return { success: false, message: 'Invalid pairing code' };
  }

  // Try controller first
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/pairing/channels/approve',
      'POST',
      ControllerPairingApproveResponseSchema,
      { channel, code }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) {
      // Fall through to fly exec
    } else if (error instanceof GatewayControllerError && error.status === 400) {
      return { success: false, message: error.message };
    } else {
      throw error;
    }
  }

  const flyConfig = getFlyConfig(env, state);
  const result = await fly.execCommand(
    flyConfig,
    flyMachineId,
    ['/usr/bin/env', 'HOME=/root', 'openclaw', 'pairing', 'approve', channel, code, '--notify'],
    60
  );

  const success = result.exit_code === 0;

  if (success) {
    const cacheKey = makeCacheKey('pairing', state);
    if (cacheKey) {
      try {
        await env.KV_CLAW_CACHE.delete(cacheKey);
      } catch (kvErr) {
        console.warn('[DO] Failed to invalidate pairing cache from KV:', kvErr);
      }
    }
  } else {
    console.error('[DO] pairing approve failed:', result.stderr || result.stdout);
  }

  return {
    success,
    message: success
      ? 'Pairing approved'
      : `Approval failed: ${(result.stderr || result.stdout).trim().slice(0, 200) || 'unknown error'}`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Device pairing
// ──────────────────────────────────────────────────────────────────────

type DevicePairingRequest = {
  requestId: string;
  deviceId: string;
  role?: string;
  platform?: string;
  clientId?: string;
  ts?: number;
};

/**
 * List pending device pairing requests. Prefers the gateway controller's
 * in-memory cache; falls back to fly exec with KV caching.
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

  // Try controller first
  try {
    const path = forceRefresh ? '/_kilo/pairing/devices?refresh=true' : '/_kilo/pairing/devices';
    const result = await callGatewayController(
      state,
      env,
      path,
      'GET',
      ControllerDevicePairingResponseSchema
    );
    return { requests: result.requests };
  } catch (error) {
    if (isErrorUnknownRoute(error)) {
      // Fall through to fly exec
    } else {
      throw error;
    }
  }

  const cacheKey = makeCacheKey('device-pairing', state);
  if (cacheKey && !forceRefresh) {
    const cached = await env.KV_CLAW_CACHE.get(cacheKey, 'json');
    const requests = parseCachedRequests<DevicePairingRequest>(cached);
    if (requests) {
      console.log(`[DO] device pairing list served from KV cache (key=${cacheKey})`);
      return { requests };
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
    const requests = parseCachedRequests<DevicePairingRequest>(data);
    if (requests) {
      pairing = { requests };
    }
  } catch {
    console.error(`[DO] device pairing list parse error: ${result.stdout} ${logCtx}`);
  }

  if (cacheKey) {
    try {
      await env.KV_CLAW_CACHE.put(cacheKey, JSON.stringify(pairing), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (kvErr) {
      console.warn('[DO] Failed to write device pairing cache to KV:', kvErr);
    }
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

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return { success: false, message: 'Invalid request ID' };
  }

  // Try controller first
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/pairing/devices/approve',
      'POST',
      ControllerPairingApproveResponseSchema,
      { requestId }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) {
      // Fall through to fly exec
    } else if (error instanceof GatewayControllerError && error.status === 400) {
      return { success: false, message: error.message };
    } else {
      throw error;
    }
  }

  const flyConfig = getFlyConfig(env, state);
  const result = await fly.execCommand(
    flyConfig,
    flyMachineId,
    ['/usr/bin/env', 'HOME=/root', 'openclaw', 'devices', 'approve', requestId],
    60
  );

  const success = result.exit_code === 0;

  if (success) {
    const cacheKey = makeCacheKey('device-pairing', state);
    if (cacheKey) {
      try {
        await env.KV_CLAW_CACHE.delete(cacheKey);
      } catch (kvErr) {
        console.warn('[DO] Failed to invalidate device pairing cache from KV:', kvErr);
      }
    }
  } else {
    console.error('[DO] device pairing approve failed:', result.stderr || result.stdout);
  }

  return {
    success,
    message: success
      ? 'Device pairing approved'
      : `Approval failed: ${(result.stderr || result.stdout).trim().slice(0, 200) || 'unknown error'}`,
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
