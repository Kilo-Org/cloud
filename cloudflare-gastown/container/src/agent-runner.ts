import { cloneRepo, createWorktree } from './git-manager';
import { startAgent } from './process-manager';
import type { ManagedAgent, StartAgentRequest } from './types';

/**
 * Resolve an env var: prefer the request-provided value, then the container's
 * inherited process env, then undefined (omitted from the child env so the
 * inherited value from process.env flows through naturally via mergedEnv).
 */
function resolveEnv(request: StartAgentRequest, key: string): string | undefined {
  return request.envVars?.[key] ?? process.env[key];
}

/**
 * Build KILO_CONFIG_CONTENT JSON so kilo serve can authenticate with
 * the Kilo LLM gateway. Mirrors the pattern in cloud-agent-next's
 * session-service.ts getSaferEnvVars().
 */
function buildKiloConfigContent(kilocodeToken: string): string {
  return JSON.stringify({
    provider: {
      kilo: {
        options: {
          apiKey: kilocodeToken,
          kilocodeToken,
        },
      },
    },
  });
}

function buildAgentEnv(request: StartAgentRequest): Record<string, string> {
  const env: Record<string, string> = {
    GASTOWN_AGENT_ID: request.agentId,
    GASTOWN_RIG_ID: request.rigId,
    GASTOWN_TOWN_ID: request.townId,

    GIT_AUTHOR_NAME: `${request.name} (gastown)`,
    GIT_AUTHOR_EMAIL: `${request.name}@gastown.local`,
    GIT_COMMITTER_NAME: `${request.name} (gastown)`,
    GIT_COMMITTER_EMAIL: `${request.name}@gastown.local`,
  };

  // Conditionally set config vars — only when a value is available from
  // the request or the container's own environment.
  const conditionalKeys = [
    'GASTOWN_API_URL',
    'GASTOWN_SESSION_TOKEN',
    'KILO_API_URL',
    'KILOCODE_TOKEN',
  ];
  for (const key of conditionalKeys) {
    const value = resolveEnv(request, key);
    if (value) {
      env[key] = value;
    }
  }

  // Build KILO_CONFIG_CONTENT so kilo serve can authenticate LLM calls
  const kilocodeToken = env.KILOCODE_TOKEN;
  if (kilocodeToken) {
    env.KILO_CONFIG_CONTENT = buildKiloConfigContent(kilocodeToken);
  }

  if (request.envVars) {
    for (const [key, value] of Object.entries(request.envVars)) {
      if (!(key in env)) {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Run the full agent startup sequence:
 * 1. Clone/fetch the rig's git repo
 * 2. Create an isolated worktree for the agent's branch
 * 3. Start a kilo serve instance for the worktree (or reuse existing)
 * 4. Create a session and send the initial prompt via HTTP API
 */
export async function runAgent(request: StartAgentRequest): Promise<ManagedAgent> {
  await cloneRepo({
    rigId: request.rigId,
    gitUrl: request.gitUrl,
    defaultBranch: request.defaultBranch,
  });

  const workdir = await createWorktree({
    rigId: request.rigId,
    branch: request.branch,
  });

  const env = buildAgentEnv(request);

  return startAgent(request, workdir, env);
}
