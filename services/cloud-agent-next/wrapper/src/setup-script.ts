import { runProcess, type ProcessOptions } from './utils.js';

/** Setup uses Bash and stops on an unhandled command or pipeline failure. */
export function runSetupScript(
  script: string,
  options: ProcessOptions,
  run: typeof runProcess = runProcess
) {
  return run('bash', ['-e', '-o', 'pipefail', '-c', script], options);
}
