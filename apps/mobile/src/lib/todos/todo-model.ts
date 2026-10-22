import { glanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { parseGitHubPrUrl } from '@/lib/github-pr-url';

export const TODO_TITLE_MAX_LENGTH = 500;
export const TODO_NOTES_MAX_LENGTH = 10_000;
export const TODO_LIST_NAME_MAX_LENGTH = 100;
export const TODO_LIST_EMOJI_MAX_LENGTH = 16;

type StatusSession = { status: string | null; prUrl: string | null };

/**
 * What a to-do's newest linked session is doing. A session waiting on the
 * user wins, then one still working, then its pull request, then a finished
 * run. A session with no reported status and no pull request has nothing to
 * show yet.
 */
export type TodoSessionStatus =
  | { kind: 'needsInput' }
  | { kind: 'running' }
  | { kind: 'pullRequest'; number: number | null }
  | { kind: 'done' };

/** `sessions` is newest first, as the router returns it. */
export function todoSessionStatus(sessions: readonly StatusSession[]): TodoSessionStatus | null {
  const newest = sessions[0];
  if (!newest) {
    return null;
  }
  const kind = newest.status === null ? null : glanceableStatusKind(newest.status);
  if (kind === 'needsInput') {
    return { kind: 'needsInput' };
  }
  if (kind === 'running' || kind === 'scheduled') {
    return { kind: 'running' };
  }
  if (newest.prUrl) {
    return { kind: 'pullRequest', number: parseGitHubPrUrl(newest.prUrl)?.number ?? null };
  }
  return kind === 'idle' ? { kind: 'done' } : null;
}

/** The first prompt of a session started from a to-do: its title, a blank line, its notes. */
export function todoSessionPrompt(todo: { title: string; notes: string | null }): string {
  const notes = todo.notes?.trim();
  return notes ? `${todo.title}\n\n${notes}` : todo.title;
}

/**
 * The longest prefix of `value` that fits in `maxUnits` UTF-16 code units,
 * which is what the router's `.max()` counts. A cut between the halves of a
 * surrogate pair leaves a lone high surrogate, so that unit is dropped.
 */
function capCodeUnits(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) {
    return value;
  }
  const head = value.slice(0, maxUnits);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/**
 * A new-session draft as a to-do: the first line is the title (capped at the
 * router's limit), the rest are the notes. Null for a blank draft.
 */
export function todoFromDraft(draft: string): { title: string; notes: string | null } | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lineBreak = trimmed.indexOf('\n');
  const firstLine = lineBreak === -1 ? trimmed : trimmed.slice(0, lineBreak);
  const rest = lineBreak === -1 ? '' : trimmed.slice(lineBreak + 1).trim();
  return {
    title: capCodeUnits(firstLine.trim(), TODO_TITLE_MAX_LENGTH),
    notes: rest.length > 0 ? capCodeUnits(rest, TODO_NOTES_MAX_LENGTH) : null,
  };
}

/**
 * The repository picker's `platform:fullName` value for a list's stored
 * `owner/repo`. A GitHub row wins, matching how the new-session prefill
 * resolves `prefillRepo`; an unknown repository still names GitHub so the
 * selector shows what the list holds.
 */
export function todoListRepoSelection(
  gitUrl: string | null,
  repositories: readonly { platform: string; fullName: string }[]
): string {
  if (!gitUrl) {
    return '';
  }
  const lower = gitUrl.toLowerCase();
  const matches = repositories.filter(repo => repo.fullName.toLowerCase() === lower);
  const match = matches.find(repo => repo.platform === 'github') ?? matches[0];
  return match ? `${match.platform}:${match.fullName}` : `github:${gitUrl}`;
}

/** The `owner/repo` a list stores for a picker `platform:fullName` value. */
export function todoListGitUrl(selection: string): string | null {
  const colon = selection.indexOf(':');
  const fullName = colon === -1 ? selection : selection.slice(colon + 1);
  return fullName.length > 0 ? fullName : null;
}
