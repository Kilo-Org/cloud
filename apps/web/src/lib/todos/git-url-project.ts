// Port of the mobile app's `formatGitUrlProject` (apps/mobile session-list
// helpers): renders an https or ssh git URL as its `owner/repo` path, and
// returns an already-short `owner/repo` value unchanged. Keep the two in sync
// so a list's repository and a session's git URL compare the same way on both
// sides.
function formatGitUrlProject(gitUrl: string): string {
  const stripGitSuffix = (value: string) => (value.endsWith('.git') ? value.slice(0, -4) : value);

  // A session stores the encoded URL while a repository's own name is the
  // decoded one, so each segment is decoded exactly once. Splitting first keeps
  // an encoded slash inside its own segment, and a malformed escape keeps its
  // raw segment instead of throwing.
  const decodePathSegments = (path: string) =>
    path
      .split('/')
      .map(segment => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join('/');

  const sshPath = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(gitUrl)?.[1];
  if (sshPath) return stripGitSuffix(decodePathSegments(sshPath));

  const protocolIndex = gitUrl.indexOf('://');
  if (protocolIndex === -1) return gitUrl;

  const pathStart = gitUrl.indexOf('/', protocolIndex + 3);
  if (pathStart === -1) return gitUrl;

  const [rawPath = ''] = gitUrl.slice(pathStart + 1).split(/[?#]/);
  const pathParts = rawPath.split('/').filter(Boolean);
  const dashIndex = pathParts.indexOf('-');
  const projectParts = dashIndex >= 2 ? pathParts.slice(0, dashIndex) : pathParts;

  return projectParts.length >= 2
    ? stripGitSuffix(decodePathSegments(projectParts.join('/')))
    : gitUrl;
}

export function sameGitProject(left: string, right: string): boolean {
  return (
    formatGitUrlProject(left).trim().toLowerCase() ===
    formatGitUrlProject(right).trim().toLowerCase()
  );
}
