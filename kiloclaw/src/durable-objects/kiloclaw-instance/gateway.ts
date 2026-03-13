import type { ZodType } from 'zod';
import type { KiloClawEnv } from '../../types';
import { deriveGatewayToken } from '../../auth/gateway-token';
import {
  type GatewayProcessStatus,
  GatewayProcessStatusSchema,
  GatewayCommandResponseSchema,
  ConfigRestoreResponseSchema,
  ControllerVersionResponseSchema,
  OpenclawConfigResponseSchema,
  GatewayControllerError,
} from '../gateway-controller-types';
import { HEALTH_PROBE_TIMEOUT_SECONDS, HEALTH_PROBE_INTERVAL_MS } from '../../config';
import type { InstanceMutableState } from './types';

/**
 * Validate that the instance has all context needed for gateway controller RPCs.
 */
function requireGatewayControllerContext(
  state: InstanceMutableState,
  env: KiloClawEnv
): {
  appName: string;
  machineId: string;
  sandboxId: string;
} {
  if (!state.sandboxId) {
    throw new GatewayControllerError(409, 'Instance not provisioned');
  }
  if (!state.flyMachineId) {
    throw new GatewayControllerError(409, 'Instance has no machine ID');
  }

  const appName = state.flyAppName ?? env.FLY_APP_NAME;
  if (!appName) {
    throw new GatewayControllerError(503, 'No Fly app name for this instance');
  }

  return {
    appName,
    machineId: state.flyMachineId,
    sandboxId: state.sandboxId,
  };
}

/**
 * Call a gateway controller endpoint and validate the response.
 */
export async function callGatewayController<T>(
  state: InstanceMutableState,
  env: KiloClawEnv,
  path: string,
  method: 'GET' | 'POST',
  responseSchema: ZodType<T>,
  jsonBody?: unknown
): Promise<T> {
  const { appName, machineId, sandboxId } = requireGatewayControllerContext(state, env);

  if (!env.GATEWAY_TOKEN_SECRET) {
    throw new GatewayControllerError(503, 'GATEWAY_TOKEN_SECRET is not configured');
  }

  const gatewayToken = await deriveGatewayToken(sandboxId, env.GATEWAY_TOKEN_SECRET);
  const url = `https://${appName}.fly.dev${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${gatewayToken}`,
    Accept: 'application/json',
    'fly-force-instance-id': machineId,
  };
  if (jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GatewayControllerError(503, `Gateway controller request failed: ${message}`);
  }

  const rawBody = await response.text();
  let body: unknown = null;
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = { error: rawBody };
    }
  }

  if (!response.ok) {
    const errorCode =
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : undefined;
    const errorMessage =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Gateway controller request failed (${response.status})`;
    throw new GatewayControllerError(response.status, errorMessage, errorCode);
  }

  const parsed = responseSchema.safeParse(body ?? {});
  if (!parsed.success) {
    console.warn(
      '[DO] Gateway controller returned invalid response payload',
      JSON.stringify({
        path,
        status: response.status,
        body: rawBody.slice(0, 1024),
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      })
    );
    throw new GatewayControllerError(
      502,
      `Gateway controller returned invalid response for ${path}`
    );
  }

  return parsed.data;
}

// ──────────────────────────────────────────────────────────────────────
// Convenience wrappers for specific gateway controller endpoints
// ──────────────────────────────────────────────────────────────────────

export function getGatewayProcessStatus(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<GatewayProcessStatus> {
  return callGatewayController(
    state,
    env,
    '/_kilo/gateway/status',
    'GET',
    GatewayProcessStatusSchema
  );
}

export function startGatewayProcess(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{ ok: boolean }> {
  return callGatewayController(
    state,
    env,
    '/_kilo/gateway/start',
    'POST',
    GatewayCommandResponseSchema
  );
}

export function stopGatewayProcess(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{ ok: boolean }> {
  return callGatewayController(
    state,
    env,
    '/_kilo/gateway/stop',
    'POST',
    GatewayCommandResponseSchema
  );
}

export function restartGatewayProcess(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{ ok: boolean }> {
  return callGatewayController(
    state,
    env,
    '/_kilo/gateway/restart',
    'POST',
    GatewayCommandResponseSchema
  );
}

export function restoreConfig(
  state: InstanceMutableState,
  env: KiloClawEnv,
  version: string
): Promise<{ ok: boolean; signaled: boolean }> {
  return callGatewayController(
    state,
    env,
    `/_kilo/config/restore/${encodeURIComponent(version)}`,
    'POST',
    ConfigRestoreResponseSchema
  );
}

export function isErrorUnknownRoute(error: unknown): boolean {
  // If a controller predates a new route, the request will either:
  //   - fall through to the catch-all proxy which returns 401 with code
  //     'controller_route_unavailable' (for /_kilo/* paths)
  //   - forward to the gateway which returns 404 for the unknown path.
  // We intentionally do NOT match bare 401 (without the code) to avoid
  // masking genuine authentication failures.
  return (
    error instanceof GatewayControllerError &&
    (error.status === 404 || error.code === 'controller_route_unavailable')
  );
}

export async function getControllerVersion(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{
  version: string;
  commit: string;
  openclawVersion?: string | null;
} | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/version',
      'GET',
      ControllerVersionResponseSchema
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) {
      return null;
    }
    throw error;
  }
}

/** Returns null if the controller is too old to have the /_kilo/config/read endpoint. */
export async function getOpenclawConfig(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{ config: Record<string, unknown>; etag?: string } | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/config/read',
      'GET',
      OpenclawConfigResponseSchema
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) {
      return null;
    }
    throw error;
  }
}

/** Returns null if the controller is too old to have the /_kilo/config/replace endpoint. */
export async function replaceConfigOnMachine(
  state: InstanceMutableState,
  env: KiloClawEnv,
  config: Record<string, unknown>,
  etag?: string
): Promise<{ ok: boolean } | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/config/replace',
      'POST',
      GatewayCommandResponseSchema,
      { config, etag }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Hot-patch the openclaw.json config on the running machine.
 * Non-fatal: if the machine isn't running, the patch is silently skipped.
 */
export async function patchConfigOnMachine(
  state: InstanceMutableState,
  env: KiloClawEnv,
  patch: Record<string, unknown>
): Promise<void> {
  if (state.status !== 'running' || !state.flyMachineId) return;
  try {
    await callGatewayController(
      state,
      env,
      '/_kilo/config/patch',
      'POST',
      GatewayCommandResponseSchema,
      patch
    );
  } catch (err) {
    console.warn(
      '[DO] patchConfigOnMachine failed (non-fatal):',
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Poll the gateway status endpoint until the OpenClaw gateway process
 * reports state === 'running'. On timeout, logs a warning but does NOT throw.
 */
export async function waitForHealthy(
  state: InstanceMutableState,
  env: KiloClawEnv,
  appName: string,
  machineId: string
): Promise<void> {
  const url = `https://${appName}.fly.dev/_kilo/gateway/status`;
  const deadline = Date.now() + HEALTH_PROBE_TIMEOUT_SECONDS * 1000;

  let gatewayToken: string | undefined;
  if (state.sandboxId && env.GATEWAY_TOKEN_SECRET) {
    gatewayToken = await deriveGatewayToken(state.sandboxId, env.GATEWAY_TOKEN_SECRET);
  }

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: {
          'fly-force-instance-id': machineId,
          ...(gatewayToken && { Authorization: `Bearer ${gatewayToken}` }),
          Accept: 'application/json',
        },
      });
      if (res.ok) {
        const body: { state?: string } = await res.json();
        if (body.state === 'running') {
          const rootUrl = `https://${appName}.fly.dev/`;
          try {
            const rootRes = await fetch(rootUrl, {
              headers: { 'fly-force-instance-id': machineId },
            });
            if (rootRes.status !== 502) {
              console.log(
                '[DO] Gateway health probe passed (state: running, root:',
                rootRes.status,
                ')'
              );
              return;
            }
            console.log('[DO] Gateway reports running but root returned 502 — retrying');
          } catch {
            console.log('[DO] Gateway reports running but root fetch failed — retrying');
          }
        } else {
          console.log('[DO] Gateway state:', body.state, '— retrying');
        }
      } else {
        console.log('[DO] Gateway status returned', res.status, '— retrying');
      }
    } catch (err) {
      console.log('[DO] Gateway status fetch error — retrying:', err);
    }
    await new Promise(r => setTimeout(r, HEALTH_PROBE_INTERVAL_MS));
  }

  console.warn(
    '[DO] Gateway health probe timed out after',
    HEALTH_PROBE_TIMEOUT_SECONDS,
    's — proceeding anyway'
  );
}
