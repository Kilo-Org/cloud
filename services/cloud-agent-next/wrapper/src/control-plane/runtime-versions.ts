import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeSandboxRuntimeVersion } from '../../../src/shared/sandbox-status.js';

const exec = promisify(execFile);

export async function readKiloCliVersion(cli: string): Promise<string | null> {
  try {
    const { stdout } = await exec(cli, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4_096,
    });
    return safeSandboxRuntimeVersion(stdout.trim());
  } catch {
    return null;
  }
}
