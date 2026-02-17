import type { Subprocess, FileSink } from 'bun';
import type { AgentProcess, StartAgentRequest } from './types';

const GRACEFUL_SHUTDOWN_MS = 10_000;

type ManagedProcess = {
  process: AgentProcess;
  child: Subprocess | null;
  stdin: FileSink | null;
  stdinQueue: string[];
};

const processes = new Map<string, ManagedProcess>();

const startTime = Date.now();

export function getUptime(): number {
  return Date.now() - startTime;
}

/**
 * Spawn a Kilo CLI child process for an agent using Bun.spawn.
 */
export function startProcess(
  request: StartAgentRequest,
  workdir: string,
  cliArgs: string[],
  env: Record<string, string>
): AgentProcess {
  const existing = processes.get(request.agentId);
  if (
    existing &&
    (existing.process.status === 'running' || existing.process.status === 'starting')
  ) {
    throw new Error(`Agent ${request.agentId} is already running`);
  }

  const now = new Date().toISOString();
  const agentProcess: AgentProcess = {
    agentId: request.agentId,
    rigId: request.rigId,
    townId: request.townId,
    role: request.role,
    name: request.name,
    pid: null,
    status: 'starting',
    exitCode: null,
    workdir,
    startedAt: now,
    lastActivityAt: now,
  };

  const managed: ManagedProcess = {
    process: agentProcess,
    child: null,
    stdin: null,
    stdinQueue: [],
  };
  processes.set(request.agentId, managed);

  const mergedEnv = { ...process.env, ...env };

  const child = Bun.spawn(['kilo', ...cliArgs], {
    cwd: workdir,
    env: mergedEnv,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    onExit(_proc, exitCode, _signalCode, error) {
      agentProcess.status = exitCode === 0 ? 'exited' : 'failed';
      agentProcess.exitCode = exitCode;
      if (error) {
        agentProcess.status = 'failed';
        console.error(`Agent ${request.name} (${request.agentId}) error:`, error.message);
      }
      console.log(`Agent ${request.name} (${request.agentId}) exited: code=${exitCode}`);
    },
  });

  managed.child = child;
  managed.stdin = child.stdin as FileSink;
  agentProcess.pid = child.pid;
  agentProcess.status = 'running';

  // Stream stdout/stderr asynchronously
  if (child.stdout) {
    void (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          agentProcess.lastActivityAt = new Date().toISOString();
          process.stdout.write(`[${request.name}] ${decoder.decode(value)}`);
        }
      } catch {
        /* stream closed */
      }
    })();
  }

  if (child.stderr) {
    void (async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          agentProcess.lastActivityAt = new Date().toISOString();
          process.stderr.write(`[${request.name}:err] ${decoder.decode(value)}`);
        }
      } catch {
        /* stream closed */
      }
    })();
  }

  // Flush any queued stdin messages
  for (const msg of managed.stdinQueue) {
    managed.stdin?.write(msg + '\n');
  }
  managed.stdinQueue = [];

  console.log(
    `Started agent ${request.name} (${request.agentId}) pid=${child.pid} role=${request.role}`
  );
  return agentProcess;
}

/**
 * Stop an agent process gracefully (SIGTERM then SIGKILL after timeout).
 */
export async function stopProcess(
  agentId: string,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'
): Promise<void> {
  const managed = processes.get(agentId);
  if (!managed?.child) {
    throw new Error(`Agent ${agentId} not found or not running`);
  }

  if (managed.process.status !== 'running' && managed.process.status !== 'starting') {
    return;
  }

  managed.process.status = 'stopping';

  managed.child.kill(signal === 'SIGKILL' ? 9 : 15);

  if (signal === 'SIGTERM') {
    // Wait for graceful exit, then force-kill if still alive.
    const exited = managed.child.exited;
    const timeout = new Promise<'timeout'>(r =>
      setTimeout(() => r('timeout'), GRACEFUL_SHUTDOWN_MS)
    );

    const result = await Promise.race([exited.then(() => 'exited' as const), timeout]);
    if (result === 'timeout' && managed.process.status === 'stopping') {
      managed.child.kill(9);
    }
  }
}

/**
 * Send a follow-up prompt to an agent's stdin.
 */
export function sendMessage(agentId: string, prompt: string): void {
  const managed = processes.get(agentId);
  if (!managed) {
    throw new Error(`Agent ${agentId} not found`);
  }

  if (managed.stdin && managed.process.status === 'running') {
    managed.stdin.write(prompt + '\n');
  } else {
    managed.stdinQueue.push(prompt);
  }

  managed.process.lastActivityAt = new Date().toISOString();
}

/**
 * Get the status of an agent process.
 */
export function getProcessStatus(agentId: string): AgentProcess | null {
  return processes.get(agentId)?.process ?? null;
}

/**
 * List all managed agent processes.
 */
export function listProcesses(): AgentProcess[] {
  return [...processes.values()].map(m => m.process);
}

/**
 * Get count of active (running/starting) processes.
 */
export function activeProcessCount(): number {
  let count = 0;
  for (const m of processes.values()) {
    if (m.process.status === 'running' || m.process.status === 'starting') {
      count++;
    }
  }
  return count;
}

/**
 * Stop all running processes. Used during container shutdown.
 */
export async function stopAll(): Promise<void> {
  const running = [...processes.entries()].filter(
    ([, m]) => m.process.status === 'running' || m.process.status === 'starting'
  );

  await Promise.allSettled(running.map(([agentId]) => stopProcess(agentId)));
}
