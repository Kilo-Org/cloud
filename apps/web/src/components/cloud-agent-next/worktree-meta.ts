export type WorktreeRemoteDivergence = {
  ahead: number;
  behind: number;
  diverged: boolean;
};

export type WorktreeBaseRefFallback = {
  requested: string;
  used: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Older worker contracts do not carry divergence yet, so read the additive
 * fields defensively instead of claiming either state is present.
 */
export function readWorktreeSnapshotMeta(snapshot: unknown): {
  remoteDivergence: WorktreeRemoteDivergence | null;
  baseRefFallback: WorktreeBaseRefFallback | null;
} {
  const root = record(snapshot);
  const divergence = record(root?.remoteDivergence);
  const fallback = record(record(root?.comparison)?.baseRefFallback);

  const ahead = count(divergence?.ahead);
  const behind = count(divergence?.behind);
  return {
    remoteDivergence: divergence
      ? {
          ahead,
          behind,
          diverged:
            typeof divergence.diverged === 'boolean'
              ? divergence.diverged
              : ahead > 0 && behind > 0,
        }
      : null,
    baseRefFallback:
      typeof fallback?.requested === 'string' && typeof fallback.used === 'string'
        ? { requested: fallback.requested, used: fallback.used }
        : null,
  };
}

export function isRemoteBranchChanged(snapshot: unknown): boolean {
  const divergence = readWorktreeSnapshotMeta(snapshot).remoteDivergence;
  return divergence !== null && (divergence.behind > 0 || divergence.diverged);
}

/**
 * A repository identity includes the host, so the same `owner/name` on a
 * different provider can never be treated as the same stack repository.
 */
export function repositoryKeyFromGitUrl(gitUrl: string | null | undefined): string | null {
  if (!gitUrl) return null;
  const value = gitUrl.trim();
  if (!value) return null;

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp && !value.includes('://')) {
    return `${scp[1].toLowerCase()}/${scp[2]
      .replace(/^\/+/, '')
      .replace(/\.git$/i, '')
      .toLowerCase()}`;
  }

  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return `${url.hostname.toLowerCase()}${url.pathname
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase()}`;
  } catch {
    return null;
  }
}

export function repositoryKey({
  gitUrl,
  repository,
  platform,
}: {
  gitUrl?: string | null;
  repository?: string | null;
  platform?: string | null;
}): string | null {
  const fromUrl = repositoryKeyFromGitUrl(gitUrl);
  if (fromUrl) return fromUrl;
  if (!repository) return null;
  const normalized = repository.trim().toLowerCase();
  if (!normalized) return null;
  return platform ? `${platform.toLowerCase()}:${normalized}` : `repository:${normalized}`;
}

/** Strip the common remote prefixes so a base ref and a branch compare equal. */
export function shortBranchRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return (
    ref
      .trim()
      .replace(/^refs\/heads\//, '')
      .replace(/^refs\/remotes\/[^/]+\//, '')
      .replace(/^[^/]+\//, match => (match === 'origin/' ? '' : match)) || null
  );
}
