/**
 * Sandbox runtime helpers shared by the wrapper client and the devcontainer
 * orchestrator. These deal with inspecting the outer sandbox image (e.g.
 * docker:dind-rootless) so we can talk to its dockerd or pass the right env
 * vars into a child process.
 */

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

type Executor = {
  exec(
    command: string,
    options?: { env?: Record<string, string>; timeout?: number }
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
};

/** Resolve the Docker socket path exposed by the outer sandbox image. */
export async function resolveDockerSocketPath(executor: Executor): Promise<string> {
  try {
    const result = await executor.exec(
      `if [ -S /var/run/docker.sock ]; then printf /var/run/docker.sock; elif [ -S /run/user/1000/docker.sock ]; then printf /run/user/1000/docker.sock; fi`,
      { timeout: 5_000 }
    );
    if (result.exitCode === 0) {
      const path = result.stdout?.trim();
      if (path) return path;
    }
  } catch {
    // best-effort — fall through to default
  }

  return DEFAULT_DOCKER_SOCKET;
}

/** Build the env-var fragment that points a child process at dockerd. */
export function dockerSocketEnvParts(socketPath: string): string[] {
  return [`DOCKER_HOST=unix://${socketPath}`];
}

/** Build the env-var record that points a child process at dockerd. */
export function dockerSocketEnv(socketPath: string): Record<string, string> {
  return {
    DOCKER_HOST: `unix://${socketPath}`,
  };
}

/** Build the Kilo-owned XDG paths rooted in a session home. */
export function buildKiloSessionXdgEnv(sessionHome: string): Record<string, string> {
  return {
    XDG_DATA_HOME: `${sessionHome}/.local/share`,
    XDG_CONFIG_HOME: `${sessionHome}/.config`,
    XDG_CACHE_HOME: `${sessionHome}/.cache`,
  };
}

/**
 * Poll `docker version` inside the sandbox until dockerd is reachable.
 *
 * The DIND boot script (`Dockerfile.dind`) backgrounds dockerd and waits for
 * readiness itself, but the /sandbox HTTP API answers exec requests before
 * that script finishes — so the first docker-dependent command (e.g.
 * `devcontainer up`) can race the daemon and fail with
 * `connect: no such file or directory` on its socket.
 */
export async function waitForDocker(
  executor: Executor,
  dockerEnv: Record<string, string>,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastStderr = '';
  while (Date.now() < deadline) {
    const result = await executor.exec('docker version --format {{.Server.Version}}', {
      env: dockerEnv,
      timeout: 5_000,
    });
    if (result.exitCode === 0) return;
    lastStderr = result.stderr ?? '';
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`dockerd did not become ready within ${timeoutMs}ms: ${lastStderr.trim()}`);
}
