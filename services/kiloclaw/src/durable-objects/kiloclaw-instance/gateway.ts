import { z, type ZodType } from 'zod';
import type { KiloClawEnv } from '../../types';
import { deriveGatewayToken } from '../../auth/gateway-token';
import {
  type GatewayProcessStatus,
  GatewayProcessStatusSchema,
  GatewayCommandResponseSchema,
  BotIdentityResponseSchema,
  ConfigRestoreResponseSchema,
  ControllerVersionResponseSchema,
  GatewayReadyResponseSchema,
  EnvPatchResponseSchema,
  OpenclawConfigResponseSchema,
  GatewayControllerError,
} from '../gateway-controller-types';
import { HEALTH_PROBE_TIMEOUT_SECONDS, HEALTH_PROBE_INTERVAL_MS } from '../../config';
import type { InstanceMutableState } from './types';
import { doWarn, toLoggable } from './log';
import { getProviderAdapter } from '../../providers';
import { getRuntimeId } from './state';
import type { ProviderRoutingTarget } from '../../providers/types';

/**
 * Validate that the instance has all context needed for gateway controller RPCs.
 */
async function requireGatewayControllerContext(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{
  routingTarget: ProviderRoutingTarget;
  sandboxId: string;
}> {
  if (!state.sandboxId) {
    throw new GatewayControllerError(409, 'Instance not provisioned');
  }

  let routingTarget: ProviderRoutingTarget;
  try {
    routingTarget = await getProviderAdapter(env, state).getRoutingTarget({
      env,
      state,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('machine ID')) {
      throw new GatewayControllerError(409, 'Instance has no machine ID');
    }
    throw new GatewayControllerError(503, message);
  }

  return {
    sandboxId: state.sandboxId,
    routingTarget,
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
  const { routingTarget, sandboxId } = await requireGatewayControllerContext(state, env);

  if (!env.GATEWAY_TOKEN_SECRET) {
    throw new GatewayControllerError(503, 'GATEWAY_TOKEN_SECRET is not configured');
  }

  const gatewayToken = await deriveGatewayToken(sandboxId, env.GATEWAY_TOKEN_SECRET);
  const url = `${routingTarget.origin}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${gatewayToken}`,
    Accept: 'application/json',
    ...routingTarget.headers,
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
    const bodyObj =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const errorCode = typeof bodyObj.code === 'string' ? bodyObj.code : undefined;

    let errorMessage = `Gateway controller request failed (${response.status})`;
    if (typeof bodyObj.error === 'string') {
      errorMessage = bodyObj.error;
    } else if (typeof bodyObj.message === 'string') {
      errorMessage = bodyObj.message;
    }

    throw new GatewayControllerError(response.status, errorMessage, errorCode);
  }

  const parsed = responseSchema.safeParse(body ?? {});
  if (!parsed.success) {
    doWarn(state, 'Gateway controller returned invalid response payload', {
      path,
      status: response.status,
      body: rawBody.slice(0, 1024),
      issues: parsed.error.issues.map(issue => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
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

export function writeBotIdentity(
  state: InstanceMutableState,
  env: KiloClawEnv,
  botIdentity: {
    botName?: string | null;
    botNature?: string | null;
    botVibe?: string | null;
    botEmoji?: string | null;
  }
): Promise<{ ok: boolean; path: string }> {
  return callGatewayController(
    state,
    env,
    '/_kilo/bot-identity',
    'POST',
    BotIdentityResponseSchema,
    botIdentity
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
    (error.code === 'controller_route_unavailable' || (error.status === 404 && !error.code))
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

export async function getGatewayReady(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<Record<string, unknown> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/gateway/ready',
      'GET',
      GatewayReadyResponseSchema
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) {
      return null;
    }
    // During startup the gateway process may not be running yet, producing
    // a 503 from the controller. Return a descriptive object instead of
    // throwing so the frontend poll doesn't see a wall of 500s.
    if (error instanceof GatewayControllerError) {
      return { ready: false, error: error.message, status: error.status };
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

/** Keep in sync with: controller/src/routes/files.ts, src/lib/kiloclaw/kiloclaw-internal-client.ts */
const FileNodeSchema: z.ZodType<{
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: { name: string; path: string; type: 'file' | 'directory'; children?: unknown[] }[];
}> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(['file', 'directory']),
    children: z.array(FileNodeSchema).optional(),
  })
);

const FileTreeResponseSchema = z.object({
  tree: z.array(FileNodeSchema),
});

export async function getFileTree(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{ tree: unknown[] } | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/files/tree',
      'GET',
      FileTreeResponseSchema
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

const FileReadResponseSchema = z.object({
  content: z.string(),
  etag: z.string(),
});

export async function readFile(
  state: InstanceMutableState,
  env: KiloClawEnv,
  filePath: string
): Promise<{ content: string; etag: string } | null> {
  try {
    const params = new URLSearchParams({ path: filePath });
    return await callGatewayController(
      state,
      env,
      `/_kilo/files/read?${params.toString()}`,
      'GET',
      FileReadResponseSchema
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

const FileWriteResponseSchema = z.object({
  etag: z.string(),
});

export async function writeFile(
  state: InstanceMutableState,
  env: KiloClawEnv,
  filePath: string,
  content: string,
  etag?: string
): Promise<{ etag: string } | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/files/write',
      'POST',
      FileWriteResponseSchema,
      { path: filePath, content, etag }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

/**
 * Push env var updates to the running controller and signal the gateway.
 * Returns null if the instance isn't running.
 */
export async function patchEnvOnMachine(
  state: InstanceMutableState,
  env: KiloClawEnv,
  patch: Record<string, string>
): Promise<{ ok: boolean; signaled: boolean } | null> {
  if (state.status !== 'running' || !getRuntimeId(state)) return null;
  return callGatewayController(
    state,
    env,
    '/_kilo/env/patch',
    'POST',
    EnvPatchResponseSchema,
    patch
  );
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
  if (state.status !== 'running' || !getRuntimeId(state)) return;
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
    doWarn(state, 'patchConfigOnMachine failed (non-fatal)', {
      error: toLoggable(err),
    });
  }
}

/**
 * Deep-merge a JSON patch into the live openclaw.json config.
 * Unlike {@link patchConfigOnMachine}, this propagates errors to the caller.
 */
export async function patchOpenclawConfig(
  state: InstanceMutableState,
  env: KiloClawEnv,
  patch: Record<string, unknown>
): Promise<{ ok: boolean }> {
  return callGatewayController(
    state,
    env,
    '/_kilo/config/patch',
    'POST',
    GatewayCommandResponseSchema,
    patch
  );
}

/**
 * Poll the gateway status endpoint until the OpenClaw gateway process
 * reports state === 'running'. On timeout, logs a warning but does NOT throw.
 */
export async function waitForHealthy(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<boolean> {
  const routingTarget = await getProviderAdapter(env, state).getRoutingTarget({
    env,
    state,
  });
  const url = `${routingTarget.origin}/_kilo/gateway/status`;
  const deadline = Date.now() + HEALTH_PROBE_TIMEOUT_SECONDS * 1000;

  let gatewayToken: string | undefined;
  if (state.sandboxId && env.GATEWAY_TOKEN_SECRET) {
    gatewayToken = await deriveGatewayToken(state.sandboxId, env.GATEWAY_TOKEN_SECRET);
  }

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: {
          ...(gatewayToken && { Authorization: `Bearer ${gatewayToken}` }),
          Accept: 'application/json',
          ...routingTarget.headers,
        },
      });
      if (res.ok) {
        const body: { state?: string } = await res.json();
        if (body.state === 'running') {
          const rootUrl = `${routingTarget.origin}/`;
          try {
            const rootRes = await fetch(rootUrl, {
              headers: routingTarget.headers,
            });
            if (rootRes.status !== 502) {
              console.log(
                '[DO] Gateway health probe passed (state: running, root:',
                rootRes.status,
                ')'
              );
              return true;
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

  doWarn(state, 'Gateway health probe timed out — proceeding anyway', {
    timeoutSeconds: HEALTH_PROBE_TIMEOUT_SECONDS,
  });
  return false;
}
