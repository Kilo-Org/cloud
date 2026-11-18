/**
 * Resume-position planning for a session opened from a `?at=` deep link.
 *
 * Pure, no React: the transcript screen builds the ordered anchor ids, runs
 * `planResumeScroll`, and acts on the plan. Keeping the decision here means the
 * pagination bound and the "unknown anchor is not an error" contract are
 * testable without mounting the list.
 */

import { parseParam } from '@/lib/route-params';

/**
 * Hard ceiling on older pages a single resume may request. A session whose
 * anchor lives past this many pages is opened at the bottom, exactly like a
 * link with no anchor — the resume must never walk the whole history.
 */
export const MAX_RESUME_OLDER_LOADS = 8;

export type ResumeScrollPlan =
  | { kind: 'scroll'; index: number }
  | { kind: 'load-older' }
  | { kind: 'none' };

/**
 * Runtime-validate the `at` route param. Expo Router hands a repeated segment
 * as an array, so take its first element; trim it and treat an empty value as
 * absent. Returns `null` for anything unusable, which the screen turns into
 * "open at the bottom" — never an error.
 */
export function parseResumeAnchor(raw: string | string[] | undefined): string | null {
  const single = Array.isArray(raw) ? raw[0] : raw;
  const value = parseParam(single);
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Decide what a resume should do given the rows the list currently holds.
 *
 * - `scroll`: the anchor is one of the rendered rows — land on its index.
 * - `load-older`: the anchor is not rendered yet and older history exists —
 *   request one page and re-plan when it arrives, bounded by `maxOlderLoads`.
 * - `none`: the anchor is gone, or the bound is hit. Nothing scrolls and
 *   nothing blanks — the session opens exactly as it does without an anchor.
 */
export function planResumeScroll({
  anchorIds,
  anchorMessageId,
  hasOlderMessages,
  olderLoadAttempts,
  maxOlderLoads,
}: {
  anchorIds: readonly (string | null)[];
  anchorMessageId: string | null;
  hasOlderMessages: boolean;
  olderLoadAttempts: number;
  maxOlderLoads?: number;
}): ResumeScrollPlan {
  const anchor = anchorMessageId === null ? '' : anchorMessageId.trim();
  // No anchor to find: nothing to scroll and nothing to load.
  if (anchor.length === 0) {
    return { kind: 'none' };
  }
  const index = anchorIds.indexOf(anchor);
  if (index !== -1) {
    return { kind: 'scroll', index };
  }

  const bound = Math.min(maxOlderLoads ?? MAX_RESUME_OLDER_LOADS, MAX_RESUME_OLDER_LOADS);
  if (hasOlderMessages && olderLoadAttempts < bound) {
    return { kind: 'load-older' };
  }

  return { kind: 'none' };
}
