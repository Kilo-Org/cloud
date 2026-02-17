import { cloneRepo, createWorktree } from './git-manager.js';
import { startProcess } from './process-manager.js';
import type { AgentProcess, StartAgentRequest } from './types.js';

/**
 * Configure environment variables for a Kilo CLI agent process.
 * These env vars tell the tool plugin how to reach the Gastown worker API.
 */
function buildAgentEnv(request: StartAgentRequest): Record<string, string> {
  const env: Record<string, string> = {
    // Gastown tool plugin config
    GASTOWN_API_URL: request.envVars?.GASTOWN_API_URL ?? '',
    GASTOWN_SESSION_TOKEN: request.envVars?.GASTOWN_SESSION_TOKEN ?? '',
    GASTOWN_AGENT_ID: request.agentId,
    GASTOWN_RIG_ID: request.rigId,
    GASTOWN_TOWN_ID: request.townId,

    // Kilo CLI / LLM config
    KILO_API_URL: request.envVars?.KILO_API_URL ?? '',

    // Git config for commits
    GIT_AUTHOR_NAME: `${request.name} (gastown)`,
    GIT_AUTHOR_EMAIL: `${request.name}@gastown.local`,
    GIT_COMMITTER_NAME: `${request.name} (gastown)`,
    GIT_COMMITTER_EMAIL: `${request.name}@gastown.local`,
  };

  // Merge any additional env vars from the request
  if (request.envVars) {
    for (const [key, value] of Object.entries(request.envVars)) {
      // Don't overwrite the ones we explicitly set above
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
