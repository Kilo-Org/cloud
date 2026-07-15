import {
  matchesSearch,
  type RemoteSessionItem,
  type SessionItem,
  type SessionSection,
  type StoredSessionItem,
} from '@/components/agents/session-list-helpers';
import { type ActiveSession, type StoredSession } from '@/lib/hooks/use-agent-sessions';

type StoredGroup = { label: string; sessions: StoredSession[] };

type BuildSessionSectionsInput = {
  activeNow: boolean;
  activeSessions: ActiveSession[];
  storedGroups: StoredGroup[];
  platformFilter: string[];
  projectFilter: string[];
  searchQuery: string;
  organizationId?: string | null;
};

const knownPlatforms = new Set([
  'cloud-agent',
  'cloud-agent-web',
  'vscode',
  'agent-manager',
  'cli',
  'slack',
  'github',
  'linear',
]);

function matchesPlatformSelection(platform: string, selected: string[]): boolean {
  if (selected.length === 0) return true;
  return selected.some(value => {
    if (value === 'cloud-agent') return platform === 'cloud-agent' || platform === 'cloud-agent-web';
    if (value === 'extension') return platform === 'vscode' || platform === 'agent-manager';
    if (value === 'other') return !knownPlatforms.has(platform);
    return platform === value;
  });
}

function matchesActiveFilters(
  session: ActiveSession,
  input: Pick<
    BuildSessionSectionsInput,
    'organizationId' | 'platformFilter' | 'projectFilter' | 'searchQuery'
  >
): boolean {
  const sessionOrganizationId = session.organizationId ?? null;
  if (input.organizationId !== undefined && sessionOrganizationId !== input.organizationId) {
    return false;
  }
  const platform = session.createdOnPlatform ?? 'cli';
  if (!matchesPlatformSelection(platform, input.platformFilter)) return false;
  if (input.projectFilter.length > 0 && (!session.gitUrl || !input.projectFilter.includes(session.gitUrl))) {
    return false;
  }
  return input.searchQuery
    ? matchesSearch(input.searchQuery, session.title, session.gitUrl ?? null)
    : true;
}

function storedItem(session: StoredSession, activeIds: Set<string>): StoredSessionItem {
  return { kind: 'stored', session, isLive: activeIds.has(session.session_id) };
}

export function buildSessionSections(input: BuildSessionSectionsInput): SessionSection[] {
  const activeIds = new Set(input.activeSessions.map(session => session.id));
  const seenStoredIds = new Set<string>();
  const storedGroups = input.storedGroups.map(group => ({
    ...group,
    sessions: group.sessions.filter(session => {
      if (seenStoredIds.has(session.session_id)) return false;
      seenStoredIds.add(session.session_id);
      return true;
    }),
  }));
  const visibleStored = storedGroups.flatMap(group => group.sessions);
  const storedIds = new Set(visibleStored.map(session => session.session_id));
  const activeOnly = input.activeSessions.filter(
    session => !storedIds.has(session.id) && matchesActiveFilters(session, input)
  );
  const result: SessionSection[] = [];

  if (input.activeNow) {
    const activeItems: SessionItem[] = [
      ...visibleStored
        .filter(session => activeIds.has(session.session_id))
        .map(session => storedItem(session, activeIds)),
      ...activeOnly.map((session): RemoteSessionItem => ({ kind: 'remote', session })),
    ];
    if (activeItems.length > 0) result.push({ title: 'Active now', data: activeItems });
  } else if (activeOnly.length > 0) {
    result.push({
      title: 'Remote',
      data: activeOnly.map((session): RemoteSessionItem => ({ kind: 'remote', session })),
    });
  }

  for (const group of storedGroups) {
    const sessions = input.activeNow
      ? group.sessions.filter(session => !activeIds.has(session.session_id))
      : group.sessions;
    if (sessions.length > 0) {
      result.push({
        title: group.label,
        data: sessions.map(session => storedItem(session, activeIds)),
      });
    }
  }

  return result;
}
