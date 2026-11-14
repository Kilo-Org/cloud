/**
 * The appended system-prompt line for a stacked workspace (plan Phase 0).
 *
 * It is derived from the grouped repository base branch and the workspace's own
 * branch, so it can be replaced when a completed Restack result moves the base.
 * Keeping the derivation here avoids two copies of the wording drifting.
 */
const STACKED_INSTRUCTION_PREFIX = 'This workspace is stacked on `';
const STACKED_INSTRUCTION_LINE = /^This workspace is stacked on `[^`\r\n]+`\..*(?:\r?\n)?$/m;

export function stackedWorkspaceInstruction(baseBranch: string, branch: string): string {
  return `${STACKED_INSTRUCTION_PREFIX}${baseBranch}\`. Open pull requests with \`--base ${baseBranch}\`. Do not rebase or push branches other than \`${branch}\`.`;
}

/**
 * Adds the stacked instruction to any existing appended prompt. The line is
 * idempotent: a previous stacked instruction is replaced instead of duplicated.
 */
export function withStackedWorkspaceInstruction(
  existing: string | undefined,
  baseBranch: string | undefined,
  branch: string
): string | undefined {
  const withoutStacked =
    existing === undefined ? undefined : existing.replace(STACKED_INSTRUCTION_LINE, '').trim();
  if (baseBranch === undefined) {
    return withoutStacked === undefined || withoutStacked === '' ? undefined : withoutStacked;
  }
  const instruction = stackedWorkspaceInstruction(baseBranch, branch);
  return withoutStacked === undefined || withoutStacked === ''
    ? instruction
    : `${withoutStacked}\n\n${instruction}`;
}
