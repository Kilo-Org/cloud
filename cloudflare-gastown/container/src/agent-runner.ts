import type { Config } from '@kilocode/sdk';
import { writeFile } from 'node:fs/promises';
import { cloneRepo, createWorktree } from './git-manager';
import { startAgent } from './process-manager';
import { getCurrentTownConfig } from './control-server';
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
      code: {
        model: 'anthropic/claude-sonnet-4.6',
        // Auto-approve everything — agents run headless in a container,
        // there's no human to answer permission prompts.
        permission: {
          edit: 'allow',
          bash: 'allow',
          webfetch: 'allow',
          doom_loop: 'allow',
          external_directory: 'allow',
        },
      },
      general: {
        model: 'anthropic/claude-sonnet-4.6',
        // Auto-approve everything — agents run headless in a container,
        // there's no human to answer permission prompts.
        permission: {
          edit: 'allow',
          bash: 'allow',
          webfetch: 'allow',
          doom_loop: 'allow',
          external_directory: 'allow',
        },
      },
      plan: {
        model: 'anthropic/claude-sonnet-4.6',
        // Auto-approve everything — agents run headless in a container,
        // there's no human to answer permission prompts.
        permission: {
          edit: 'allow',
          bash: 'allow',
          webfetch: 'allow',
          doom_loop: 'allow',
          external_directory: 'allow',
        },
      },
      title: {
        model: 'anthropic/claude-haiku-4.5',
      },
      explore: {
        small_model: 'anthropic/claude-haiku-4.5',
        model: 'anthropic/claude-sonnet-4.6',
        // Auto-approve everything — agents run headless in a container,
        // there's no human to answer permission prompts.
        permission: {
          edit: 'allow',
          bash: 'allow',
          webfetch: 'allow',
          doom_loop: 'allow',
          external_directory: 'allow',
        },
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
  // (KILO_API_URL and KILO_OPENROUTER_BASE are set at the container level
  // via TownContainerDO.envVars and inherited through process.env.)
  const conditionalKeys = ['GASTOWN_API_URL', 'GASTOWN_SESSION_TOKEN', 'KILOCODE_TOKEN'];
  for (const key of conditionalKeys) {
    const value = resolveEnv(request, key);
    if (value) {
      env[key] = value;
    }
  }

  // Fall back to X-Town-Config for KILOCODE_TOKEN if not in request or process.env
  if (!env.KILOCODE_TOKEN) {
    const townConfig = getCurrentTownConfig();
    const tokenFromConfig =
      townConfig && typeof townConfig.kilocode_token === 'string'
        ? townConfig.kilocode_token
        : undefined;
    console.log(
      `[buildAgentEnv] KILOCODE_TOKEN fallback: townConfig=${townConfig ? 'present' : 'null'} hasToken=${!!tokenFromConfig} requestEnvKeys=${Object.keys(request.envVars ?? {}).join(',')}`
    );
    if (tokenFromConfig) {
      env.KILOCODE_TOKEN = tokenFromConfig;
    }
  }

  // Build KILO_CONFIG_CONTENT so kilo serve can authenticate LLM calls.
  // Must also set OPENCODE_CONFIG_CONTENT — kilo serve checks both names.
  const kilocodeToken = env.KILOCODE_TOKEN;
  if (kilocodeToken) {
    const configJson = buildKiloConfigContent(kilocodeToken);
    env.KILO_CONFIG_CONTENT = configJson;
    env.OPENCODE_CONFIG_CONTENT = configJson;
    console.log(`[buildAgentEnv] KILO_CONFIG_CONTENT set (model=${JSON.parse(configJson).model})`);
  } else {
    console.warn('[buildAgentEnv] No KILOCODE_TOKEN available — KILO_CONFIG_CONTENT not set');
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
 * Create a minimal git-initialized workspace for the mayor agent.
 * The mayor doesn't need a real repo clone — it's a conversational
 * orchestrator that delegates work via tools. But kilo serve requires
 * a git repo in the working directory.
 */
async function createMayorWorkspace(rigId: string): Promise<string> {
  const { mkdir: mkdirAsync } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const dir = `/workspace/rigs/${rigId}/mayor-workspace`;
  await mkdirAsync(dir, { recursive: true });

  // Initialize a bare git repo if not already present
  if (!existsSync(`${dir}/.git`)) {
    const init = Bun.spawn(['git', 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    await init.exited;
    const commit = Bun.spawn(['git', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await commit.exited;
    console.log(`Created mayor workspace at ${dir}`);
  }

  return dir;
}

/**
 * Run the full agent startup sequence:
 * 1. Clone/fetch the rig's git repo (or create minimal workspace for mayor)
 * 2. Create an isolated worktree for the agent's branch
 * 3. Configure git credentials for push/fetch
 * 4. Start a kilo serve instance for the worktree (or reuse existing)
 * 5. Create a session and send the initial prompt via HTTP API
 */
export async function runAgent(request: StartAgentRequest): Promise<ManagedAgent> {
  let workdir: string;

  if (request.role === 'mayor') {
    // Mayor doesn't need a repo clone — just a git-initialized directory
    workdir = await createMayorWorkspace(request.rigId);
  } else {
    await cloneRepo({
      rigId: request.rigId,
      gitUrl: request.gitUrl,
      defaultBranch: request.defaultBranch,
      envVars: request.envVars,
    });

    workdir = await createWorktree({
      rigId: request.rigId,
      branch: request.branch,
    });

    // Set up git credentials so the agent can push
    await configureGitCredentials(workdir, request.gitUrl, request.envVars);
  }

  const env = buildAgentEnv(request);

  return startAgent(request, workdir, env);
}
