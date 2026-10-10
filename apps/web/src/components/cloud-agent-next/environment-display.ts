import type { EnvironmentSummary } from '@kilocode/cloud-agent-profile';

/** Compact "3 vars · 2 cmds" summary, or an empty string when the environment is empty. */
export function formatEnvironmentCounts(environment: EnvironmentSummary): string {
  const vars = environment.plainVarCount + environment.secretCount;
  return [
    vars > 0 && `${vars} vars`,
    environment.commandCount > 0 && `${environment.commandCount} cmds`,
  ]
    .filter(Boolean)
    .join(' · ');
}
