import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeSandboxRuntimeVersion } from '../../../src/shared/sandbox-status.js';
import { agentCommand } from '../control/agent-execution.js';

const exec = promisify(execFile);

export async function readKiloCliVersion(cli: string): Promise<string | null> {
  try {
    const child = agentCommand(cli, ['--version']);
    const { stdout } = await exec(child.command, child.args, {
      env: child.env,
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4_096,
    });
    return safeSandboxRuntimeVersion(stdout.trim().replace(/^kilo2 v/, ''));
  } catch {
    return null;
  }
}
