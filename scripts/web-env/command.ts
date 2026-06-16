import { spawn } from 'node:child_process';

export type CommandRequest = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
};

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type CommandExecutor = (request: CommandRequest) => Promise<CommandResult>;

export const executeCommand: CommandExecutor = request =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = request.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, request.timeoutMs)
      : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      if (timeout) clearTimeout(timeout);
      resolve({
        status: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
      });
    });

    if (request.stdin !== undefined) {
      child.stdin.end(request.stdin);
    } else {
      child.stdin.end();
    }
  });

export function requireSuccess(result: CommandResult, operation: string): string {
  if (result.status !== 0) {
    throw new Error(`${operation} failed (exit ${result.status}). Provider output was redacted.`);
  }
  return result.stdout;
}
