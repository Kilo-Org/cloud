import type { ProviderStartupCommand } from './provider.js';

/**
 * Tag a `/bin/sh -c <script>` startup command so that a lost exec reply can be
 * reconciled by listing the sandbox's commands. The tag is a trailing shell
 * comment after the script's final `exec`, so it never runs.
 */
export function markedStartupCommand(
  startup: ProviderStartupCommand,
  marker: string
): { command: string; args: string[] } {
  const [command, flag, script, ...rest] = startup.argv;
  if (command === undefined || flag !== '-c' || script === undefined || rest.length > 0) {
    throw new Error('Startup command is not a shell script');
  }
  return { command, args: [flag, `${script}\n# ${marker}`] };
}

/** Whether a listed command carries `marker`, including the earlier single-line form. */
export function hasStartupMarker(args: readonly string[], marker: string): boolean {
  return args.some(argument => argument.includes(`# ${marker}`));
}
