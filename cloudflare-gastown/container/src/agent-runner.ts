import type { Config } from '@kilocode/sdk';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { cloneRepo, createWorktree, setupRigBrowseWorktree } from './git-manager';
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

/** Prepend the kilo provider prefix to an OpenRouter-style model ID. */
export function kiloModel(openrouterModel: string): string {
  const trimmed = openrouterModel.trim();
  if (!trimmed) return 'kilo/kilo-auto/frontier';
  return trimmed.startsWith('kilo/') ? trimmed : `kilo/${trimmed}`;
}

const HEADLESS_PERMISSIONS = {
  edit: 'allow' as const,
  bash: 'allow' as const,
  webfetch: 'allow' as const,
  doom_loop: 'allow' as const,
  external_directory: 'allow' as const,
};

/**
 * Build KILO_CONFIG_CONTENT JSON so kilo serve can authenticate with
 * the Kilo LLM gateway. Both `model` and `smallModel` are OpenRouter-style
 * IDs (e.g. "anthropic/claude-sonnet-4.6") resolved from the town config.
 */
export function buildKiloConfigContent(
  kilocodeToken: string,
  model: string,
  smallModel: string,
  organizationId?: string
): string {
  const primaryModel = kiloModel(model);
  const smModel = kiloModel(smallModel);

  const providerOptions: Record<string, string> = {
    apiKey: kilocodeToken,
    kilocodeToken,
  };
  if (organizationId) {
    providerOptions.kilocodeOrganizationId = organizationId;
  }

  return JSON.stringify({
    provider: {
      kilo: {
        options: providerOptions,
        // Register models so the kilo server doesn't reject them before
        // routing to the gateway.
        models: {
          [primaryModel]: {},
          [smModel]: {},
        },
      },
    },
    // Override small_model (used for title generation). Without this, kilo
    // serve defaults to a model that doesn't exist in the kilo provider,
    // causing ProviderModelNotFoundError.
    small_model: smModel,
    model: primaryModel,
    agent: {
      code: { model: primaryModel, permission: HEADLESS_PERMISSIONS },
      general: { model: primaryModel, permission: HEADLESS_PERMISSIONS },
      plan: { model: primaryModel, permission: HEADLESS_PERMISSIONS },
      title: { model: smModel },
      explore: {
        small_model: smModel,
        model: primaryModel,
        permission: HEADLESS_PERMISSIONS,
      },
    },
    permission: HEADLESS_PERMISSIONS,
  } satisfies Config);
}

function buildAgentEnv(request: StartAgentRequest): Record<string, string> {
  // Custom git identity: when GASTOWN_GIT_AUTHOR_NAME is set, the user becomes
  // the primary author and the AI agent name is used for co-authorship trailers.
  const customAuthorName = resolveEnv(request, 'GASTOWN_GIT_AUTHOR_NAME');
  const customAuthorEmail = resolveEnv(request, 'GASTOWN_GIT_AUTHOR_EMAIL');
  const authorName = customAuthorName ?? `${request.name} (gastown)`;
  const authorEmail = customAuthorEmail ?? `${request.name}@gastown.local`;

  const env: Record<string, string> = {
    GASTOWN_AGENT_ID: request.agentId,
    GASTOWN_RIG_ID: request.rigId,
    GASTOWN_TOWN_ID: request.townId,
    GASTOWN_AGENT_ROLE: request.role,
    KILOCODE_FEATURE: 'gastown',

    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };

  // When custom author is set, provide the AI agent identity for co-authorship
  if (customAuthorName) {
    env.GASTOWN_AI_AGENT_NAME = `${request.name} (gastown)`;
    env.GASTOWN_AI_AGENT_EMAIL = `${request.name}@gastown.local`;
    if (resolveEnv(request, 'GASTOWN_DISABLE_AI_COAUTHOR') === '1') {
      env.GASTOWN_DISABLE_AI_COAUTHOR = '1';
    }
  }

  // Conditionally set config vars — only when a value is available from
  // the request or the container's own environment.
  // (KILO_API_URL and KILO_OPENROUTER_BASE are set at the container level
  // via TownContainerDO.envVars and inherited through process.env.)
  const conditionalKeys = [
    'GASTOWN_API_URL',
    'GASTOWN_CONTAINER_TOKEN',
    'GASTOWN_SESSION_TOKEN',
    'KILOCODE_TOKEN',
  ];
  for (const key of conditionalKeys) {
    const value = resolveEnv(request, key);
    if (value) {
      env[key] = value;
    }
  }

  console.log(`GASTOWN_API_URL="${env.GASTOWN_API_URL}"
GASTOWN_SESSION_TOKEN=${env.GASTOWN_SESSION_TOKEN ? '(set)' : '(not set)'}
GASTOWN_AGENT_ID="${env.GASTOWN_AGENT_ID}"
GASTOWN_RIG_ID="${env.GASTOWN_RIG_ID}"
GASTOWN_TOWN_ID="${env.GASTOWN_TOWN_ID}"`);

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
    const configJson = buildKiloConfigContent(
      kilocodeToken,
      request.model,
      request.smallModel ?? 'anthropic/claude-haiku-4.5',
      request.organizationId
    );
    env.KILO_CONFIG_CONTENT = configJson;
    env.OPENCODE_CONFIG_CONTENT = configJson;
    console.log(
      `[buildAgentEnv] KILO_CONFIG_CONTENT set (model=${request.model}, smallModel=${request.smallModel ?? '(default)'})`
    );
  } else {
    console.warn('[buildAgentEnv] No KILOCODE_TOKEN available — KILO_CONFIG_CONTENT not set');
  }

  // Authenticate the gh CLI via GH_TOKEN. Prefer the user's GitHub CLI PAT
  // (which makes PRs/issues appear under their identity) over the integration
  // token (which appears as the GitHub App bot).
  const ghCliPat = resolveEnv(request, 'GITHUB_CLI_PAT');
  const ghToken =
    ghCliPat ?? resolveEnv(request, 'GIT_TOKEN') ?? resolveEnv(request, 'GITHUB_TOKEN');
  if (ghToken) {
    env.GH_TOKEN = ghToken;
  }

  // Town-level env vars. The `!(key in env)` guard means infra-set vars
  // (GASTOWN_*, KILO_*, GH_TOKEN, etc.) take precedence over user config.
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
 * If no GIT_TOKEN/GITLAB_TOKEN is present in envVars but a platformIntegrationId
 * is available, call the Next.js server to resolve fresh credentials.
 * Returns the (potentially enriched) envVars.
 */
export async function resolveGitCredentials(params: {
  envVars?: Record<string, string>;
  platformIntegrationId?: string;
}): Promise<Record<string, string>> {
  const envVars = { ...(params.envVars ?? {}) };
  const hasToken = !!(envVars.GIT_TOKEN || envVars.GITHUB_TOKEN || envVars.GITLAB_TOKEN);

  if (hasToken) return envVars;

  const integrationId = params.platformIntegrationId;
  const kiloToken = envVars.KILOCODE_TOKEN;
  // The Next.js server URL — in dev it's localhost:3000, in prod it's the main app URL.
  // We derive it from KILO_API_URL (the gateway URL) or fall back to localhost.
  const apiBase = process.env.KILO_CLOUD_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';

  if (!integrationId) {
    console.warn(
      '[resolveGitCredentialsIfMissing] No git token and no platformIntegrationId — clone will likely fail'
    );
    return envVars;
  }

  if (!kiloToken) {
    console.warn(
      '[resolveGitCredentialsIfMissing] No KILOCODE_TOKEN — cannot authenticate to credential API'
    );
    return envVars;
  }

  console.log(
    `[resolveGitCredentialsIfMissing] Fetching fresh credentials for integration=${integrationId}`
  );

  try {
    const resp = await fetch(`${apiBase}/api/gastown/git-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${kiloToken}`,
      },
      body: JSON.stringify({ platform_integration_id: integrationId }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        `[resolveGitCredentialsIfMissing] API returned ${resp.status}: ${text.slice(0, 200)}`
      );
      return envVars;
    }

    const rawCreds: unknown = await resp.json();
    const creds = z
      .object({
        github_token: z.string().optional(),
        gitlab_token: z.string().optional(),
        gitlab_instance_url: z.string().optional(),
      })
      .parse(rawCreds);

    if (creds.github_token) {
      envVars.GIT_TOKEN = creds.github_token;
      console.log('[resolveGitCredentialsIfMissing] Got fresh GitHub token');
    }
    if (creds.gitlab_token) {
      envVars.GITLAB_TOKEN = creds.gitlab_token;
      console.log('[resolveGitCredentialsIfMissing] Got fresh GitLab token');
    }
    if (creds.gitlab_instance_url) {
      envVars.GITLAB_INSTANCE_URL = creds.gitlab_instance_url;
    }
  } catch (err) {
    console.error('[resolveGitCredentialsIfMissing] Failed to fetch credentials:', err);
  }

  return envVars;
}

/**
 * Pre-flight check: verify git credentials can authenticate against the remote.
 * Uses `git ls-remote` which tests auth without modifying anything.
 * Logs a clear warning on failure — the agent will still start, but push will fail.
 */
async function verifyGitCredentials(
  workdir: string,
  gitUrl: string,
  envVars?: Record<string, string>
): Promise<void> {
  const hasToken = !!(envVars?.GIT_TOKEN || envVars?.GITHUB_TOKEN || envVars?.GITLAB_TOKEN);
  if (!hasToken) {
    console.warn(
      `[verifyGitCredentials] No git token found in env vars (keys: ${Object.keys(envVars ?? {}).join(', ')}). ` +
        `Push will fail. Ensure git_auth is configured in town settings.`
    );
    return;
  }

  try {
    const proc = Bun.spawn(['git', 'ls-remote', '--exit-code', '--heads', 'origin'], {
      cwd: workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(
        `[verifyGitCredentials] FAILED for ${gitUrl}: exit=${exitCode} stderr=${stderr.slice(0, 300)}`
      );
    } else {
      console.log(`[verifyGitCredentials] OK for ${gitUrl}`);
    }
  } catch (err) {
    console.warn(`[verifyGitCredentials] Error testing credentials:`, err);
  }
}

/**
 * Create a minimal git-initialized workspace for a reasoning-only agent
 * (e.g. triage) that doesn't need a real repo clone.
 * kilo serve requires a git repo in the working directory, so we init
 * a bare local repo with an empty initial commit.
 */
async function createLightweightWorkspace(label: string, rigId: string): Promise<string> {
  const { mkdir: mkdirAsync } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const path = await import('node:path');
  // Validate to prevent path traversal
  // eslint-disable-next-line no-control-regex
  if (!rigId || /\.\.[/\\]|[/\\]\.\.|^\.\.$/.test(rigId) || /[\x00-\x1f]/.test(rigId)) {
    throw new Error(`Invalid rigId for lightweight workspace: ${rigId}`);
  }
  const dir = path.resolve('/workspace/rigs', rigId, `${label}-workspace`);
  await mkdirAsync(dir, { recursive: true });

  if (!existsSync(`${dir}/.git`)) {
    const init = Bun.spawn(['git', 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    await init.exited;
    const commit = Bun.spawn(['git', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await commit.exited;
    console.log(`Created ${label} workspace at ${dir}`);
  }

  return dir;
}

/**
 * Create a minimal git-initialized workspace for the mayor agent.
 * The mayor doesn't need a real repo clone — it's a conversational
 * orchestrator that delegates work via tools. But kilo serve requires
 * a git repo in the working directory.
 */
async function createMayorWorkspace(rigId: string): Promise<string> {
  return createLightweightWorkspace('mayor', rigId);
}

/**
 * Write the mayor's system prompt to AGENTS.md in the workspace.
 *
 * kilo/opencode reads AGENTS.md from the project root for ALL sessions,
 * including built-in sub-agents (explore, general). By writing the full
 * system prompt here instead of passing it via the session.prompt API,
 * the mayor and all its sub-agents share the exact same instructions.
 *
 * The system prompt comes from the TownDO (buildMayorSystemPrompt) and
 * is the single source of truth. When it changes (gastown updates,
 * user customization), the TownDO sends the updated prompt and we
 * rewrite this file.
 */
async function writeMayorSystemPromptToAgentsMd(
  workspaceDir: string,
  systemPrompt: string
): Promise<void> {
  const { writeFile, readdir, stat } = await import('node:fs/promises');
  const path = await import('node:path');

  // Append a dynamic section listing discovered browse worktrees so
  // sub-agents know where to find rig codebases.
  const rigsRoot = '/workspace/rigs';
  let rigDirs: string[] = [];
  try {
    rigDirs = await readdir(rigsRoot);
  } catch {
    // No rigs directory yet
  }

  const browseEntries: string[] = [];
  for (const entry of rigDirs) {
    if (entry.startsWith('mayor-')) continue;
    const browseDir = path.join(rigsRoot, entry, 'browse');
    try {
      const s = await stat(browseDir);
      if (s.isDirectory()) {
        browseEntries.push(`- **${entry}**: \`${browseDir}\``);
      }
    } catch {
      // No browse worktree yet
    }
  }

  const browseSuffix =
    browseEntries.length > 0
      ? `\n\n## Discovered Browse Worktrees\n\n${browseEntries.join('\n')}`
      : '';

  await writeFile(path.join(workspaceDir, 'AGENTS.md'), systemPrompt + browseSuffix);
}

/**
 * Run the full agent startup sequence:
 * 1. Clone/fetch the rig's git repo (or create minimal workspace for mayor/triage)
 * 2. Create an isolated worktree for the agent's branch
 * 3. Configure git credentials for push/fetch
 * 4. Start a kilo serve instance for the worktree (or reuse existing)
 * 5. Create a session and send the initial prompt via HTTP API
 */
export async function runAgent(originalRequest: StartAgentRequest): Promise<ManagedAgent> {
  let request = originalRequest;
  let workdir: string;

  if (request.role === 'triage' || request.lightweight) {
    // Triage/lightweight agents are pure reasoning — no code changes, no git needed.
    // Use a lightweight workspace to avoid clone failures feeding the loop.
    workdir = await createLightweightWorkspace('triage', request.rigId);
  } else if (request.role === 'mayor') {
    // Mayor doesn't need a repo clone — just a git-initialized directory
    workdir = await createMayorWorkspace(request.rigId);

    // On fresh containers the browse worktrees won't exist yet. Set them
    // up for all known rigs before writing AGENTS.md so the mayor (and its
    // sub-agents) can immediately browse codebases.
    if (request.rigs?.length) {
      // Resolve credentials per-rig since each may use a different
      // GitHub App installation (platformIntegrationId).
      const baseEnvVars = request.envVars ?? {};
      await Promise.allSettled(
        request.rigs.map(async rig => {
          try {
            const envVars = await resolveGitCredentials({
              envVars: baseEnvVars,
              platformIntegrationId: rig.platformIntegrationId,
            });
            await setupRigBrowseWorktree({
              rigId: rig.rigId,
              gitUrl: rig.gitUrl,
              defaultBranch: rig.defaultBranch,
              envVars,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
            console.warn(`[runAgent] browse worktree setup failed for rig=${rig.rigId}: ${msg}`);
          }
        })
      );
    }

    // Write the system prompt to AGENTS.md so the mayor AND its built-in
    // sub-agents (explore, general) all share the same instructions.
    // The system prompt is NOT passed via the session.prompt API — AGENTS.md
    // is the sole source of truth for the mayor's instructions.
    if (request.systemPrompt) {
      await writeMayorSystemPromptToAgentsMd(workdir, request.systemPrompt);
    }
  } else {
    // Resolve git credentials if missing. When the town config doesn't have
    // a token (common on first dispatch after rig creation), fetch one from
    // the Next.js server using the platform_integration_id.
    const envVars = await resolveGitCredentials(request);

    // Merge resolved credentials back into the request so buildAgentEnv
    // can propagate GIT_TOKEN/GH_TOKEN to the spawned kilo serve process.
    // Without this, rigs using platformIntegrationId would clone successfully
    // but the agent session itself would lack git push / gh credentials.
    request = { ...request, envVars };

    await cloneRepo({
      rigId: request.rigId,
      gitUrl: request.gitUrl,
      defaultBranch: request.defaultBranch,
      envVars,
    });

    workdir = await createWorktree({
      rigId: request.rigId,
      branch: request.branch,
      startPoint: request.startPoint,
      defaultBranch: request.defaultBranch,
    });

    // Set up git credentials so the agent can push
    await configureGitCredentials(workdir, request.gitUrl, envVars);

    // Pre-flight: verify git credentials can authenticate against the remote.
    await verifyGitCredentials(workdir, request.gitUrl, envVars);
  }

  const env = buildAgentEnv(request);

  // For the mayor, the system prompt lives in AGENTS.md (written above)
  // so all sessions — including sub-agents — share it. Don't also pass
  // it via the session.prompt API to avoid duplication. Setting to
  // undefined (not '') so the SDK omits it entirely and kilo serve
  // uses its default system prompt + AGENTS.md, rather than treating
  // an empty string as an explicit override.
  const startRequest = request.role === 'mayor' ? { ...request, systemPrompt: undefined } : request;

  return startAgent(startRequest, workdir, env);
}
