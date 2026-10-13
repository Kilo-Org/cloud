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
