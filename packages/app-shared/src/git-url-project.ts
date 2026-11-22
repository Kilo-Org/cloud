import { decodePercentEncodedSegments } from './percent-encoded-segments';

/** Drop one trailing `.git`, the suffix a clone URL carries and a name does not. */
function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

/**
 * Split a raw URL path into the segments that belong to the project. Empty
 * segments are dropped, so a trailing slash or a doubled separator adds no
 * part. A GitLab `-` separator at index 2 or later ends the project path: the
 * parts after it (`tree`, `blob`, `issues`) address something inside the
 * repository rather than the repository itself.
 */
function projectPathSegments(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const dashIndex = segments.indexOf('-');
  return dashIndex >= 2 ? segments.slice(0, dashIndex) : segments;
}

/**
 * Render a git URL as the `owner/repo` path its labels and filter keys show.
 * One normalizer serves every surface that names a repository, so an https URL,
 * an ssh URL and an already-short `owner/repo` value compare the same way on
 * the web todo list and in the mobile session list.
 *
 * Segments are percent-decoded because a session stores the encoded URL while
 * the repository's own name is the decoded one, and each segment is decoded
 * once: a name holding a literal `%` stays intact. A value that is already an
 * `owner/repo` path, or a URL whose path holds fewer than two parts, is
 * returned unchanged.
 */
export function formatGitUrlProject(gitUrl: string): string {
  const sshMatch = /^git@[^:]+:(.+)$/.exec(gitUrl);
  const sshPath = sshMatch?.[1];
  if (sshPath) {
    return stripGitSuffix(decodePercentEncodedSegments(projectPathSegments(sshPath).join('/')));
  }

  const protocolIndex = gitUrl.indexOf('://');
  if (protocolIndex === -1) {
    return gitUrl;
  }

  const pathStart = gitUrl.indexOf('/', protocolIndex + 3);
  if (pathStart === -1) {
    return gitUrl;
  }

  // The query and the fragment are not part of the path, so the first `?` or
  // `#` ends it.
  const pathText = gitUrl.slice(pathStart + 1);
  const pathEnd = pathText.search(/[?#]/);
  const rawPath = pathEnd === -1 ? pathText : pathText.slice(0, pathEnd);
  const projectParts = projectPathSegments(rawPath);

  if (projectParts.length >= 2) {
    return stripGitSuffix(decodePercentEncodedSegments(projectParts.join('/')));
  }

  return gitUrl;
}
