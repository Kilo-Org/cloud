/**
 * Kilo Server Manager
 *
 * Manages kilo serve instances inside the town container. Each worktree gets
 * its own kilo serve process (since a server is scoped to one project dir).
 * Multiple agents sharing a worktree share one server with separate sessions.
 *
 * Port allocation: starting at 4096, incrementing. The control server on 8080
 * is unaffected.
 */

import type { Subprocess } from 'bun';
import type { KiloServerInstance } from './types';

const KILO_SERVER_START_PORT = 4096;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 60_000;

/** workdir -> KiloServerInstance */
const servers = new Map<string, KiloServerInstance>();

let nextPort = KILO_SERVER_START_PORT;

function allocatePort(): number {
  const usedPorts = new Set([...servers.values()].map(s => s.port));
  while (usedPorts.has(nextPort)) {
    nextPort++;
  }
  const port = nextPort;
  nextPort++;
  return port;
}

/**
 * Wait for a kilo serve instance to respond to GET /global/health.
 */
async function waitForHealthy(port: number, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/global/health`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }

  throw new Error(`kilo serve on port ${port} did not become healthy within ${timeoutMs}ms`);
}

/**
 * Get or start a kilo serve instance for the given workdir.
 *
 * If a healthy server already exists for this workdir it is reused.
 * Otherwise a new `kilo serve` process is spawned.
 *
 * @returns The port the server is listening on.
 */
export async function ensureServer(workdir: string, env: Record<string, string>): Promise<number> {
  const existing = servers.get(workdir);
  if (existing?.healthy) {
    return existing.port;
  }

  // If there's a dead/unhealthy server entry, clean it up
  if (existing) {
    try {
      existing.process.kill();
    } catch {
      /* already dead */
    }
    servers.delete(workdir);
  }

  const port = allocatePort();

  const mergedEnv = { ...process.env, ...env };

  const child: Subprocess = Bun.spawn(
    ['kilo', 'serve', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: workdir,
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  const instance: KiloServerInstance = {
    port,
    workdir,
    process: child,
    sessionIds: new Set(),
    healthy: false,
  };

  servers.set(workdir, instance);

  // Stream stdout/stderr for visibility
  const stdout = child.stdout;
  if (stdout && typeof stdout !== 'number') {
    void (async () => {
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stdout.write(`[kilo-serve:${port}] ${decoder.decode(value)}`);
        }
      } catch {
        /* stream closed */
      }
    })();
  }

  const stderr = child.stderr;
  if (stderr && typeof stderr !== 'number') {
    void (async () => {
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stderr.write(`[kilo-serve:${port}:err] ${decoder.decode(value)}`);
        }
      } catch {
        /* stream closed */
      }
    })();
  }

  // Monitor process exit
  void child.exited.then(exitCode => {
    instance.healthy = false;
    console.log(`kilo serve on port ${port} exited: code=${exitCode}`);
  });

  await waitForHealthy(port);
  instance.healthy = true;

  console.log(`kilo serve started on port ${port} for workdir ${workdir} (pid=${child.pid})`);
  return port;
}

/**
 * Track a session ID on a server (for bookkeeping / shutdown decisions).
 */
export function registerSession(workdir: string, sessionId: string): void {
  const server = servers.get(workdir);
  if (server) {
    server.sessionIds.add(sessionId);
  }
}

/**
 * Unregister a session. If the server has no remaining sessions, stop it.
 */
export async function unregisterSession(workdir: string, sessionId: string): Promise<void> {
  const server = servers.get(workdir);
  if (!server) return;

  server.sessionIds.delete(sessionId);

  if (server.sessionIds.size === 0) {
    await stopServer(workdir);
  }
}

/**
 * Stop a kilo serve instance for the given workdir.
 */
export async function stopServer(workdir: string): Promise<void> {
  const server = servers.get(workdir);
  if (!server) return;

  server.healthy = false;

  try {
    server.process.kill(15); // SIGTERM

    const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 10_000));
    const result = await Promise.race([
      server.process.exited.then(() => 'exited' as const),
      timeout,
    ]);
    if (result === 'timeout') {
      server.process.kill(9); // SIGKILL
    }
  } catch {
    /* already dead */
  }

  servers.delete(workdir);
  console.log(`Stopped kilo serve for workdir ${workdir}`);
}

/**
 * Stop all running kilo serve instances. Used during container shutdown.
 */
export async function stopAllServers(): Promise<void> {
  await Promise.allSettled([...servers.keys()].map(workdir => stopServer(workdir)));
}

/**
 * Get the port for a server by workdir, or null if none exists.
 */
export function getServerPort(workdir: string): number | null {
  return servers.get(workdir)?.port ?? null;
}

/**
 * Count of active (healthy) server instances.
 */
export function activeServerCount(): number {
  let count = 0;
  for (const s of servers.values()) {
    if (s.healthy) count++;
  }
  return count;
}
