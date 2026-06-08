import { z, type ZodType } from 'zod';
import type { KiloClawEnv } from '../../types';
import { deriveGatewayToken } from '../../auth/gateway-token';
import {
  type GatewayProcessStatus,
  GatewayProcessStatusSchema,
  GatewayCommandResponseSchema,
  BotIdentityResponseSchema,
  UserProfileResponseSchema,
  ConfigRestoreResponseSchema,
  ControllerVersionResponseSchema,
  GatewayReadyResponseSchema,
  EnvPatchResponseSchema,
  ToolsMdSectionSyncResponseSchema,
  OpenclawConfigResponseSchema,
  FileWriteResponseSchema as ValidationAwareFileWriteResponseSchema,
  type FileWriteResponse,
  type OpenclawFileWriteValidation,
  MorningBriefingStatusResponseSchema,
  MorningBriefingActionResponseSchema,
  MorningBriefingInterestsResponseSchema,
  OnboardingBriefingResponseSchema,
  MorningBriefingUserLocationResponseSchema,
  MorningBriefingReadResponseSchema,
  OpenclawWorkspaceImportResponseSchema,
  GatewayControllerError,
  AgentConfigListResponseSchema,
  type AgentConfigListResponse,
  AgentReadResponseSchema,
  type AgentReadResponse,
  AgentMutationResponseSchema,
  type AgentMutationResponse,
  AgentDefaultsMutationResponseSchema,
  type AgentDefaultsMutationResponse,
  AgentCreateResponseSchema,
  type AgentCreateResponse,
  AgentDeleteResponseSchema,
  type AgentDeleteResponse,
  type AgentConfigErrorEnvelope,
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
  if (state.status !== 'running') {
    throw new GatewayControllerError(409, 'Instance is not running');
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  responseSchema: ZodType<T>,
  jsonBody?: unknown,
  options?: { timeoutMs?: number }
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
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    response = await fetch(url, {
      method,
      headers,
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      signal: timeoutSignal,
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

export function writeUserProfile(
  state: InstanceMutableState,
  env: KiloClawEnv,
  userProfile: {
    userTimezone?: string | null;
    userLocation?: string | null;
  }
): Promise<{ ok: boolean; path: string }> {
  return callGatewayController(
    state,
    env,
    '/_kilo/user-profile',
    'POST',
    UserProfileResponseSchema,
    userProfile
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

function isMorningBriefingWarmupControllerError(error: unknown): boolean {
  if (!(error instanceof GatewayControllerError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('instance has no machine id') ||
    message.includes('instance not provisioned') ||
    message.includes('instance is not running') ||
    message.includes('gateway not running') ||
    message.includes('failed to reach gateway') ||
    message.includes('operation was aborted due to timeout')
  );
}

export async function getControllerVersion(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<{
  version: string;
  commit: string;
  openclawVersion?: string | null;
  openclawCommit?: string | null;
  apiVersion?: number;
  capabilities?: string[];
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

/**
 * Server-side fail-closed capability gate. Throws a typed GatewayControllerError
 * (501 `capability_unavailable`) when the controller image does not advertise the
 * required capability — so newer cloud code never silently proxies an agent
 * operation to an older controller that can't honor it. This is the real
 * enforcement boundary (UI gating is cosmetic; see plan §3c).
 */
async function requireControllerCapability(
  state: InstanceMutableState,
  env: KiloClawEnv,
  capability: string
): Promise<void> {
  const version = await getControllerVersion(state, env);
  if (!version?.capabilities?.includes(capability)) {
    throw new GatewayControllerError(
      501,
      `Controller does not advertise required capability "${capability}"`,
      'capability_unavailable'
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Agent config CRUD wrappers (controller: /_kilo/config/agents*)
// Each is capability-gated and fails closed on older controllers.
//
// Typed errors are RETURNED as an AgentConfigErrorEnvelope rather than thrown:
// GatewayControllerError's .status/.code are stripped crossing the DO RPC
// boundary (only .message survives), so the platform route reconstructs the
// HTTP response from the returned envelope. Unexpected non-controller errors
// still throw (→ generic 500 at the route). Same pattern as kilo-cli-run.ts.
// ──────────────────────────────────────────────────────────────────────

/**
 * Run an agent gateway call, converting any GatewayControllerError (capability
 * gate or controller response) into a serializable error envelope. Non-controller
 * errors propagate (the route maps them to a generic 500).
 */
async function callAgentEndpoint<T>(fn: () => Promise<T>): Promise<T | AgentConfigErrorEnvelope> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GatewayControllerError) {
      return { agentError: { status: error.status, code: error.code, message: error.message } };
    }
    throw error;
  }
}

/**
 * Timeout for the mutating agent endpoints. The controller serializes ALL agent
 * mutations (CLI create/delete AND native update/update-defaults) through one
 * per-config queue, and the CLI ops have their own 30s timeout. The default
 * 30s gateway timeout equals the CLI timeout, so the outer request can abort
 * (→ 503) before a queued or in-flight mutation finishes — masking the
 * controller's own typed outcome (e.g. 504 openclaw_cli_timeout) and leaving
 * the caller with ambiguous agent_exists/agent_not_found state.
 *
 * 180s budgets for several queued 30s CLI ops plus our own op, the post-CLI
 * config read, and network, so the controller's typed response wins the race
 * in realistic conditions. NOTE: the controller queue is unbounded, so this is
 * a pragmatic bound, not a guarantee — under pathological concurrency to a
 * single instance's config (many simultaneous mutations, which the single-user
 * isPending-gated UI does not produce) the queue wait could still exceed it.
 * Eliminating that entirely would require async operation IDs / stable replay
 * across Worker→DO→controller (deferred). Reads are not queued → 30s default.
 */
const AGENT_MUTATION_REQUEST_TIMEOUT_MS = 180_000;

/** GET /_kilo/config/agents — list the fleet (+ inherited defaults). */
export async function listAgents(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<AgentConfigListResponse | AgentConfigErrorEnvelope> {
  return callAgentEndpoint(async () => {
    await requireControllerCapability(state, env, 'config.agents.read');
    return callGatewayController(
      state,
      env,
      '/_kilo/config/agents',
      'GET',
      AgentConfigListResponseSchema
    );
  });
}

/**
 * GET /_kilo/config/agents/:id — read one agent's normalized config.
 * The controller 404s (`agent_not_found`) for an unknown id; that surfaces as a
 * returned envelope { status: 404, code: 'agent_not_found' } — distinct from an
 * old controller missing the route entirely (which the capability gate rejects).
 */
export async function getAgent(
  state: InstanceMutableState,
  env: KiloClawEnv,
  agentId: string
): Promise<AgentReadResponse | AgentConfigErrorEnvelope> {
  return callAgentEndpoint(async () => {
    await requireControllerCapability(state, env, 'config.agents.read');
    return callGatewayController(
      state,
      env,
      `/_kilo/config/agents/${encodeURIComponent(agentId)}`,
      'GET',
      AgentReadResponseSchema
    );
  });
}

/**
 * PATCH /_kilo/config/agents/:id — surgical edit of one agent's model & behavior.
 * The body ({ etag?, set, unset }) is forwarded opaquely; the tRPC layer (PR B)
 * supplies Zod-validated input and the controller re-validates. A stale etag
 * surfaces as GatewayControllerError(409, code='config_etag_conflict').
 */
export async function updateAgent(
  state: InstanceMutableState,
  env: KiloClawEnv,
  agentId: string,
  patch: Record<string, unknown>
): Promise<AgentMutationResponse | AgentConfigErrorEnvelope> {
  return callAgentEndpoint(async () => {
    await requireControllerCapability(state, env, 'config.agents.update');
    return callGatewayController(
      state,
      env,
      `/_kilo/config/agents/${encodeURIComponent(agentId)}`,
      'PATCH',
      AgentMutationResponseSchema,
      patch,
      { timeoutMs: AGENT_MUTATION_REQUEST_TIMEOUT_MS }
    );
  });
}

/**
 * PATCH /_kilo/config/agent-defaults — edit the fleet-wide inherited defaults
 * (model + thinking/verbose only; no reasoning/fastMode at the defaults level).
 * Body ({ etag?, set, unset }) forwarded opaquely; stale etag →
 * GatewayControllerError(409, code='config_etag_conflict').
 */
export async function updateAgentDefaults(
  state: InstanceMutableState,
  env: KiloClawEnv,
  patch: Record<string, unknown>
): Promise<AgentDefaultsMutationResponse | AgentConfigErrorEnvelope> {
  return callAgentEndpoint(async () => {
    await requireControllerCapability(state, env, 'config.agent-defaults.update');
    return callGatewayController(
      state,
      env,
      '/_kilo/config/agent-defaults',
      'PATCH',
      AgentDefaultsMutationResponseSchema,
      patch,
      { timeoutMs: AGENT_MUTATION_REQUEST_TIMEOUT_MS }
    );
  });
}

/**
 * POST /_kilo/config/agents — create an agent end-to-end (config + workspace +
 * session dirs) by delegating to the OpenClaw CLI. Body
 * ({ name, workspace, agentDir?, model?, bindings?[] }) forwarded opaquely.
 * Distinct error surface: 409 agent_exists, 400 reserved_agent_id,
 * 502 openclaw_cli_failed, 504 openclaw_cli_timeout.
 */
export async function createAgent(
  state: InstanceMutableState,
  env: KiloClawEnv,
  body: Record<string, unknown>
): Promise<AgentCreateResponse | AgentConfigErrorEnvelope> {
  return callAgentEndpoint(async () => {
    await requireControllerCapability(state, env, 'config.agents.create.basic.cli');
    return callGatewayController(
      state,
      env,
      '/_kilo/config/agents',
      'POST',
      AgentCreateResponseSchema,
      body,
      { timeoutMs: AGENT_MUTATION_REQUEST_TIMEOUT_MS }
    );
  });
}

/**
 * DELETE /_kilo/config/agents/:id — remove an agent + clean up references
 * (bindings, agent-to-agent allow rules) via the OpenClaw CLI. Does NOT confirm
 * on-disk files are gone (filesystemDisposition: 'unverified'). Rejects `main`
 * (400 reserved_agent_id). 502/504 on CLI failure/timeout.
 */
export async function deleteAgent(
  state: InstanceMutableState,
  env: KiloClawEnv,
  agentId: string
): Promise<AgentDeleteResponse | AgentConfigErrorEnvelope> {
  return callAgentEndpoint(async () => {
    await requireControllerCapability(state, env, 'config.agents.delete.cli');
    return callGatewayController(
      state,
      env,
      `/_kilo/config/agents/${encodeURIComponent(agentId)}`,
      'DELETE',
      AgentDeleteResponseSchema,
      undefined,
      { timeoutMs: AGENT_MUTATION_REQUEST_TIMEOUT_MS }
    );
  });
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
  env: KiloClawEnv,
  filePath?: string
): Promise<{ tree: unknown[] } | null> {
  const params = new URLSearchParams();
  if (filePath !== undefined) params.set('path', filePath);
  const path = `/_kilo/files/tree${params.toString() ? `?${params.toString()}` : ''}`;

  try {
    return await callGatewayController(state, env, path, 'GET', FileTreeResponseSchema);
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

const LegacyFileWriteResponseSchema = z.object({ etag: z.string() });

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
      LegacyFileWriteResponseSchema,
      { path: filePath, content, etag }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function writeOpenclawConfigFile(
  state: InstanceMutableState,
  env: KiloClawEnv,
  content: string,
  etag: string | undefined,
  mode: OpenclawFileWriteValidation
): Promise<FileWriteResponse | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/files/write-openclaw-config',
      'POST',
      ValidationAwareFileWriteResponseSchema,
      { content, etag, mode }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function importOpenclawWorkspace(
  state: InstanceMutableState,
  env: KiloClawEnv,
  files: Array<{ path: string; content: string }>
): Promise<z.infer<typeof OpenclawWorkspaceImportResponseSchema> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/files/import-openclaw-workspace',
      'POST',
      OpenclawWorkspaceImportResponseSchema,
      { files }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function getMorningBriefingStatus(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<z.infer<typeof MorningBriefingStatusResponseSchema> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/morning-briefing/status',
      'GET',
      MorningBriefingStatusResponseSchema,
      undefined,
      { timeoutMs: 5_000 }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    if (isMorningBriefingWarmupControllerError(error)) {
      return {
        ok: true,
        reconcileState: 'in_progress',
        error: 'Gateway warming up, retrying shortly.',
        code: 'gateway_warming_up',
        retryAfterSec: 2,
      };
    }
    throw error;
  }
}

export async function enableMorningBriefing(
  state: InstanceMutableState,
  env: KiloClawEnv,
  input: { cron?: string; timezone?: string }
): Promise<z.infer<typeof MorningBriefingActionResponseSchema> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/morning-briefing/enable',
      'POST',
      MorningBriefingActionResponseSchema,
      input,
      { timeoutMs: 8_000 }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function disableMorningBriefing(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<z.infer<typeof MorningBriefingActionResponseSchema> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/morning-briefing/disable',
      'POST',
      MorningBriefingActionResponseSchema,
      {},
      { timeoutMs: 8_000 }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function updateMorningBriefingInterests(
  state: InstanceMutableState,
  env: KiloClawEnv,
  input: { topics: string[] }
): Promise<z.infer<typeof MorningBriefingInterestsResponseSchema> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/morning-briefing/interests',
      'POST',
      MorningBriefingInterestsResponseSchema,
      input,
      { timeoutMs: 8_000 }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function updateMorningBriefingUserLocation(
  state: InstanceMutableState,
  env: KiloClawEnv,
  input: { userLocation: string | null }
): Promise<z.infer<typeof MorningBriefingUserLocationResponseSchema> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/morning-briefing/user-location',
      'POST',
      MorningBriefingUserLocationResponseSchema,
      input,
      { timeoutMs: 8_000 }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function runMorningBriefing(
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<z.infer<typeof MorningBriefingActionResponseSchema> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/morning-briefing/run',
      'POST',
      MorningBriefingActionResponseSchema,
      {},
      { timeoutMs: 120_000 }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function startOnboardingBriefing(
  state: InstanceMutableState,
  env: KiloClawEnv,
  settingsHref?: string
): Promise<z.infer<typeof OnboardingBriefingResponseSchema> | null> {
  try {
    // Returns fast: the plugin creates the conversation + loading bubble and
    // generates the briefing fire-and-forget, so the default timeout is fine.
    return await callGatewayController(
      state,
      env,
      '/_kilo/morning-briefing/onboarding-briefing',
      'POST',
      OnboardingBriefingResponseSchema,
      settingsHref ? { settingsHref } : {}
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
  }
}

export async function readMorningBriefing(
  state: InstanceMutableState,
  env: KiloClawEnv,
  day: 'today' | 'yesterday'
): Promise<z.infer<typeof MorningBriefingReadResponseSchema> | null> {
  try {
    return await callGatewayController(
      state,
      env,
      `/_kilo/morning-briefing/read/${day}`,
      'GET',
      MorningBriefingReadResponseSchema
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
 * Sync the Google Workspace section in TOOLS.md on the running machine.
 * Non-fatal: if the machine isn't running, returns null.
 */
export async function syncGoogleWorkspaceToolsSectionOnMachine(
  state: InstanceMutableState,
  env: KiloClawEnv,
  enabled: boolean
): Promise<{ ok: boolean; enabled: boolean } | null> {
  if (state.status !== 'running' || !getRuntimeId(state)) return null;
  try {
    return await callGatewayController(
      state,
      env,
      '/_kilo/config/tools-md/google-workspace',
      'POST',
      ToolsMdSectionSyncResponseSchema,
      { enabled }
    );
  } catch (error) {
    if (isErrorUnknownRoute(error)) return null;
    throw error;
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
