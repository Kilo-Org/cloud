/** Preserve separate shell scopes when opening a legacy multi-script environment. */
export function toEnvironmentScript(commands: readonly string[]): string {
  if (commands.length <= 1) return commands[0] ?? '';
  return commands
    .map(command => `bash -e -o pipefail -c '${command.replace(/'/g, "'\\''")}'`)
    .join('\n\n');
}

export function toEnvironmentCommands(script: string): string[] {
  const trimmed = script.trim();
  return trimmed ? [trimmed] : [];
}
