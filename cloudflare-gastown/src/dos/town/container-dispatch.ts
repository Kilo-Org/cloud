/**
 * Container interaction: start agents, send messages, trigger merges, mint JWTs.
 * All container communication goes through the TownContainerDO stub.
 */

import { getTownContainerStub } from '../TownContainer.do';
import { signAgentJWT } from '../../util/jwt.util';
import { buildPolecatSystemPrompt } from '../../prompts/polecat-system.prompt';
import { buildMayorSystemPrompt } from '../../prompts/mayor-system.prompt';
import type { TownConfig } from '../../types';
import { buildContainerConfig } from './config';

const TOWN_LOG = '[Town.do]';

/**
 * Resolve the GASTOWN_JWT_SECRET binding to a string.
 */
export async function resolveJWTSecret(env: Env): Promise<string | null> {
  const binding = env.GASTOWN_JWT_SECRET;
  if (!binding) return null;
  if (typeof binding === 'string') return binding;
  try {
    return await binding.get();
  } catch {
    console.error('Failed to resolve GASTOWN_JWT_SECRET');
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
      `${TOWN_LOG} startAgentInContainer: envVars built: keys=[${Object.keys(envVars).join(',')}] hasJwt=${!!token} hasKilocodeToken=${!!kilocodeToken} paramToken=${!!params.kilocodeToken} configToken=${!!params.townConfig.kilocode_token}`
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
        model: params.townConfig.default_model ?? 'anthropic/claude-sonnet-4.6',
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
        branch: branchForAgent(params.agentName, params.beadId),
        defaultBranch: params.defaultBranch,
        envVars,
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
      // TODO: Why is userId ''?
      userId: '',
    });

    const envVars: Record<string, string> = { ...(params.townConfig.env_vars ?? {}) };
    if (params.townConfig.git_auth?.github_token) {
      envVars.GIT_TOKEN = params.townConfig.git_auth.github_token;
    }
    if (params.townConfig.git_auth?.gitlab_token) {
      envVars.GITLAB_TOKEN = params.townConfig.git_auth.gitlab_token;
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
    const data = await response.json<{ status: string; exitReason?: string }>();
    return { status: data.status, exitReason: data.exitReason ?? undefined };
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
