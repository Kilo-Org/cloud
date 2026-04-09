/**
 * Container interaction: start agents, send messages, trigger merges, mint JWTs.
 * All container communication goes through the TownContainerDO stub.
 */

import { getTownContainerStub } from '../TownContainer.do';
import { signAgentJWT, signContainerJWT } from '../../util/jwt.util';
import { buildPolecatSystemPrompt } from '../../prompts/polecat-system.prompt';
import { buildMayorSystemPrompt } from '../../prompts/mayor-system.prompt';
import type { TownConfig, RigOverrideConfig } from '../../types';
import { buildContainerConfig, resolveModel, resolveSmallModel, resolveRigConfig } from './config';

const TOWN_LOG = '[Town.do]';

// Allowlist of git push flags that are safe to pass from rig config.
// Flags that bypass hooks (--no-verify), rewrite history (--force,
// --force-with-lease), or alter remote refs in dangerous ways are
// explicitly excluded to prevent config-driven bypass of protections.
const ALLOWED_GIT_PUSH_FLAGS = new Set([
  '--atomic',
  '--follow-tags',
  '--signed',
  '--no-signed',
  '--progress',
  '--no-progress',
  '--verbose',
  '--quiet',
  '--tags',
  '--porcelain',
  '--ipv4',
  '--ipv6',
  '--recurse-submodules=check',
  '--recurse-submodules=on-demand',
  '--recurse-submodules=no',
]);

/**
 * Filter git push flags against the allowlist. Returns only the safe subset.
 * Logs a warning for any rejected flags.
 */
function filterGitPushFlags(raw: string): string | undefined {
  const flags = raw.trim().split(/\s+/).filter(Boolean);
  const allowed: string[] = [];
  for (const flag of flags) {
    if (ALLOWED_GIT_PUSH_FLAGS.has(flag)) {
      allowed.push(flag);
    } else {
      console.warn(`${TOWN_LOG} filterGitPushFlags: rejecting unsafe flag "${flag}"`);
    }
  }
  return allowed.length > 0 ? allowed.join(' ') : undefined;
}

// Module-level diagnostic: stores the last container start error so
// callers can surface it via the admin API. Reset on each call.
let lastStartError: string | null = null;
export function getLastStartError(): string | null {
  return lastStartError;
}

/**
 * Resolve the GASTOWN_JWT_SECRET binding to a string.
 */
export async function resolveJWTSecret(env: Env): Promise<string | null> {
  const binding = env.GASTOWN_JWT_SECRET;
  if (!binding) {
    console.error(`${TOWN_LOG} resolveJWTSecret: GASTOWN_JWT_SECRET binding is falsy`);
    return null;
  }
  if (typeof binding === 'string') return binding;
  try {
    const secret = await binding.get();
    if (!secret) {
      console.error(`${TOWN_LOG} resolveJWTSecret: binding.get() returned falsy value`);
      return null;
    }
    return secret ?? null;
  } catch (err) {
    console.error(
      `${TOWN_LOG} resolveJWTSecret: binding.get() threw:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Mint a short-lived agent JWT for the given agent to authenticate
 * API calls back to the gastown worker.
 *
 * @deprecated Prefer container secrets (ensureContainerSecret) for new code.
 * Agent JWTs are retained for backwards compatibility during rollout.
 */
export async function mintAgentToken(
  env: Env,
  params: { agentId: string; rigId: string; townId: string; userId: string }
): Promise<string | null> {
  const secret = await resolveJWTSecret(env);
  if (!secret) return null;

  // 8h expiry — long enough for typical agent sessions, short enough to limit blast radius
  return signAgentJWT(
    { agentId: params.agentId, rigId: params.rigId, townId: params.townId, userId: params.userId },
    secret,
    8 * 3600
  );
}

/**
 * Mint a container-scoped JWT and push it to the TownContainerDO.
 * One JWT per container — shared by all agents in the town. Carries
 * { townId, userId, scope: 'container' } with 8h expiry.
 *
 * Pushes via both setEnvVar() (for next container boot) and
 * POST /refresh-token (for the running process). This ensures that
 * all code paths — existing agents, heartbeat, event persistence —
 * pick up the fresh token immediately.
 *
 * Returns the token so callers can also pass it as a per-agent env var.
 */
export async function ensureContainerToken(
  env: Env,
  townId: string,
  userId: string
): Promise<string | null> {
  const jwtSecret = await resolveJWTSecret(env);
  if (!jwtSecret) {
    console.error(`${TOWN_LOG} ensureContainerToken: no JWT secret available`);
    return null;
  }

  const token = signContainerJWT({ townId, userId }, jwtSecret);
  const container = getTownContainerStub(env, townId);

  // Store for next boot
  try {
    await container.setEnvVar('GASTOWN_CONTAINER_TOKEN', token);
    await container.setEnvVar('GASTOWN_TOWN_ID', townId);
  } catch (err) {
    console.warn(
      `${TOWN_LOG} ensureContainerToken: setEnvVar failed (container may not be running):`,
      err instanceof Error ? err.message : err
    );
  }

  // Push to running process so existing agents pick up the fresh token.
  // Throw on non-2xx so the alarm's throttle doesn't advance on failure.
  try {
    const resp = await container.fetch('http://container/refresh-token', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) {
      throw new Error(`container returned ${resp.status}`);
    }
  } catch (err) {
    // If the container isn't running yet, the token will be in envVars
    // when it boots. But if it IS running and rejected the refresh,
    // propagate the error so the alarm retries on the next tick.
    const isContainerDown =
      err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'));
    if (!isContainerDown) throw err;
  }

  return token;
}

/**
 * Alias for ensureContainerToken — both functions now push to the
 * running container process via POST /refresh-token. Kept as a
 * separate export for call-site readability (alarm code calls
 * "refresh", dispatch code calls "ensure").
 */
export const refreshContainerToken = ensureContainerToken;

/**
 * Force-refresh variant for manual user-triggered refreshes.
 *
 * Unlike ensureContainerToken (which tolerates a downed container
 * because the token is persisted in envVars for next boot), this
 * function throws on ANY failure to push the token to the running
 * container — including network errors. This ensures the UI reports
 * a real failure instead of a false success when the container
 * never actually received the fresh JWT.
 */
export async function forceRefreshContainerToken(
  env: Env,
  townId: string,
  userId: string
): Promise<string> {
  const jwtSecret = await resolveJWTSecret(env);
  if (!jwtSecret) {
    throw new Error('No JWT secret available — cannot mint container token');
  }

  const token = signContainerJWT({ townId, userId }, jwtSecret);
  const container = getTownContainerStub(env, townId);

  // Store for next boot (best-effort — the critical step is the live push below)
  try {
    await container.setEnvVar('GASTOWN_CONTAINER_TOKEN', token);
    await container.setEnvVar('GASTOWN_TOWN_ID', townId);
  } catch (err) {
    console.warn(
      `${TOWN_LOG} forceRefreshContainerToken: setEnvVar failed:`,
      err instanceof Error ? err.message : err
    );
  }

  // Push to running container — propagate ALL errors so the caller
  // (and ultimately the UI) knows the refresh didn't land.
  const resp = await container.fetch('http://container/refresh-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `Container rejected token refresh (HTTP ${resp.status})${body ? `: ${body.slice(0, 200)}` : ''}`
    );
  }

  return token;
}

/** Build the initial prompt for an agent from its bead. */
export function buildPrompt(params: {
  beadTitle: string;
  beadBody: string;
  checkpoint: unknown;
  conversationHistory?: string;
}): string {
  const parts: string[] = [];
  if (params.conversationHistory) {
    parts.push(params.conversationHistory);
  }
  parts.push(params.beadTitle);
  if (params.beadBody) parts.push(params.beadBody);
  if (params.checkpoint) {
    parts.push(
      `Resume from checkpoint:\n${typeof params.checkpoint === 'string' ? params.checkpoint : JSON.stringify(params.checkpoint)}`
    );
  }
  return parts.join('\n\n');
}

/** Build the system prompt for an agent given its role and context. */
export function systemPromptForRole(params: {
  role: string;
  identity: string;
  agentName: string;
  rigId: string;
  townId: string;
  gates: string[];
}): string {
  switch (params.role) {
    case 'polecat':
      return buildPolecatSystemPrompt({
        agentName: params.agentName,
        rigId: params.rigId,
        townId: params.townId,
        identity: params.identity,
        gates: params.gates,
      });
    case 'mayor':
      return buildMayorSystemPrompt({
        identity: params.identity,
        townId: params.townId,
      });
    default: {
      const base = `You are ${params.identity}, a Gastown ${params.role} agent. Follow all instructions in the GASTOWN CONTEXT injected into this session.`;
      switch (params.role) {
        case 'refinery':
          return `${base} You review code quality and merge PRs. Check for correctness, style, and test coverage.`;
        default:
          return base;
      }
    }
  }
}

/**
 * Append per-role custom instructions to a system prompt.
 * Accepts either a TownConfig (falls back to town-level instructions)
 * or a pre-resolved instructions string. Returns the prompt unchanged
 * when no custom instructions exist for the role.
 */
export function appendCustomInstructions(
  systemPrompt: string,
  role: string,
  townConfig: TownConfig,
  resolvedInstructions?: string | null
): string {
  const roleKey = role as keyof NonNullable<TownConfig['custom_instructions']>;
  const instructions = (resolvedInstructions ?? townConfig.custom_instructions?.[roleKey])?.trim();
  if (!instructions) return systemPrompt;
  return `${systemPrompt}\n\n## Custom Instructions (from town settings)\n\n${instructions}`;
}

/** Generate a branch name for an agent working on a specific bead. */
export function branchForAgent(name: string, beadId?: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  const beadSuffix = beadId ? `/${beadId.slice(0, 8)}` : '';
  return `gt/${slug}${beadSuffix}`;
}

/**
 * Generate a branch name for a convoy bead's agent.
 *
 * Agent branches are siblings of the convoy feature branch's /head ref,
 * not children of it. Git refs are file-based: a ref at path X blocks
 * refs under X/. The convoy feature branch ends with /head (a leaf),
 * and agent branches sit alongside it under the same convoy prefix:
 *
 *   convoy/<slug>/<id>/head             ← feature branch
 *   convoy/<slug>/<id>/gt/<agent>/<bead> ← agent branch (sibling)
 *
 * Both are entries within the <id>/ directory, so no ref conflict.
 */
export function branchForConvoyAgent(
  convoyFeatureBranch: string,
  name: string,
  beadId: string
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  // Strip /head suffix to get the convoy prefix, then place the agent branch as a sibling
  const convoyPrefix = convoyFeatureBranch.replace(/\/head$/, '');
  return `${convoyPrefix}/gt/${slug}/${beadId.slice(0, 8)}`;
}

/**
 * Signal the container to start an agent process.
 * Attaches current town config via X-Town-Config header.
 */
export async function startAgentInContainer(
  env: Env,
  storage: DurableObjectStorage,
  params: {
    townId: string;
    rigId: string;
    userId: string;
    agentId: string;
    agentName: string;
    role: string;
    identity: string;
    beadId: string;
    beadTitle: string;
    beadBody: string;
    checkpoint: unknown;
    /** Reconstructed conversation transcript for prompt injection on re-dispatch. */
    conversationHistory?: string;
    gitUrl: string;
    defaultBranch: string;
    kilocodeToken?: string;
    townConfig: TownConfig;
    /** Rig-level config overrides. When present, merged on top of townConfig for model, custom_instructions, and git_push_flags. */
    rigOverride?: RigOverrideConfig | null;
    systemPromptOverride?: string;
    platformIntegrationId?: string;
    /** For convoy beads: the convoy's feature branch to branch from instead of defaultBranch. */
    convoyFeatureBranch?: string;
    /** Skip repo clone — use a lightweight workspace (for reasoning-only agents like triage). */
    lightweight?: boolean;
    /** All rigs in the town (mayor only) — used to set up browse worktrees on fresh containers. */
    rigs?: Array<{
      rigId: string;
      gitUrl: string;
      defaultBranch: string;
      platformIntegrationId?: string;
    }>;
  }
): Promise<boolean> {
  lastStartError = null;
  console.log(
    `${TOWN_LOG} startAgentInContainer: agentId=${params.agentId} role=${params.role} name=${params.agentName}`
  );
  try {
    // Mint a container-scoped JWT (8h expiry, refreshed by TownDO alarm).
    // One token per container — shared by all agents in the town.
    // Carries { townId, userId, scope: 'container' }.
    const containerToken = await ensureContainerToken(env, params.townId, params.userId);

    // Also mint a per-agent JWT as fallback during rollout.
    const agentToken = await mintAgentToken(env, {
      agentId: params.agentId,
      rigId: params.rigId,
      townId: params.townId,
      userId: params.userId,
    });

    if (!containerToken && !agentToken) {
      console.error(
        `${TOWN_LOG} startAgentInContainer: ABORTING — failed to mint any auth token for agent ${params.agentId}. ` +
          'The agent would start without credentials and be unable to call back to the worker.'
      );
      return false;
    }

    // Build env vars from town config
    const envVars: Record<string, string> = { ...(params.townConfig.env_vars ?? {}) };

    // Map git_auth tokens
    if (params.townConfig.git_auth?.github_token) {
      envVars.GIT_TOKEN = params.townConfig.git_auth.github_token;
    }
    if (params.townConfig.git_auth?.gitlab_token) {
      envVars.GITLAB_TOKEN = params.townConfig.git_auth.gitlab_token;
    }
    if (params.townConfig.git_auth?.gitlab_instance_url) {
      envVars.GITLAB_INSTANCE_URL = params.townConfig.git_auth.gitlab_instance_url;
    }

    // GitHub CLI PAT — used exclusively for `gh` CLI operations (PRs, issues).
    // Separate from GIT_TOKEN which is used for git clone/push.
    if (params.townConfig.github_cli_pat) {
      envVars.GITHUB_CLI_PAT = params.townConfig.github_cli_pat;
    }

    // Custom git commit identity
    if (params.townConfig.git_author_name) {
      envVars.GASTOWN_GIT_AUTHOR_NAME = params.townConfig.git_author_name;
    }
    if (params.townConfig.git_author_email) {
      envVars.GASTOWN_GIT_AUTHOR_EMAIL = params.townConfig.git_author_email;
    }
    if (params.townConfig.disable_ai_coauthor) {
      envVars.GASTOWN_DISABLE_AI_COAUTHOR = '1';
    }

    // Container token is preferred (shared by all agents, refreshed by alarm).
    // Legacy per-agent JWT kept as fallback during rollout.
    if (containerToken) envVars.GASTOWN_CONTAINER_TOKEN = containerToken;
    if (agentToken) envVars.GASTOWN_SESSION_TOKEN = agentToken;
    // kilocodeToken: prefer rig-level, fall back to town config
    const kilocodeToken = params.kilocodeToken ?? params.townConfig.kilocode_token;
    if (kilocodeToken) envVars.KILOCODE_TOKEN = kilocodeToken;

    console.log(
      `${TOWN_LOG} startAgentInContainer: envVars built: keys=[${Object.keys(envVars).join(',')}] hasGitToken=${!!envVars.GIT_TOKEN} hasGitlabToken=${!!envVars.GITLAB_TOKEN} hasContainerToken=${!!containerToken} hasAgentJwt=${!!agentToken} hasKilocodeToken=${!!kilocodeToken} git_auth_keys=[${Object.keys(params.townConfig.git_auth ?? {}).join(',')}]`
    );

    const containerConfig = await buildContainerConfig(storage, env);
    const container = getTownContainerStub(env, params.townId);

    const rigOverride = params.rigOverride ?? null;
    const effectiveConfig = resolveRigConfig(params.townConfig, rigOverride);

    const response = await container.fetch('http://container/agents/start', {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Town-Config': JSON.stringify(containerConfig),
      },
      body: JSON.stringify({
        agentId: params.agentId,
        rigId: params.rigId,
        townId: params.townId,
        role: params.role,
        name: params.agentName,
        identity: params.identity,
        prompt: buildPrompt({
          beadTitle: params.beadTitle,
          beadBody: params.beadBody,
          checkpoint: params.checkpoint,
          conversationHistory: params.conversationHistory,
        }),
        model: resolveModel(params.townConfig, rigOverride, params.role),
        smallModel: resolveSmallModel(params.townConfig),
        systemPrompt: appendCustomInstructions(
          params.systemPromptOverride ??
            systemPromptForRole({
              role: params.role,
              identity: params.identity,
              agentName: params.agentName,
              rigId: params.rigId,
              townId: params.townId,
              gates: params.townConfig.refinery?.gates ?? [],
            }),
          params.role,
          params.townConfig,
          effectiveConfig.custom_instructions[
            params.role as keyof typeof effectiveConfig.custom_instructions
          ]
        ),
        ...(effectiveConfig.git_push_flags
          ? (() => {
              const safe = filterGitPushFlags(effectiveConfig.git_push_flags);
              return safe ? { gitPushFlags: safe } : {};
            })()
          : {}),
        gitUrl: params.gitUrl,
        branch: params.convoyFeatureBranch
          ? branchForConvoyAgent(params.convoyFeatureBranch, params.agentName, params.beadId)
          : branchForAgent(params.agentName, params.beadId),
        // Always use the rig's real default branch for the initial git clone.
        // The agent's working branch is created as a worktree from HEAD after
        // clone; for convoy agents the startPoint below positions that worktree
        // at the convoy's feature branch tip.
        defaultBranch: params.defaultBranch,
        envVars,
        platformIntegrationId: params.platformIntegrationId,
        // For convoy agents, start from the convoy's feature branch so the
        // worktree includes all previously merged convoy work.
        startPoint: params.convoyFeatureBranch ? `origin/${params.convoyFeatureBranch}` : undefined,
        lightweight: params.lightweight,
        // Org-owned towns: pass the organization ID so agents bill to the correct team
        organizationId: params.townConfig.organization_id,
        rigs: params.rigs,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      // "Already running" means a previous dispatch succeeded — the agent
      // IS alive in the container. Treat as success so the DO marks the
      // agent as working and stops retrying.
      if (response.status === 500 && text.includes('already running')) {
        console.log(
          `${TOWN_LOG} startAgentInContainer: agent ${params.agentId} already running — treating as success`
        );
        return true;
      }
      const errorMsg = `(${response.status}) ${text.slice(0, 300)}`;
      console.error(
        `${TOWN_LOG} startAgentInContainer: error response for ` +
          `agent=${params.agentId} role=${params.role}: ${errorMsg}`
      );
      lastStartError = errorMsg;
    }
    return response.ok;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TOWN_LOG} startAgentInContainer: EXCEPTION for agent ${params.agentId}:`, err);
    lastStartError = `EXCEPTION: ${message.slice(0, 300)}`;
    return false;
  }
}

/**
 * Signal the container to run a deterministic merge.
 */
export async function startMergeInContainer(
  env: Env,
  storage: DurableObjectStorage,
  params: {
    townId: string;
    rigId: string;
    agentId: string;
    entryId: string;
    beadId: string;
    branch: string;
    targetBranch: string;
    gitUrl: string;
    kilocodeToken?: string;
    townConfig: TownConfig;
  }
): Promise<boolean> {
  try {
    const userId = params.townConfig.owner_user_id ?? params.townId;
    const containerToken = await ensureContainerToken(env, params.townId, userId);
    const agentToken = await mintAgentToken(env, {
      agentId: params.agentId,
      rigId: params.rigId,
      townId: params.townId,
      userId,
    });

    if (!containerToken && !agentToken) {
      console.error(
        `${TOWN_LOG} startMergeInContainer: ABORTING — failed to mint any auth token for merge entry ${params.entryId}. ` +
          'The merge process would start without credentials and be unable to report results.'
      );
      return false;
    }

    const envVars: Record<string, string> = { ...(params.townConfig.env_vars ?? {}) };
    if (params.townConfig.git_auth?.github_token) {
      envVars.GIT_TOKEN = params.townConfig.git_auth.github_token;
    }
    if (params.townConfig.git_auth?.gitlab_token) {
      envVars.GITLAB_TOKEN = params.townConfig.git_auth.gitlab_token;
    }
    if (params.townConfig.git_auth?.gitlab_instance_url) {
      envVars.GITLAB_INSTANCE_URL = params.townConfig.git_auth.gitlab_instance_url;
    }
    if (containerToken) envVars.GASTOWN_CONTAINER_TOKEN = containerToken;
    if (agentToken) envVars.GASTOWN_SESSION_TOKEN = agentToken;
    if (env.GASTOWN_API_URL) envVars.GASTOWN_API_URL = env.GASTOWN_API_URL;
    const mergeKilocodeToken = params.kilocodeToken ?? params.townConfig.kilocode_token;
    if (mergeKilocodeToken) envVars.KILOCODE_TOKEN = mergeKilocodeToken;

    const containerConfig = await buildContainerConfig(storage, env);
    const container = getTownContainerStub(env, params.townId);

    const response = await container.fetch('http://container/git/merge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Town-Config': JSON.stringify(containerConfig),
      },
      body: JSON.stringify({
        townId: params.townId,
        rigId: params.rigId,
        branch: params.branch,
        targetBranch: params.targetBranch,
        gitUrl: params.gitUrl,
        entryId: params.entryId,
        beadId: params.beadId,
        agentId: params.agentId,
        envVars,
      }),
    });

    if (!response.ok) {
      console.error(
        `${TOWN_LOG} startMergeInContainer: failed for entry ${params.entryId}: ${response.status}`
      );
    }
    return response.ok;
  } catch (err) {
    console.error(`${TOWN_LOG} startMergeInContainer: failed for entry ${params.entryId}:`, err);
    return false;
  }
}

/**
 * Check the container for an agent's process status.
 */
export async function checkAgentContainerStatus(
  env: Env,
  townId: string,
  agentId: string
): Promise<{ status: string; exitReason?: string }> {
  try {
    const container = getTownContainerStub(env, townId);
    const response = await container.fetch(`http://container/agents/${agentId}/status`, {
      signal: AbortSignal.timeout(10_000),
    });
    // 404 means the container is running but has no record of this agent
    // (e.g. after container eviction). Report as 'not_found' so
    // witnessPatrol can immediately reset and redispatch the agent
    // instead of waiting for the 2-hour GUPP timeout.
    if (response.status === 404) return { status: 'not_found' };
    // Non-OK but not 404 — container is having issues but may still
    // have the agent running. Return 'unknown' so witnessPatrol doesn't
    // falsely reset a working agent.
    if (!response.ok) return { status: 'unknown' };
    const data: unknown = await response.json();
    if (typeof data === 'object' && data !== null && 'status' in data) {
      const status = (data as { status: unknown }).status;
      const exitReason =
        'exitReason' in data ? (data as { exitReason: unknown }).exitReason : undefined;
      return {
        status: typeof status === 'string' ? status : 'unknown',
        exitReason: typeof exitReason === 'string' ? exitReason : undefined,
      };
    }
    return { status: 'unknown' };
  } catch {
    // Timeout, network error, or container starting up — return
    // 'unknown' so witnessPatrol doesn't falsely reset working agents.
    // True zombies will be caught after repeated 'unknown' results
    // once the GIPP/heartbeat timeout expires.
    return { status: 'unknown' };
  }
}

/**
 * Best-effort stop of an agent in the container.
 */
export async function stopAgentInContainer(
  env: Env,
  townId: string,
  agentId: string
): Promise<void> {
  try {
    const container = getTownContainerStub(env, townId);
    await container.fetch(`http://container/agents/${agentId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    // Best-effort
  }
}

/**
 * Push the latest dashboard context XML to the running container.
 * Best-effort — silently ignores failures if the container is down.
 */
export async function pushDashboardContext(
  env: Env,
  townId: string,
  context: string
): Promise<void> {
  const container = getTownContainerStub(env, townId);
  try {
    const resp = await container.fetch('http://container/dashboard-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
    });
    if (!resp.ok) {
      console.warn(`${TOWN_LOG} pushDashboardContext: container returned ${resp.status}`);
    }
  } catch {
    // Container not running — context will be pushed on next navigation
  }
}

/**
 * Send a follow-up message to an existing agent in the container.
 */
export async function sendMessageToAgent(
  env: Env,
  townId: string,
  agentId: string,
  message: string
): Promise<boolean> {
  try {
    const container = getTownContainerStub(env, townId);
    const response = await container.fetch(`http://container/agents/${agentId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: message }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Rewrite the mayor's AGENTS.md with an updated system prompt.
 * Called when custom instructions change so the running mayor picks them up.
 */
export async function updateMayorSystemPromptInContainer(
  env: Env,
  townId: string,
  agentId: string,
  systemPrompt: string
): Promise<boolean> {
  try {
    const container = getTownContainerStub(env, townId);
    const response = await container.fetch(`http://container/agents/${agentId}/system-prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Hot-update the model for a running agent without restarting the session.
 * Best-effort — returns false if the container is down or the agent is not running.
 */
export async function updateAgentModelInContainer(
  env: Env,
  townId: string,
  agentId: string,
  model: string,
  smallModel?: string,
  conversationHistory?: string,
  containerConfig?: Record<string, unknown>,
  organizationId?: string
): Promise<boolean> {
  try {
    const container = getTownContainerStub(env, townId);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (containerConfig) {
      headers['X-Town-Config'] = JSON.stringify(containerConfig);
    }
    const response = await container.fetch(`http://container/agents/${agentId}/model`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        model,
        ...(smallModel ? { smallModel } : {}),
        ...(conversationHistory ? { conversationHistory } : {}),
        ...(organizationId ? { organizationId } : {}),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
