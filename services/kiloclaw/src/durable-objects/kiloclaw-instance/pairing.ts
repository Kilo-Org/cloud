import { z } from 'zod';
import type { KiloClawEnv } from '../../types';
import * as fly from '../../fly/client';
import type { InstanceMutableState } from './types';
import { getFlyConfig } from './types';
import { getRuntimeId } from './state';
import { callGatewayController, isErrorUnknownRoute } from './gateway';
import { doError, doWarn, toLoggable } from './log';
import {
  GatewayControllerError,
  ControllerChannelPairingResponseSchema,
  ControllerDevicePairingResponseSchema,
  ControllerPairingApproveResponseSchema,
} from '../gateway-controller-types';

const CACHE_TTL_SECONDS = 120;

const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Schemas for KV cache / fly exec output — `lastUpdated` is not present on these paths
const ChannelRequestsSchema = z.object({
  requests: ControllerChannelPairingResponseSchema.shape.requests,
});
const DeviceRequestsSchema = z.object({
  requests: ControllerDevicePairingResponseSchema.shape.requests,
});

function makeCacheKey(prefix: string, state: InstanceMutableState): string | null {
  const { flyAppName, flyMachineId } = state;
  if (!flyAppName || !flyMachineId) return null;
  return `${prefix}:${flyAppName}:${flyMachineId}`;
}

function parseCachedChannelRequests(cached: unknown): PairingRequest[] | null {
  const result = ChannelRequestsSchema.safeParse(cached);
  return result.success ? result.data.requests : null;
}

function parseCachedDeviceRequests(cached: unknown): DevicePairingRequest[] | null {
  const result = DeviceRequestsSchema.safeParse(cached);
  return result.success ? result.data.requests : null;
}

type PairingRequest = z.infer<typeof ControllerChannelPairingResponseSchema>['requests'][number];

/**
 * List pending channel pairing requests. Prefers the gateway controller's
 * in-memory cache; falls back to KV cache, then fly exec (result is written
 * back to KV).
 */
export async function listPairingRequests(
  state: InstanceMutableState,
  env: KiloClawEnv,
  forceRefresh = false
): Promise<{ requests: PairingRequest[] }> {
  if (state.status !== 'running' || !getRuntimeId(state)) {
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
    if (!isErrorUnknownRoute(error)) {
      doWarn(state, 'listPairingRequests controller call failed', {
        error: toLoggable(error),
      });
      throw error;
    }
    // Controller predates this route — fall through to KV cache / fly exec
  }

  const { flyMachineId } = state;
  if (!flyMachineId) {
    return { requests: [] };
  }

  const cacheKey = makeCacheKey('pairing', state);
  if (cacheKey && !forceRefresh) {
    const cached = await env.KV_CLAW_CACHE.get(cacheKey, 'json');
    const requests = parseCachedChannelRequests(cached);
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
    doError(state, 'pairing list failed', {
      exitCode: result.exit_code,
      output: result.stderr || result.stdout,
    });
    return empty;
  }

  let pairing = empty;
  try {
    const data: unknown = JSON.parse(result.stdout.trim());
    const requests = parseCachedChannelRequests(data);
    if (requests) {
      pairing = { requests };
    }
  } catch (parseErr) {
    doError(state, 'pairing list parse error', {
      error: toLoggable(parseErr),
      stdout: result.stdout,
    });
  }

  if (cacheKey) {
    try {
      await env.KV_CLAW_CACHE.put(cacheKey, JSON.stringify(pairing), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (kvErr) {
      doWarn(state, 'Failed to write pairing cache to KV', {
        error: toLoggable(kvErr),
      });
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
  if (state.status !== 'running' || !getRuntimeId(state)) {
    return { success: false, message: 'Instance is not running' };
  }

  if (!CHANNEL_RE.test(channel)) {
    return { success: false, message: 'Invalid channel name' };
  }
  if (!CODE_RE.test(code)) {
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
    if (error instanceof GatewayControllerError && error.status === 400) {
      return { success: false, message: error.message };
    }
    if (!isErrorUnknownRoute(error)) {
      doWarn(state, 'approvePairingRequest controller call failed', {
        error: toLoggable(error),
      });
      throw error;
    }
    // Controller predates this route — fall through to fly exec
  }

  const { flyMachineId } = state;
  if (!flyMachineId) {
    return {
      success: false,
      message: 'Controller pairing route unavailable; redeploy required',
    };
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
        doWarn(state, 'Failed to invalidate pairing cache from KV', {
          error: toLoggable(kvErr),
        });
      }
    }
  } else {
    doError(state, 'pairing approve failed', {
      output: result.stderr || result.stdout,
    });
  }

  return {
    success,
    message: success
      ? 'Pairing approved'
      : `Approval failed: ${(result.stderr || result.stdout).trim().slice(0, 200) || 'unknown error'}`,
  };
}

type DevicePairingRequest = z.infer<
  typeof ControllerDevicePairingResponseSchema
>['requests'][number];

/**
 * List pending device pairing requests. Prefers the gateway controller's
 * in-memory cache; falls back to KV cache, then fly exec (result is written
 * back to KV).
 */
export async function listDevicePairingRequests(
  state: InstanceMutableState,
  env: KiloClawEnv,
  forceRefresh = false
): Promise<{ requests: DevicePairingRequest[] }> {
  if (state.status !== 'running' || !getRuntimeId(state)) {
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
    if (!isErrorUnknownRoute(error)) {
      doWarn(state, 'listDevicePairingRequests controller call failed', {
        error: toLoggable(error),
      });
      throw error;
    }
    // Controller predates this route — fall through to KV cache / fly exec
  }

  const { flyMachineId } = state;
  if (!flyMachineId) {
    return { requests: [] };
  }

  const cacheKey = makeCacheKey('device-pairing', state);
  if (cacheKey && !forceRefresh) {
    const cached = await env.KV_CLAW_CACHE.get(cacheKey, 'json');
    const requests = parseCachedDeviceRequests(cached);
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

  if (result.exit_code !== 0) {
    doError(state, 'device pairing list failed', {
      output: result.stderr,
    });
    return empty;
  }

  let pairing = empty;
  try {
    const data: unknown = JSON.parse(result.stdout.trim());
    const requests = parseCachedDeviceRequests(data);
    if (requests) {
      pairing = { requests };
    }
  } catch (parseErr) {
    doError(state, 'device pairing list parse error', {
      error: toLoggable(parseErr),
      stdout: result.stdout,
    });
  }

  if (cacheKey) {
    try {
      await env.KV_CLAW_CACHE.put(cacheKey, JSON.stringify(pairing), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (kvErr) {
      doWarn(state, 'Failed to write device pairing cache to KV', {
        error: toLoggable(kvErr),
      });
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
  if (state.status !== 'running' || !getRuntimeId(state)) {
    return { success: false, message: 'Instance is not running' };
  }

  if (!UUID_RE.test(requestId)) {
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
    if (error instanceof GatewayControllerError && error.status === 400) {
      return { success: false, message: error.message };
    }
    if (!isErrorUnknownRoute(error)) {
      doWarn(state, 'approveDevicePairingRequest controller call failed', {
        error: toLoggable(error),
      });
      throw error;
    }
    // Controller predates this route — fall through to fly exec
  }

  const { flyMachineId } = state;
  if (!flyMachineId) {
    return {
      success: false,
      message: 'Controller pairing route unavailable; redeploy required',
    };
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
        doWarn(state, 'Failed to invalidate device pairing cache from KV', {
          error: toLoggable(kvErr),
        });
      }
    }
  } else {
    doError(state, 'device pairing approve failed', {
      output: result.stderr || result.stdout,
    });
  }

  return {
    success,
    message: success
      ? 'Device pairing approved'
      : `Approval failed: ${(result.stderr || result.stdout).trim().slice(0, 200) || 'unknown error'}`,
  };
}

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
