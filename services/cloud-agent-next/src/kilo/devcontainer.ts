/**
 * Dev container support for cloud-agent sessions.
 *
 * When a repo ships a `.devcontainer/` config, we run the wrapper *inside*
 * that container instead of on the outer sandbox. The wrapper's HTTP port is
 * published from the dev container to the outer sandbox's loopback so the
 * Worker can keep talking to it via curl over `session.exec`.
 *
 * Architecture is documented in `.plans/devcontainer-support.md`.
 */

import type { ExecutionSession } from '../types.js';
import { logger } from '../logger.js';
import { dockerSocketEnv, resolveDockerSocketPath, waitForDocker } from './sandbox-runtime.js';
import { shellQuote, validShellEnvEntries } from './utils.js';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { posix as pathPosix } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of dev container detection. We only return enough information to
 * surface in logs / progress events — `devcontainer up` discovers the config
 * itself given `--workspace-folder`.
 */
export type DevContainerConfig = {
  /** Path relative to the workspace root, e.g. `.devcontainer/devcontainer.json`. */
  configPath: string;
};

/**
 * Handle to a running dev container. Pass through to the wrapper start path
 * so `devcontainer exec` is used in place of `session.startProcess`.
 */
export type DevContainerHandle = {
  /** Docker container ID returned by `devcontainer up`. */
  containerId: string;
  /** Path to the workspace as seen *inside* the container (`remoteWorkspaceFolder`). */
  innerWorkspaceFolder: string;
  /** Outer/host workspace path — used as `--workspace-folder` for subsequent `devcontainer exec`s. */
  workspacePath: string;
  /** Agent session ID — also stamped on the container as the `kilo.agentSession` label for discovery. */
  agentSessionId: string;
  /**
   * Path on the outer sandbox to the merged override `devcontainer.json`. Must
   * be passed as `--config` to every `devcontainer exec` so the CLI keeps
   * using our `remoteUser: root` + `remoteEnv.HOME` overrides; without it the
   * CLI re-reads the user's on-disk `.devcontainer/devcontainer.json` and
   * falls back to its `remoteUser` (typically `vscode`), breaking writes into
   * the bind-mounted sessionHome.
   */
  overrideConfigPath: string;
  /** Best-effort teardown. Safe to invoke after the outer sandbox is gone. */
  teardown: () => Promise<void>;
};

export type BringUpOptions = {
  /** Outer/host workspace path that contains `.devcontainer/`. */
  workspacePath: string;
  /** Per-session HOME (`/home/<sessionId>`) on the outer sandbox; bind-mounted at the same path inside. */
  sessionHome: string;
  /** Cloud-agent session ID — used as the docker container label for discovery. */
  agentSessionId: string;
  /** Wrapper HTTP port (so we can publish it to the outer sandbox's loopback). */
  wrapperPort: number;
  /** Pinned `@kilocode/cli` version installed inside the dev container. */
  kiloCliVersion: string;
  /** Optional milestone callback surfaced to preparation status streams. */
  onProgress?: (message: string) => void;
  /**
   * Path (relative to workspace root) of the detected devcontainer config,
   * as returned by `detectDevContainer`. Passed through so `readDevContainerConfig`
   * reads the exact file that was detected, avoiding a redundant path resolution
   * that could diverge from the detection logic.
   */
  configPath: string;
};

type DevContainerJson = Record<string, unknown>;

type ExecOptions = NonNullable<Parameters<ExecutionSession['exec']>[1]>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Label that identifies the container as belonging to a given cloud-agent session. */
export const KILO_AGENT_SESSION_LABEL = 'kilo.agentSession';

/**
 * Deterministic outer-sandbox path to the merged override `devcontainer.json`.
 *
 * Built from the agent session ID so any subsystem (orchestrator, wrapper
 * manager, restore-session helper) can reconstruct it from persisted
 * devcontainer metadata. The file is created by `bringUpDevContainer` and
 * removed by `teardownDevContainer`.
 *
 * Keep the filename exactly `devcontainer.json`: @devcontainers/cli 0.86+
 * rejects `--config` paths whose basename is not `devcontainer.json` or
 * `.devcontainer.json`.
 */
export function getDevContainerOverridePath(
  agentSessionId: string,
  workspacePath?: string,
  configPath?: string
): string {
  void workspacePath;
  void configPath;
  return `/tmp/devcontainer-override-${agentSessionId}/devcontainer.json`;
}

/** Label that records the wrapper HTTP port published by the dev container. */
export const KILO_WRAPPER_PORT_LABEL = 'kilo.wrapperPort';

/**
 * Pinned kilo CLI version installed *inside* the dev container.
 *
 * Keep this in sync with `KILOCODE_CLI_VERSION` in `Dockerfile.dind` /
 * `wrangler.jsonc#image_vars` so the kilo running in the dev container
 * matches the one we use on the outer sandbox.
 */
export const KILO_CLI_VERSION = '7.3.12';

const DEVCONTAINER_RUNTIME_BUN_VERSION = '1.3.14';
const DEVCONTAINER_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000;

/** `devcontainer up` prints multiple JSON lines on stdout — we look for this final line. */
const UP_OUTCOME_SUCCESS = 'success';

/**
 * Build the `kilo-restore-session.js` invocation, wrapping it in
 * `devcontainer exec` when a dev container is in play. Both branches end up
 * running the same bun-bundled script; only the entrypoint and cwd differ.
 */
export function buildRestoreCommand(opts: {
  kiloSessionId: string;
  importFilePath?: string;
  runtimeWorkspacePath: string;
  runtimeEnv?: Record<string, string | undefined>;
  devContainer: DevContainerHandle | undefined;
}): string {
  const { kiloSessionId, importFilePath, runtimeWorkspacePath, runtimeEnv, devContainer } = opts;
  const envParts = validShellEnvEntries(runtimeEnv ?? {}).map(
    ([key, value]) => `${key}=${shellQuote(value)}`
  );
  const innerCmd = [
    ...envParts,
    'bun',
    devContainer
      ? '/opt/kilo-cloud/kilo-restore-session.js'
      : '/usr/local/bin/kilo-restore-session.js',
    importFilePath ? `--file ${shellQuote(importFilePath)}` : undefined,
    shellQuote(kiloSessionId),
    shellQuote(runtimeWorkspacePath),
  ]
    .filter(Boolean)
    .join(' ');

  if (!devContainer) return innerCmd;

  return [
    'devcontainer exec',
    `--workspace-folder ${shellQuote(devContainer.workspacePath)}`,
    // Required: without --config the CLI re-reads the user's on-disk
    // devcontainer.json and our remoteUser=root override is lost, so kilo
    // import runs as the user's remoteUser (typically vscode) and fails
    // EACCES writing into the bind-mounted sessionHome.
    `--config ${shellQuote(devContainer.overrideConfigPath)}`,
    `--id-label ${shellQuote(`${KILO_AGENT_SESSION_LABEL}=${devContainer.agentSessionId}`)}`,
    '--',
    'sh -c',
    shellQuote(innerCmd),
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect a dev container config inside the cloned workspace.
 *
 * Order matches VS Code's resolution:
 * 1. `.devcontainer/devcontainer.json`
 * 2. `.devcontainer.json`
 * 3. `.devcontainer/<subfolder>/devcontainer.json` (first found, alphabetical)
 *
 * Returns `null` if none of those exist.
 */
export async function detectDevContainer(
  session: ExecutionSession,
  workspacePath: string
): Promise<DevContainerConfig | null> {
  const escaped = shellQuote(workspacePath);
  const script = [
    `cd ${escaped}`,
    `if [ -f .devcontainer/devcontainer.json ]; then echo .devcontainer/devcontainer.json`,
    `elif [ -f .devcontainer.json ]; then echo .devcontainer.json`,
    // glob is sorted alphabetically by `ls`, which is what we want for stability.
    `else ls .devcontainer/*/devcontainer.json 2>/dev/null | head -n 1`,
    `fi`,
  ].join('; ');

  const result = await session.exec(script);
  if (result.exitCode !== 0) {
    return null;
  }
  const path = result.stdout?.trim();
  if (!path) return null;
  return { configPath: path };
}

// ---------------------------------------------------------------------------
// Bring up
// ---------------------------------------------------------------------------

type DevContainerRuntimeCommandOptions = {
  workspacePath: string;
  overridePath: string;
  agentSessionId: string;
};

type BootstrapDevContainerRuntimeOptions = DevContainerRuntimeCommandOptions & {
  kiloCliVersion: string;
};

function buildDevContainerRuntimeExecCommand(
  opts: DevContainerRuntimeCommandOptions,
  shellCommand: string,
  shell: 'sh -c' | 'bash -lc'
): string {
  return [
    'devcontainer exec',
    `--workspace-folder ${shellQuote(opts.workspacePath)}`,
    `--config ${shellQuote(opts.overridePath)}`,
    `--id-label ${shellQuote(`${KILO_AGENT_SESSION_LABEL}=${opts.agentSessionId}`)}`,
    '--',
    shell,
    shellQuote(shellCommand),
  ].join(' ');
}

async function runDevContainerRuntimePreflight(
  session: ExecutionSession,
  opts: DevContainerRuntimeCommandOptions,
  dockerEnv: Record<string, string>
) {
  const command = buildDevContainerRuntimeExecCommand(
    opts,
    'command -v bun >/dev/null && bun --version >/dev/null 2>&1 && command -v kilo >/dev/null || echo MISSING',
    'sh -c'
  );
  return session.exec(command, { env: dockerEnv });
}

function devContainerRuntimeToolsMissing(
  result: Awaited<ReturnType<ExecutionSession['exec']>>
): boolean {
  return (result.stdout ?? '').includes('MISSING') || result.exitCode !== 0;
}

async function bootstrapDevContainerRuntimeTools(
  session: ExecutionSession,
  opts: BootstrapDevContainerRuntimeOptions,
  dockerEnv: Record<string, string>
): Promise<void> {
  const installCommand = [
    'set -euo pipefail',
    'export NVM_DIR=/usr/local/share/nvm',
    'mkdir -p "$NVM_DIR" /usr/local/bin',
    'if [ ! -s "$NVM_DIR/nvm.sh" ]; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null NVM_DIR="$NVM_DIR" bash; fi',
    '. "$NVM_DIR/nvm.sh"',
    'nvm install --lts',
    "nvm alias default 'lts/*'",
    'ln -sf "$(command -v node)" /usr/local/bin/node',
    'ln -sf "$(command -v npm)" /usr/local/bin/npm',
    'ln -sf "$(command -v npx)" /usr/local/bin/npx',
    `curl -fsSL https://bun.sh/install | bash -s "bun-v${DEVCONTAINER_RUNTIME_BUN_VERSION}"`,
    'ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun',
    `npm install -g ${shellQuote(`@kilocode/cli@${opts.kiloCliVersion}`)}`,
    'ln -sf "$(command -v kilo)" /usr/local/bin/kilo',
  ].join(' && ');
  const command = buildDevContainerRuntimeExecCommand(opts, installCommand, 'bash -lc');
  const result = await session.exec(command, {
    env: dockerEnv,
    timeout: DEVCONTAINER_RUNTIME_BOOTSTRAP_TIMEOUT_MS,
  } satisfies ExecOptions);
  if (result.exitCode !== 0) {
    throw new DevContainerUpError(
      `Failed to bootstrap dev container runtime tools (exit ${result.exitCode})`,
      result.stdout ?? '',
      result.stderr ?? ''
    );
  }
}

/**
 * Run `devcontainer up` for the cloned workspace and install kilo inside.
 *
 * Throws on failure (the orchestrator turns it into a `failed` progress event)
 * — silently falling back to the non-devcontainer path would mismatch the
 * project toolchain in confusing ways.
 */
export async function bringUpDevContainer(
  session: ExecutionSession,
  opts: BringUpOptions
): Promise<DevContainerHandle> {
  const {
    workspacePath,
    sessionHome,
    agentSessionId,
    wrapperPort,
    kiloCliVersion,
    configPath,
    onProgress,
  } = opts;

  // devcontainer/docker CLIs need DOCKER_HOST pointing at the sandbox dockerd
  // socket, which may differ between local smoke images and Cloudflare runtime.
  const dockerEnv = dockerSocketEnv(await resolveDockerSocketPath(session));

  // The DIND sandbox image backgrounds dockerd from its CMD, but /sandbox starts
  // accepting exec requests before dockerd has bound its socket. Block until
  // `docker version` succeeds so `devcontainer up` doesn't race the daemon.
  await waitForDocker(session, dockerEnv);

  const userConfig = await readDevContainerConfig(session, workspacePath, configPath);

  // Pre-create the cache subdirectories the outer sandbox writes into later
  // (`.local/share/kilo` via writeAuthFile, `tmp` via the session import).
  // Both the outer sandbox and the inner devcontainer run as root (we force
  // `remoteUser: root` in `buildOverrideConfig`), so file ownership lines up
  // by construction without any chown/chmod or uid-rewrite trickery.
  await session.exec(
    `mkdir -p "${sessionHome}/.cache" "${sessionHome}/.local/share/kilo" "${sessionHome}/tmp"`,
    { timeout: 10_000 }
  );

  onProgress?.('Preparing dev container configuration…');

  // 1. Build merged config. `@devcontainers/cli` treats an override file as the
  // complete config unless the base config is passed explicitly via `--config`.
  // The CLI also requires the config basename to be `devcontainer.json`, so we
  // write a session-scoped override under /tmp and absolutize relative file
  // references from the user's config directory before merging.
  const overridePath = getDevContainerOverridePath(agentSessionId, workspacePath, configPath);
  const overrideDir = overridePath.substring(0, overridePath.lastIndexOf('/'));
  await session.exec(`mkdir -p ${shellQuote(overrideDir)}`);
  await writeMergedOverrideConfig(session, {
    workspacePath,
    configPath,
    outputPath: overridePath,
    baseConfig: userConfig,
    sessionHome,
    wrapperPort,
    agentSessionId,
  });

  // 2. devcontainer up
  //
  // `--update-remote-user-uid-default never` because we sidestep the uid
  // alignment problem by forcing `remoteUser: root` in our override config
  // (see buildOverrideConfig). Letting the CLI rewrite vscode's uid would
  // require a `docker build` step that triggers binfmt_misc/Rosetta inside
  // the inner runc — fine in production but blows up on Mac DIND smoke
  // (rosetta error: failed to open elf at -exec-root=/var/run/docker).
  //
  // Note: `--config <overridePath>` must also be passed to every subsequent
  // `devcontainer exec`. Without it the CLI re-reads the user's on-disk
  // `.devcontainer/devcontainer.json` and resets `remoteUser` to whatever
  // the user declared (typically `vscode`), breaking writes into the
  // bind-mounted sessionHome. See `getDevContainerOverridePath`.
  onProgress?.('Building dev container…');
  logger.withFields({ agentSessionId, workspacePath }).info('Running devcontainer up');
  const upCmd = [
    'devcontainer up',
    `--workspace-folder ${shellQuote(workspacePath)}`,
    `--config ${shellQuote(overridePath)}`,
    `--id-label ${shellQuote(`${KILO_AGENT_SESSION_LABEL}=${agentSessionId}`)}`,
    `--buildkit never`,
    `--update-remote-user-uid-default never`,
    `--log-format json`,
  ].join(' ');

  const upResult = await session.exec(upCmd, { env: dockerEnv });
  if (upResult.exitCode !== 0) {
    throw new DevContainerUpError(
      `devcontainer up failed (exit ${upResult.exitCode})`,
      upResult.stdout ?? '',
      upResult.stderr ?? ''
    );
  }

  const teardown = () =>
    teardownDevContainer(session, workspacePath, agentSessionId, dockerEnv, overridePath);

  try {
    const outcome = parseUpOutcome(upResult.stdout ?? '');
    if (!outcome) {
      throw new DevContainerUpError(
        'devcontainer up succeeded but no outcome line was emitted',
        upResult.stdout ?? '',
        upResult.stderr ?? ''
      );
    }

    logger
      .withFields({
        agentSessionId,
        containerId: outcome.containerId,
        innerWorkspaceFolder: outcome.remoteWorkspaceFolder,
      })
      .info('Dev container is up');

    // The override config must stick around for the lifetime of the dev
    // container: every subsequent `devcontainer exec` needs `--config` pointing
    // at it so the CLI keeps applying our `remoteUser: root` + `remoteEnv.HOME`
    // overrides instead of silently re-reading the user's on-disk
    // `.devcontainer/devcontainer.json`. Cleanup happens in
    // `teardownDevContainer`.

    const preflightOptions = {
      workspacePath,
      overridePath,
      agentSessionId,
    };
    onProgress?.('Checking dev container runtime…');
    let preflight = await runDevContainerRuntimePreflight(session, preflightOptions, dockerEnv);
    if (devContainerRuntimeToolsMissing(preflight)) {
      onProgress?.('Installing runtime tools in dev container…');
      await bootstrapDevContainerRuntimeTools(
        session,
        { ...preflightOptions, kiloCliVersion },
        dockerEnv
      );
      onProgress?.('Checking dev container runtime…');
      preflight = await runDevContainerRuntimePreflight(session, preflightOptions, dockerEnv);
    }
    if (devContainerRuntimeToolsMissing(preflight)) {
      throw new DevContainerUpError(
        'Dev container runtime bootstrap completed, but bun and/or kilo are still missing.',
        preflight.stdout ?? '',
        preflight.stderr ?? ''
      );
    }

    return {
      containerId: outcome.containerId,
      innerWorkspaceFolder: outcome.remoteWorkspaceFolder,
      workspacePath,
      agentSessionId,
      overrideConfigPath: overridePath,
      teardown,
    };
  } catch (error) {
    await teardown().catch(teardownError => {
      logger
        .withFields({
          agentSessionId,
          error: teardownError instanceof Error ? teardownError.message : String(teardownError),
        })
        .warn('Failed to tear down devcontainer after bring-up failure');
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the override JSON merged on top of the user's `devcontainer.json`.
 * Adds Kilo's `mounts`/`runArgs`/`remoteEnv` without changing
 * `workspaceMount`/`workspaceFolder`; `remoteUser` is forced to `root` so
 * that file ownership across the outer→inner bind mount lines up by
 * construction. The user's `"remoteUser": "vscode"` (or similar) is replaced
 * — we do this rather than relying on `--update-remote-user-uid-default on`
 * because that flag forces a `docker build` for the uid rewrite, which trips
 * binfmt_misc/Rosetta on local Mac DIND smoke runs (works in prod, breaks
 * locally). Running as root inside the container is functionally equivalent
 * for our use case (kilo doesn't care about user identity, postCreate scripts
 * that use `sudo` no-op as root).
 */
export function buildOverrideConfig(opts: {
  sessionHome: string;
  wrapperPort: number;
  agentSessionId: string;
}): Record<string, unknown> {
  const { sessionHome, wrapperPort, agentSessionId } = opts;

  return {
    remoteUser: 'root',
    mounts: [
      // Read-only wrapper bundle.
      `source=/opt/kilo-cloud,target=/opt/kilo-cloud,type=bind,readonly`,
      // HOME alignment — kilo's xdg-basedir paths must resolve identically inside and out.
      `source=${sessionHome},target=${sessionHome},type=bind`,
    ],
    runArgs: [
      '--network=host',
      // --publish is more universally honored than `appPort` across @devcontainers/cli versions.
      '--publish',
      `127.0.0.1:${wrapperPort}:${wrapperPort}`,
      // Stamp the container so we can rediscover it after a wrapper restart.
      '--label',
      `${KILO_AGENT_SESSION_LABEL}=${agentSessionId}`,
      '--label',
      `${KILO_WRAPPER_PORT_LABEL}=${wrapperPort}`,
    ],
    remoteEnv: {
      HOME: sessionHome,
      KILO_CLOUD_AGENT: '1',
    },
  };
}

export async function writeMergedOverrideConfig(
  session: ExecutionSession,
  opts: {
    workspacePath: string;
    configPath?: string;
    outputPath: string;
    baseConfig: DevContainerJson;
    sessionHome: string;
    wrapperPort: number;
    agentSessionId: string;
  }
): Promise<void> {
  const {
    workspacePath,
    configPath,
    outputPath,
    baseConfig,
    sessionHome,
    wrapperPort,
    agentSessionId,
  } = opts;
  const relativePathBase =
    configPath === undefined ? undefined : getDevContainerConfigDir(workspacePath, configPath);
  const merged = mergeDevContainerConfig(baseConfig, {
    sessionHome,
    wrapperPort,
    agentSessionId,
    relativePathBase,
  });
  const mergeScript = `node <<'__KILO_MERGE_EOF__'
const fs = require('fs');
const outputPath = ${JSON.stringify(outputPath)};
const merged = ${JSON.stringify(merged, null, 2)};

fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2));
__KILO_MERGE_EOF__`;

  const result = await session.exec(mergeScript, { timeout: 5_000 } satisfies ExecOptions);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to write devcontainer override config: ${(result.stderr ?? result.stdout ?? '').trim()}`
    );
  }
}

export function mergeDevContainerConfig(
  baseConfig: DevContainerJson,
  opts: {
    sessionHome: string;
    wrapperPort: number;
    agentSessionId: string;
    relativePathBase?: string;
  }
): DevContainerJson {
  const override = buildOverrideConfig(opts);
  const normalizedBaseConfig = opts.relativePathBase
    ? normalizeDevContainerRelativePaths(baseConfig, opts.relativePathBase)
    : baseConfig;
  const sanitizedBaseConfig = { ...normalizedBaseConfig };
  // `initializeCommand` runs on the devcontainer host, which is the outer DIND sandbox here.
  delete sanitizedBaseConfig.initializeCommand;
  if (mountExposesOuterDockerSocket(sanitizedBaseConfig.workspaceMount)) {
    delete sanitizedBaseConfig.workspaceMount;
  }

  const baseMounts = isUnknownArray(sanitizedBaseConfig.mounts)
    ? sanitizedBaseConfig.mounts.filter(mount => !mountExposesOuterDockerSocket(mount))
    : [];
  const overrideMounts = isUnknownArray(override.mounts) ? override.mounts : [];
  const overrideRunArgs = isUnknownArray(override.runArgs) ? override.runArgs : [];

  return {
    ...sanitizedBaseConfig,
    // `remoteUser` from override wins over base — see buildOverrideConfig for why.
    ...(typeof override.remoteUser === 'string' ? { remoteUser: override.remoteUser } : {}),
    mounts: [...baseMounts, ...overrideMounts],
    runArgs: [...sanitizeDevContainerRunArgs(sanitizedBaseConfig.runArgs), ...overrideRunArgs],
    remoteEnv: {
      ...(isRecord(sanitizedBaseConfig.remoteEnv) ? sanitizedBaseConfig.remoteEnv : {}),
      ...(isRecord(override.remoteEnv) ? override.remoteEnv : {}),
    },
  };
}

const OUTER_DOCKER_SOCKET_PATHS = ['/var/run/docker.sock', '/run/user/1000/docker.sock'];

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function sanitizeDevContainerRunArgs(runArgs: unknown): unknown[] {
  if (!isUnknownArray(runArgs)) return [];

  const sanitizedRunArgs: unknown[] = [];
  for (let index = 0; index < runArgs.length; index++) {
    const arg = runArgs[index];
    if (typeof arg !== 'string') {
      sanitizedRunArgs.push(arg);
      continue;
    }

    const pairedMountValue = runArgs[index + 1];
    if (
      (arg === '--mount' && mountExposesOuterDockerSocket(pairedMountValue)) ||
      ((arg === '--volume' || arg === '-v') && volumeExposesOuterDockerSocket(pairedMountValue))
    ) {
      index += 1;
      continue;
    }

    if (
      (arg.startsWith('--mount=') && mountExposesOuterDockerSocket(arg.slice('--mount='.length))) ||
      (arg.startsWith('--volume=') &&
        volumeExposesOuterDockerSocket(arg.slice('--volume='.length))) ||
      (arg.startsWith('-v=') && volumeExposesOuterDockerSocket(arg.slice('-v='.length)))
    ) {
      continue;
    }

    sanitizedRunArgs.push(arg);
  }

  return sanitizedRunArgs;
}

function mountExposesOuterDockerSocket(mount: unknown): boolean {
  if (typeof mount !== 'string') return false;

  for (const field of mount.split(',')) {
    const separatorIndex = field.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = field.slice(0, separatorIndex).trim();
    if (key !== 'source' && key !== 'src') continue;

    const sourcePath = field.slice(separatorIndex + 1).trim();
    if (pathExposesOuterDockerSocket(sourcePath)) return true;
  }

  return false;
}

function volumeExposesOuterDockerSocket(volume: unknown): boolean {
  if (typeof volume !== 'string') return false;

  const separatorIndex = volume.indexOf(':');
  if (separatorIndex === -1) return false;
  return pathExposesOuterDockerSocket(volume.slice(0, separatorIndex).trim());
}

function pathExposesOuterDockerSocket(sourcePath: string): boolean {
  if (!sourcePath.startsWith('/')) return false;

  const normalizedSourcePath = pathPosix.normalize(sourcePath);
  return OUTER_DOCKER_SOCKET_PATHS.some(socketPath =>
    pathContainsSocket(normalizedSourcePath, socketPath)
  );
}

function pathContainsSocket(sourcePath: string, socketPath: string): boolean {
  if (sourcePath === '/') return true;
  return socketPath === sourcePath || socketPath.startsWith(`${sourcePath}/`);
}

function normalizeDevContainerRelativePaths(
  config: DevContainerJson,
  relativePathBase: string
): DevContainerJson {
  const normalized: DevContainerJson = { ...config };

  if (typeof normalized.dockerComposeFile === 'string') {
    normalized.dockerComposeFile = absolutizeConfigPath(
      normalized.dockerComposeFile,
      relativePathBase
    );
  } else if (Array.isArray(normalized.dockerComposeFile)) {
    const dockerComposeFile = normalized.dockerComposeFile as unknown[];
    normalized.dockerComposeFile = dockerComposeFile.map((value): unknown =>
      typeof value === 'string' ? absolutizeConfigPath(value, relativePathBase) : value
    );
  }

  if (typeof normalized.dockerFile === 'string') {
    normalized.dockerFile = absolutizeConfigPath(normalized.dockerFile, relativePathBase);
  }

  if (typeof normalized.context === 'string') {
    normalized.context = absolutizeConfigPath(normalized.context, relativePathBase);
  }

  if (isRecord(normalized.build)) {
    const build = { ...normalized.build };
    if (typeof build.dockerfile === 'string') {
      build.dockerfile = absolutizeConfigPath(build.dockerfile, relativePathBase);
    }
    if (typeof build.context === 'string') {
      build.context = absolutizeConfigPath(build.context, relativePathBase);
    }
    normalized.build = build;
  }

  return normalized;
}

function absolutizeConfigPath(value: string, relativePathBase: string): string {
  if (value.startsWith('/') || value.startsWith('${')) return value;
  return pathPosix.normalize(pathPosix.join(relativePathBase, value));
}

function getDevContainerConfigDir(workspacePath: string, configPath: string): string {
  const absoluteConfigPath = configPath.startsWith('/')
    ? configPath
    : pathPosix.join(workspacePath, configPath);
  return pathPosix.dirname(absoluteConfigPath);
}

export function parseDevContainerConfig(contents: string): DevContainerJson {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(contents, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `Failed to parse devcontainer config: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error('Failed to parse devcontainer config: root value must be an object');
  }
  return parsed;
}

async function readDevContainerConfig(
  session: ExecutionSession,
  workspacePath: string,
  configPath: string
): Promise<DevContainerJson> {
  const absoluteConfigPath = configPath.startsWith('/')
    ? configPath
    : `${workspacePath}/${configPath}`;
  const script = `node <<'__KILO_READ_DEVCONTAINER_EOF__'
const fs = require('fs');

const configPath = ${JSON.stringify(absoluteConfigPath)};

process.stdout.write(fs.readFileSync(configPath, 'utf8'));
__KILO_READ_DEVCONTAINER_EOF__`;

  const result = await session.exec(script, { timeout: 5_000 } satisfies ExecOptions);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to read devcontainer config: ${(result.stderr ?? result.stdout ?? '').trim()}`
    );
  }
  return parseDevContainerConfig(result.stdout ?? '{}');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type UpOutcome = {
  containerId: string;
  remoteWorkspaceFolder: string;
};

/**
 * Parse `devcontainer up --log-format json` stdout for the success outcome.
 *
 * The CLI prints a stream of JSON objects (build progress, etc.) followed by a
 * final line with `{"outcome": "success", "containerId": "...", "remoteWorkspaceFolder": "..."}`.
 * Lenient: ignores any non-JSON or non-outcome lines.
 */
export function parseUpOutcome(stdout: string): UpOutcome | null {
  // Walk lines in reverse so we get the *final* outcome even if the CLI emits
  // multiple — and so we don't waste time JSON-parsing every progress entry.
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.outcome !== UP_OUTCOME_SUCCESS) continue;
    const containerId = typeof obj.containerId === 'string' ? obj.containerId : '';
    const remoteWorkspaceFolder =
      typeof obj.remoteWorkspaceFolder === 'string' ? obj.remoteWorkspaceFolder : '';
    if (!containerId || !remoteWorkspaceFolder) continue;
    return { containerId, remoteWorkspaceFolder };
  }
  return null;
}

async function teardownDevContainer(
  session: ExecutionSession,
  workspacePath: string,
  agentSessionId: string,
  dockerEnv: Record<string, string>,
  overrideConfigPath: string
): Promise<void> {
  // Best-effort: `devcontainer down` is the polite path; falling back to
  // `docker rm -f` by label catches the case where the dev container was
  // started by an older CLI that doesn't honour --workspace-folder for down.
  const downCmd = [
    'devcontainer down',
    `--workspace-folder ${shellQuote(workspacePath)}`,
    `--config ${shellQuote(overrideConfigPath)}`,
  ].join(' ');
  try {
    await session.exec(downCmd, { env: dockerEnv });
  } catch (error) {
    logger
      .withFields({
        agentSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      .warn('devcontainer down failed; falling back to docker rm -f');
  }

  const fallbackCmd = `docker rm -f $(docker ps -aq --filter ${shellQuote(`label=${KILO_AGENT_SESSION_LABEL}=${agentSessionId}`)}) 2>/dev/null || true`;
  try {
    await session.exec(fallbackCmd, { env: dockerEnv });
  } catch {
    // Container may already be gone; not fatal.
  }

  // Clean up the merged override config we kept alive for `devcontainer exec
  // --config`. Best-effort — stale files are harmless and get removed with the
  // workspace/sandbox.
  try {
    await session.exec(`rm -f ${shellQuote(overrideConfigPath)}`, { env: dockerEnv });
  } catch {
    // Stale override files are harmless.
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DevContainerUpError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(formatDiagnostic(message, stdout, stderr));
    this.name = 'DevContainerUpError';
  }
}

function formatDiagnostic(message: string, stdout: string, stderr: string): string {
  const parts = [message];
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  if (trimmedStderr) parts.push(`stderr: ${trimmedStderr}`);
  if (trimmedStdout) parts.push(`stdout: ${trimmedStdout}`);
  return parts.join(' | ');
}
