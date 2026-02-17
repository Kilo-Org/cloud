import { cloneRepo, createWorktree } from './git-manager.js';
import { startProcess } from './process-manager.js';
import type { AgentProcess, StartAgentRequest } from './types.js';

/**
 * Configure environment variables for a Kilo CLI agent process.
 * These env vars tell the tool plugin how to reach the Gastown worker API.
 */
/**
 * Resolve an env var: prefer the request-provided value, then the container's
 * inherited process env, then undefined (omitted from the child env so the
 * inherited value from process.env flows through naturally via mergedEnv).
 */
function resolveEnv(request: StartAgentRequest, key: string): string | undefined {
  return request.envVars?.[key] ?? process.env[key];
}

function buildAgentEnv(request: StartAgentRequest): Record<string, string> {
  const env: Record<string, string> = {
    // Always set — these are agent-specific identity vars
    GASTOWN_AGENT_ID: request.agentId,
    GASTOWN_RIG_ID: request.rigId,
    GASTOWN_TOWN_ID: request.townId,

    // Git config for commits
    GIT_AUTHOR_NAME: `${request.name} (gastown)`,
    GIT_AUTHOR_EMAIL: `${request.name}@gastown.local`,
    GIT_COMMITTER_NAME: `${request.name} (gastown)`,
    GIT_COMMITTER_EMAIL: `${request.name}@gastown.local`,
  };

  // Conditionally set config vars — only when a value is available from
  // the request or the container's own environment. This avoids overwriting
  // inherited process.env values with empty strings.
  const conditionalKeys = [
    'GASTOWN_API_URL',
    'GASTOWN_SESSION_TOKEN',
    'KILO_API_URL',
    'INTERNAL_API_SECRET',
  ];
  for (const key of conditionalKeys) {
    const value = resolveEnv(request, key);
    if (value) {
      env[key] = value;
    }
  }

  // Merge any additional env vars from the request
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
 * Build the Kilo CLI arguments for the agent.
 */
function buildCliArgs(request: StartAgentRequest): string[] {
  const args = [
    'code',
    '--model',
    request.model,
    '--system-prompt',
    request.systemPrompt,
    '--prompt',
    request.prompt,
    '--non-interactive',
  ];

  return args;
}

/**
 * Run the full agent startup sequence:
 * 1. Clone/fetch the rig's git repo
 * 2. Create an isolated worktree for the agent's branch
 * 3. Spawn the Kilo CLI process in that worktree
 */
export async function runAgent(request: StartAgentRequest): Promise<AgentProcess> {
  // 1. Clone or fetch the rig repo
  await cloneRepo({
    rigId: request.rigId,
    gitUrl: request.gitUrl,
    defaultBranch: request.defaultBranch,
  });

  // 2. Create worktree for this agent's branch
  const workdir = await createWorktree({
    rigId: request.rigId,
    branch: request.branch,
  });

  // 3. Build env and CLI args
  const env = buildAgentEnv(request);
  const cliArgs = buildCliArgs(request);

  // 4. Spawn the process
  return startProcess(request, workdir, cliArgs, env);
}
