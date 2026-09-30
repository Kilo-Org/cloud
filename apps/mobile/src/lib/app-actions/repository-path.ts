/** A project-path segment the providers accept. */
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Walk a path, dropping empty segments and a trailing `.git`, and reject any
 * shape the providers never name a project with. GitLab subgroups survive:
 * the full path is kept, not just its last segment. `.` and `..` are rejected
 * so a repository name cannot climb out of the project path.
 */
export function repositoryPath(segments: readonly string[]): string | null {
  const raw = segments.filter(segment => segment.length > 0);
  if (raw.length === 0) {
    return null;
  }
  const cleaned = raw.map((segment, index) =>
    index === raw.length - 1 ? segment.replace(/\.git$/i, '') : segment
  );
  if (
    cleaned.some(
      segment =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !REPOSITORY_SEGMENT_PATTERN.test(segment)
    )
  ) {
    return null;
  }
  return cleaned.join('/');
}

/** The project path inside a `scheme://host/path` or `git@host:path` value. */
export function urlRepositoryPath(raw: string): string | null {
  const scp = /^git@[^:]+:(.+)$/.exec(raw);
  if (scp) {
    return repositoryPath((scp[1] ?? '').split('/'));
  }
  const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?[^/?#]+(?:\/([^?#]*))?/.exec(raw);
  if (url) {
    return repositoryPath((url[1] ?? '').split('/'));
  }
  return null;
}
