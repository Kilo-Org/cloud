import { type ActiveSession, type StoredSession } from '@/lib/hooks/use-agent-sessions';

export type StoredSessionItem = {
  kind: 'stored';
  session: StoredSession;
  isLive: boolean;
};

export type RemoteSessionItem = {
  kind: 'remote';
  session: ActiveSession;
};

export type SessionItem = StoredSessionItem | RemoteSessionItem;

export type SessionSection = {
  title: string;
  data: SessionItem[];
};

const platformExpansion: Record<string, string[]> = {
  'cloud-agent': ['cloud-agent', 'cloud-agent-web'],
  extension: ['vscode', 'agent-manager'],
};

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

export function expandPlatformFilter(filter: string[]): string[] {
  return filter.flatMap(p => platformExpansion[p] ?? [p]);
}

export function formatGitUrlProject(gitUrl: string): string {
  const sshMatch = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(gitUrl);
  const sshPath = sshMatch?.[1];
  if (sshPath) {
    return stripGitSuffix(sshPath);
  }

  const protocolIndex = gitUrl.indexOf('://');
  if (protocolIndex === -1) {
    return gitUrl;
  }

  const pathStart = gitUrl.indexOf('/', protocolIndex + 3);
  if (pathStart === -1) {
    return gitUrl;
  }

  const [rawPath = ''] = gitUrl.slice(pathStart + 1).split(/[?#]/);
  const pathParts = rawPath.split('/').filter(Boolean);
  const dashIndex = pathParts.indexOf('-');
  const projectParts = dashIndex >= 2 ? pathParts.slice(0, dashIndex) : pathParts;

  if (projectParts.length >= 2) {
    return stripGitSuffix(projectParts.join('/'));
  }

  return gitUrl;
}

export function matchesSearch(query: string, title: string | null, gitUrl: string | null): boolean {
  const q = query.toLowerCase();
  return (
    (title?.toLowerCase().includes(q) ?? false) || (gitUrl?.toLowerCase().includes(q) ?? false)
  );
}
