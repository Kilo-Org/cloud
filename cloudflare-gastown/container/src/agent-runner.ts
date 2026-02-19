import type { Config } from '@opencode-ai/sdk';
import { writeFile } from 'node:fs/promises';
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
    // Override the small model (used for title generation) to a valid
    // kilo-provider model. Without this, kilo serve defaults to
    // openai/gpt-5-nano which doesn't exist in the kilo provider,
    // causing ProviderModelNotFoundError that kills the entire prompt loop.
    small_model: 'anthropic/claude-haiku-4.5',
    model: 'anthropic/claude-sonnet-4.6',
    // Override the title agent to use a valid model (same as small_model).
    // kilo serve v1.0.23 resolves title model independently and the
    // small_model fallback doesn't prevent ProviderModelNotFoundError.
    agent: {
      title: {
        model: 'anthropic/claude-haiku-4.5',
      },
    },
    // Auto-approve everything — agents run headless in a container,
    // there's no human to answer permission prompts.
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'allow',
    },
  } satisfies Config);
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
 * Configure a git credential helper in the agent's environment so that
 * git push/fetch from the worktree can authenticate without SSH or
 * an interactive prompt. Writes credentials to /tmp (outside the worktree)
 * to prevent accidental commit of tokens.
 */
async function configureGitCredentials(
  workdir: string,
  gitUrl: string,
  envVars?: Record<string, string>
): Promise<void> {
  const token = envVars?.GIT_TOKEN ?? envVars?.GITHUB_TOKEN;
  const gitlabToken = envVars?.GITLAB_TOKEN;
  if (!token && !gitlabToken) return;

  try {
    const url = new URL(gitUrl);
    const credentialLine =
      gitlabToken && (url.hostname.includes('gitlab') || envVars?.GITLAB_INSTANCE_URL)
        ? `https://oauth2:${gitlabToken}@${url.hostname}`
        : token
          ? `https://x-access-token:${token}@${url.hostname}`
          : null;

    if (!credentialLine) return;

    // Write credentials to /tmp — outside the worktree so they can't be
    // accidentally committed by `git add .` or `git add -A`.
    const uniqueSuffix = workdir.replace(/[^a-zA-Z0-9]/g, '-');
    const credFile = `/tmp/.git-credentials${uniqueSuffix}`;
    await writeFile(credFile, credentialLine + '\n', { mode: 0o600 });

    // Configure the worktree to use credential-store pointing at this file
    const proc = Bun.spawn(['git', 'config', 'credential.helper', `store --file=${credFile}`], {
      cwd: workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
  } catch (err) {
    console.warn('Failed to configure git credentials:', err);
  }
}

/**
 * Run the full agent startup sequence:
 * 1. Clone/fetch the rig's git repo
 * 2. Create an isolated worktree for the agent's branch
 * 3. Configure git credentials for push/fetch
 * 4. Start a kilo serve instance for the worktree (or reuse existing)
 * 5. Create a session and send the initial prompt via HTTP API
 */
export async function runAgent(request: StartAgentRequest): Promise<ManagedAgent> {
  await cloneRepo({
    rigId: request.rigId,
    gitUrl: request.gitUrl,
    defaultBranch: request.defaultBranch,
    envVars: request.envVars,
  });

  const workdir = await createWorktree({
    rigId: request.rigId,
    branch: request.branch,
  });

  // Set up git credentials so the agent can push
  await configureGitCredentials(workdir, request.gitUrl, request.envVars);

  const env = buildAgentEnv(request);

  return startAgent(request, workdir, env);
}
