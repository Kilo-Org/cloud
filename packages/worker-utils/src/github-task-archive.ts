export type GitHubTaskArchive = {
  owner: string;
  repository: string;
  format: 'tar' | 'zip';
};

export function getGitHubTaskArchive(url: URL): GitHubTaskArchive | undefined {
  if (
    url.origin !== 'https://api.github.com' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    return;
  const match = /^\/repos\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/(tarball|zipball)(?:\/.+)?$/i.exec(
    url.pathname
  );
  if (!match) return;
  return {
    owner: match[1].toLowerCase(),
    repository: match[2].toLowerCase(),
    format: match[3].toLowerCase() === 'tarball' ? 'tar' : 'zip',
  };
}

/** The redirect must come from GitHub's authenticated archive endpoint, never from the guest. */
export function githubTaskArchiveRedirect(
  value: string,
  archive: GitHubTaskArchive
): URL | undefined {
  if (
    value.length > 16_384 ||
    value.includes('\\') ||
    [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.origin !== 'https://codeload.github.com' || url.username || url.password || url.hash)
    return;
  const parts = url.pathname.split('/');
  if (
    parts[1]?.toLowerCase() !== archive.owner ||
    parts[2]?.toLowerCase() !== archive.repository ||
    !(archive.format === 'tar' ? ['tar.gz', 'legacy.tar.gz'] : ['zip', 'legacy.zip']).includes(
      parts[3]
    ) ||
    parts.length < 5 ||
    parts.slice(4).some(part => part.length === 0)
  )
    return;
  return url;
}
