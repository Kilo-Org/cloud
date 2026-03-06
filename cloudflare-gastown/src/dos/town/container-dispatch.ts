/**
 * Container interaction: start agents, send messages, trigger merges, mint JWTs.
 * All container communication goes through the TownContainerDO stub.
 */

import { getTownContainerStub } from '../TownContainer.do';
import { signAgentJWT } from '../../util/jwt.util';
import { buildPolecatSystemPrompt } from '../../prompts/polecat-system.prompt';
import { buildMayorSystemPrompt } from '../../prompts/mayor-system.prompt';
import type { TownConfig } from '../../types';
import { buildContainerConfig, resolveModel, resolveSmallModel } from './config';

const TOWN_LOG = '[Town.do]';

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

/** Build the initial prompt for an agent from its bead. */
export function buildPrompt(params: {
  beadTitle: string;
  beadBody: string;
  checkpoint: unknown;
}): string {
  const parts: string[] = [params.beadTitle];
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
}): string {
  switch (params.role) {
    case 'polecat':
      return buildPolecatSystemPrompt({
        agentName: params.agentName,
        rigId: params.rigId,
        townId: params.townId,
        identity: params.identity,
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
        case 'witness':
          return `${base} You monitor agent health and report anomalies.`;
        default:
          return base;
      }
    }
  }
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
    gitUrl: string;
    defaultBranch: string;
    kilocodeToken?: string;
    townConfig: TownConfig;
    systemPromptOverride?: string;
    platformIntegrationId?: string;
    /** For convoy beads: the convoy's feature branch to branch from instead of defaultBranch. */
    convoyFeatureBranch?: string;
  }
): Promise<boolean> {
  console.log(
    `${TOWN_LOG} startAgentInContainer: agentId=${params.agentId} role=${params.role} name=${params.agentName}`
  );
  try {
    const token = await mintAgentToken(env, {
      agentId: params.agentId,
      rigId: params.rigId,
      townId: params.townId,
      userId: params.userId,
    });

    if (!token) {
      console.error(
        `${TOWN_LOG} startAgentInContainer: ABORTING — failed to mint JWT for agent ${params.agentId}. ` +
          'The agent would start without GASTOWN_SESSION_TOKEN and be unable to call back to the worker.'
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

    if (token) envVars.GASTOWN_SESSION_TOKEN = token;
    // kilocodeToken: prefer rig-level, fall back to town config
    const kilocodeToken = params.kilocodeToken ?? params.townConfig.kilocode_token;
    if (kilocodeToken) envVars.KILOCODE_TOKEN = kilocodeToken;

    console.log(
      `${TOWN_LOG} startAgentInContainer: envVars built: keys=[${Object.keys(envVars).join(',')}] hasGitToken=${!!envVars.GIT_TOKEN} hasGitlabToken=${!!envVars.GITLAB_TOKEN} hasJwt=${!!token} hasKilocodeToken=${!!kilocodeToken} git_auth_keys=[${Object.keys(params.townConfig.git_auth ?? {}).join(',')}]`
    );

    const containerConfig = await buildContainerConfig(storage, env);
    const container = getTownContainerStub(env, params.townId);

    const response = await container.fetch('http://container/agents/start', {
      method: 'POST',
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
        }),
        model: resolveModel(params.townConfig, params.rigId, params.role),
        smallModel: resolveSmallModel(params.townConfig),
        systemPrompt:
          params.systemPromptOverride ??
          systemPromptForRole({
            role: params.role,
            identity: params.identity,
            agentName: params.agentName,
            rigId: params.rigId,
            townId: params.townId,
          }),
        gitUrl: params.gitUrl,
        branch: params.convoyFeatureBranch
          ? branchForConvoyAgent(params.convoyFeatureBranch, params.agentName, params.beadId)
          : branchForAgent(params.agentName, params.beadId),
        // Always use the rig's real default branch for the initial git clone.
        // The convoy feature branch may not exist on the remote yet (the first
        // agent's work creates it via the refinery merge). The agent's working
        // branch is created as a worktree from HEAD after clone.
        defaultBranch: params.defaultBranch,
        envVars,
        platformIntegrationId: params.platformIntegrationId,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      console.error(`${TOWN_LOG} startAgentInContainer: error response: ${text.slice(0, 500)}`);
    }
    return response.ok;
  } catch (err) {
    console.error(`${TOWN_LOG} startAgentInContainer: EXCEPTION for agent ${params.agentId}:`, err);
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
    const token = await mintAgentToken(env, {
      agentId: params.agentId,
      rigId: params.rigId,
      townId: params.townId,
      userId: params.townConfig.owner_user_id ?? '',
    });

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
    if (token) envVars.GASTOWN_SESSION_TOKEN = token;
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
    // TODO: Generally you should use containerFetch which waits for ports to be available
    const response = await container.fetch(`http://container/agents/${agentId}/status`);
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
