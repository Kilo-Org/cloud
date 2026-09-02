export const REPO_ROOT = '/workspace';

const REPO_ROOT_PREFIX = `${REPO_ROOT}/`;

export function toRepoRelativePath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;

  const withoutRoot =
    trimmed === REPO_ROOT || trimmed.startsWith(REPO_ROOT_PREFIX)
      ? trimmed.slice(REPO_ROOT.length)
      : trimmed;
  const relative = withoutRoot.replace(/^\/+/, '');
  if (!relative) return undefined;

  const parts = relative.split('/').filter(part => part && part !== '.');
  if (parts.length === 0 || parts.some(part => part === '..')) return undefined;
  return parts.join('/');
}

export function isGitPath(path: string): boolean {
  const relative = toRepoRelativePath(path);
  return relative === '.git' || relative?.startsWith('.git/') === true;
}
