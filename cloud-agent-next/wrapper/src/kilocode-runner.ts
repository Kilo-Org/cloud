import { spawn, type ChildProcess } from 'child_process';
import type { IngestEvent } from '../../src/shared/protocol.js';
import { parseKilocodeOutput, isTerminalEvent, stripAnsi } from './event-parser.js';

export type RunnerOptions = {
  mode: string;
  prompt: string;
  workspacePath: string;
  kiloSessionId?: string;
  idleTimeoutMs: number;
  maxRuntimeMs?: number;
  onEvent: (event: IngestEvent) => void;
  onTerminalEvent: (reason: string) => void;
};

/** Result of waiting for the runner to complete */
export type RunnerResult = {
  exitCode: number;
  signal: string | null;
  wasKilled: boolean;
};

export type KilocodeRunner = {
  wait: () => Promise<RunnerResult>;
  kill: (signal?: NodeJS.Signals) => void;
  process: ChildProcess;
};

export function createKilocodeRunner(opts: RunnerOptions): KilocodeRunner {
  // mode must be 'plan', 'code', or 'custom' - normalized upstream from input modes
  const args = ['run', '--format', 'json', '--agent', opts.mode];

  if (opts.kiloSessionId) {
    console.log('TODO:FLORIAN UNCOMMENT WHEN SESSIONS ARE READY');
    console.log(opts.kiloSessionId);
    //args.push('--session', opts.kiloSessionId);
  }

  const proc = spawn('kilo', args, {
    cwd: opts.workspacePath,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdin = proc.stdin;
  const stdout = proc.stdout;
  const stderr = proc.stderr;

  if (!stdin || !stdout || !stderr) {
    throw new Error('Failed to open kilo stdio streams');
  }

  // Track spawn errors - if the binary doesn't exist or can't be executed,
  // spawn() doesn't throw but emits an 'error' event instead
  let spawnError: Error | null = null;
  proc.on('error', (err: Error) => {
    spawnError = err;
    opts.onEvent({
      streamEventType: 'error',
      data: { error: `Failed to start kilocode: ${err.message}`, fatal: true },
      timestamp: new Date().toISOString(),
    });
  });

  // Write prompt to stdin
  stdin.write(opts.prompt);
  stdin.end();

  // Idle timeout tracking
  let lastActivity = Date.now();
  const idleCheck =
    opts.idleTimeoutMs > 0
      ? setInterval(() => {
          if (Date.now() - lastActivity > opts.idleTimeoutMs) {
            opts.onEvent({
              streamEventType: 'error',
              data: { error: 'Idle timeout exceeded', fatal: true },
              timestamp: new Date().toISOString(),
            });
            proc.kill('SIGTERM');
          }
        }, 30_000)
      : null;

  // Hard timeout - maximum total runtime regardless of activity
  const maxRuntimeTimer =
    opts.maxRuntimeMs && opts.maxRuntimeMs > 0
      ? setTimeout(() => {
          opts.onEvent({
            streamEventType: 'error',
            data: { error: 'Execution time limit reached', fatal: true },
            timestamp: new Date().toISOString(),
          });
          proc.kill('SIGTERM');
        }, opts.maxRuntimeMs)
      : null;

  // Process stdout - line buffered
  let stdoutBuffer = '';
  stdout.on('data', (chunk: Buffer) => {
    lastActivity = Date.now();
    stdoutBuffer += chunk.toString();

    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      const event = parseKilocodeOutput(line);
      if (event.streamEventType === 'kilocode') {
        const terminal = isTerminalEvent(event.data as Record<string, unknown>);
        if (terminal.isTerminal) {
          opts.onEvent(event);
          opts.onTerminalEvent(terminal.reason);
          proc.kill('SIGTERM');
          return;
        }
      }
      opts.onEvent(event);
    }
  });

  // Flush stdout buffer on close
  stdout.on('close', () => {
    if (stdoutBuffer.trim()) {
      opts.onEvent(parseKilocodeOutput(stdoutBuffer));
    }
  });

  // Process stderr - line buffered
  let stderrBuffer = '';
  stderr.on('data', (chunk: Buffer) => {
    lastActivity = Date.now();
    stderrBuffer += chunk.toString();

    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      opts.onEvent({
        streamEventType: 'output',
        data: { content: stripAnsi(line), source: 'stderr' },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Flush stderr buffer on close
  stderr.on('close', () => {
    if (stderrBuffer.trim()) {
      opts.onEvent({
        streamEventType: 'output',
        data: { content: stripAnsi(stderrBuffer), source: 'stderr' },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Track whether process was explicitly killed via kill() method
  let wasExplicitlyKilled = false;

  // Track if process has already exited (for early exit before wait() is called)
  let exitResult: RunnerResult | null = null;

  // Listen for exit immediately so we capture it even if wait() is called late
  proc.on('exit', (code, signal) => {
    if (idleCheck) clearInterval(idleCheck);
    exitResult = {
      exitCode: code ?? (spawnError ? 1 : 0),
      signal: signal ?? null,
      wasKilled: wasExplicitlyKilled,
    };
  });

  return {
    wait: () =>
      new Promise<RunnerResult>(resolve => {
        const resolveOnce = (result: RunnerResult) => {
          if (idleCheck) clearInterval(idleCheck);
          if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
          resolve(result);
        };

        // If spawn error already occurred, resolve immediately
        // The 'error' event fires before wait() is called when binary is missing
        if (spawnError) {
          resolveOnce({
            exitCode: 1,
            signal: null,
            wasKilled: false,
          });
          return;
        }

        // If process already exited before wait() was called, resolve immediately
        if (exitResult) {
          resolve(exitResult);
          return;
        }

        // Otherwise wait for exit event
        proc.once('exit', (code, signal) => {
          resolveOnce({
            exitCode: code ?? (spawnError ? 1 : 0),
            signal: signal ?? null,
            wasKilled: wasExplicitlyKilled,
          });
        });

        // Handle spawn errors that occur after wait() is called
        proc.once('error', () => {
          resolveOnce({
            exitCode: 1,
            signal: null,
            wasKilled: false,
          });
        });
      }),
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      wasExplicitlyKilled = true;
      proc.kill(signal);
    },
    process: proc,
  };
}
