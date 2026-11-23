import { z } from 'zod';

/**
 * Longest branch name the wire contracts carry.
 *
 * A git ref has no small limit of its own, and the producers that report one
 * send the developer's branch, so the value is shortened rather than refused:
 * a branch is display metadata, and a contract that rejects one fails the
 * message that carries it. 256 matches the Cloud Agent create-session
 * contract's `gitBranch`/`baseBranch` bound and the per-session heartbeat row.
 */
export const MAX_GIT_BRANCH_LENGTH = 256;

/**
 * A branch shortened to `MAX_GIT_BRANCH_LENGTH`. The cut counts UTF-16 code
 * units, the unit a producer slices with, and never leaves a lone high
 * surrogate, so the shortened value stays valid text.
 */
export function shortenGitBranch(value: string): string {
  if (value.length <= MAX_GIT_BRANCH_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_GIT_BRANCH_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
}

/** A branch field that shortens an over-long value instead of failing the message. */
export const gitBranchValueSchema = z.string().transform(shortenGitBranch);
