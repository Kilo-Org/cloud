import { join } from 'node:path';

/** Runs one command, as the capture script's own `sh` does. */
export type CaptureShell = (
  command: string,
  args: string[],
  options?: { input?: string; allowFailure?: boolean }
) => unknown;

/**
 * Starts the capture's runner and gateway containers for one capture session. Whatever
 * fails after the runner starts removes both before the failure escapes: a gateway that
 * cannot start must not leave the runner up until some later invocation happens to clear it.
 */
export function startCaptureContainers(params: {
  sh: CaptureShell;
  image: string;
  runner: string;
  gateway: string;
  workDir: string;
  catalogFile: string;
  logFile: string;
}): void {
  const { sh, runner, gateway } = params;
  // A previous capture that died leaves these names behind, so clear them first.
  sh('docker', ['rm', '-f', runner, gateway], { allowFailure: true });
  sh('docker', ['run', '-d', '--name', runner, params.image]);
  try {
    sh('docker', ['exec', runner, 'mkdir', '-p', '/tmp/capture']);
    sh('docker', [
      'run',
      '-d',
      '--name',
      gateway,
      '--network',
      `container:${runner}`,
      '-v',
      `${params.workDir}:${params.workDir}`,
      '-e',
      `CATALOG_FILE=${params.catalogFile}`,
      '-e',
      `LOG=${params.logFile}`,
      'node:22-slim',
      'node',
      join(params.workDir, 'gateway.mjs'),
    ]);
  } catch (error) {
    sh('docker', ['rm', '-f', runner, gateway], { allowFailure: true });
    throw error;
  }
}
