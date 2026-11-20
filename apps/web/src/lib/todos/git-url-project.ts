import { formatGitUrlProject } from '@kilocode/app-shared/git-url-project';

/**
 * Whether two values name the same repository. Each side is rendered as its
 * `owner/repo` path by the shared formatter, so an https URL, an ssh URL and an
 * already-short `owner/repo` value compare equal, and the comparison trims and
 * case-folds both sides.
 */
export function sameGitProject(left: string, right: string): boolean {
  return (
    formatGitUrlProject(left).trim().toLowerCase() ===
    formatGitUrlProject(right).trim().toLowerCase()
  );
}
