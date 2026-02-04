import { spawn } from 'child_process';
import { appendFileSync } from 'fs';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function exec(command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));
    proc.on('exit', code => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    proc.on('error', reject);
  });
}

export async function getCurrentBranch(workspacePath: string): Promise<string> {
  try {
    const result = await exec(`cd ${workspacePath} && git branch --show-current`);
    return result.stdout.trim();
  } catch {
    return '';
  }
}

export function logToFile(message: string): void {
  const logPath = process.env.WRAPPER_LOG_PATH || '/tmp/kilocode-wrapper.log';
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Ignore logging failures to avoid breaking the wrapper
  }
}
