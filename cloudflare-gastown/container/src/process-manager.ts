import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentProcess, StartAgentRequest } from './types.js';

const GRACEFUL_SHUTDOWN_MS = 10_000;

type ManagedProcess = {
  process: AgentProcess;
  child: ChildProcess | null;
  stdinQueue: string[];
};

const processes = new Map<string, ManagedProcess>();

// Track container start time for uptime calculation
const startTime = Date.now();

export function getUptime(): number {
  return Date.now() - startTime;
}

/**
 * Spawn a Kilo CLI child process for an agent.
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
    stdinQueue: [],
  };
  processes.set(request.agentId, managed);

  const mergedEnv = { ...process.env, ...env };

  const child = spawn('kilo', cliArgs, {
    cwd: workdir,
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  managed.child = child;
  agentProcess.pid = child.pid ?? null;
  agentProcess.status = 'running';

  child.stdout?.on('data', (data: Buffer) => {
    agentProcess.lastActivityAt = new Date().toISOString();
    // Forward to console for Workers Logs observability
    process.stdout.write(`[${request.name}] ${data}`);
  });

  child.stderr?.on('data', (data: Buffer) => {
    agentProcess.lastActivityAt = new Date().toISOString();
    process.stderr.write(`[${request.name}:err] ${data}`);
  });

  child.on('exit', (code, signal) => {
    agentProcess.status = code === 0 ? 'exited' : 'failed';
    agentProcess.exitCode = code;
    console.log(`Agent ${request.name} (${request.agentId}) exited: code=${code} signal=${signal}`);
  });

  child.on('error', err => {
    agentProcess.status = 'failed';
    console.error(`Agent ${request.name} (${request.agentId}) spawn error:`, err.message);
  });

  // Flush any queued stdin messages
  for (const msg of managed.stdinQueue) {
    child.stdin?.write(msg + '\n');
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
    return; // Already stopped
  }

  managed.process.status = 'stopping';

  managed.child.kill(signal);

  if (signal === 'SIGTERM') {
    // Wait for graceful shutdown, then force kill
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        if (managed.child && !managed.child.killed) {
          managed.child.kill('SIGKILL');
        }
        resolve();
      }, GRACEFUL_SHUTDOWN_MS);

      managed.child?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
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

  if (managed.child && managed.process.status === 'running') {
    managed.child.stdin?.write(prompt + '\n');
  } else {
    // Queue for when the process starts
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
