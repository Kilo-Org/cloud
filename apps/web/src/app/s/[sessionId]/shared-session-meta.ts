export function formatRepoFromGitUrl(gitUrl: string | null): string | null {
  if (!gitUrl) return null;

  const sshMatch = gitUrl.match(/^git@[^:]+:(.+)$/);
  let path: string | null;
  if (sshMatch) {
    path = sshMatch[1];
  } else {
    try {
      path = new URL(gitUrl).pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  const segments = path
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  if (segments.length < 2 || !segments[0] || !segments[1]) return null;

  return `${segments[0]}/${segments[1]}`;
}

export function formatSessionDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const normalized = isoDate.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date);
}
