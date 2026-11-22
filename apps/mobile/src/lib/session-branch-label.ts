import { decodePercentEncodedSegments } from '@kilocode/app-shared/percent-encoded-segments';

/**
 * The branch label every surface reads: the session row, the shared-session
 * page, the instance picker, the search documents and the live and share
 * filters all paint or match this one string.
 *
 * A session stores its branch percent-encoded (`fix/%E8%AB%8B%E6%B1%82%E6%9B%B8`),
 * while the name people read is the decoded one, so the branch decodes with the
 * same rule the repository label uses. A branch that is absent or empty has no
 * label.
 *
 * It lives in `lib/` because the search documents and the instance picker rows
 * are `lib/` modules: a component module would make `lib/` depend on
 * `components/`.
 */
export function sessionBranchLabel(branch: string | null | undefined): string | null {
  if (branch == null || branch === '') {
    return null;
  }
  return decodePercentEncodedSegments(branch);
}
