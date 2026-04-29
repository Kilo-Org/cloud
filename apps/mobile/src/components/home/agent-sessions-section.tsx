import { type Href, useRouter } from 'expo-router';
import { View } from 'react-native';

import {
  expandPlatformFilter,
  formatGitUrlProject,
} from '@/components/agents/session-list-helpers';
import { CompactSessionRow } from '@/components/home/compact-session-row';
import { SectionHeader } from '@/components/home/section-header';
import {
  type ActiveSession,
  type StoredSession,
  useAgentSessions,
} from '@/lib/hooks/use-agent-sessions';
import { parseTimestamp, timeAgo } from '@/lib/utils';

const MAX_ROWS = 3;
const CLOUD_AGENT_PLATFORMS = new Set(expandPlatformFilter(['cloud-agent']));

/**
 * Map backend `created_on_platform` strings to a pretty uppercase label.
 * The row's hue is hashed from the label in `SessionRow`, so no agent
 * key needs to be emitted here.
 */
function platformLabel(platform: string): string {
  switch (platform) {
    case 'cloud-agent':
    case 'cloud-agent-web': {
      return 'CLOUD AGENT';
    }
    case 'vscode':
    case 'agent-manager': {
      return 'VSCODE';
    }
    case 'slack': {
      return 'SLACK';
    }
    case 'cli': {
      return 'CLI';
    }
    default: {
      return platform.toUpperCase();
    }
  }
}

function repoNameFromGitUrl(gitUrl: string | null | undefined): string | null {
  if (!gitUrl) {
    return null;
  }
  const project = formatGitUrlProject(gitUrl);
  const parts = project.split('/');
  return parts.at(-1) ?? project;
}

type Row =
  | {
      key: string;
      kind: 'active';
      session: ActiveSession;
    }
  | {
      key: string;
      kind: 'stored';
      session: StoredSession;
      isLive: boolean;
    };

function buildRows(params: {
  activeSessions: ActiveSession[];
  storedSessions: StoredSession[];
  activeSessionIds: Set<string>;
}): Row[] {
  const { activeSessions, storedSessions, activeSessionIds } = params;
  const rows: Row[] = [];
  const seenSessionIds = new Set<string>();

  for (const session of activeSessions) {
    if (rows.length >= MAX_ROWS) {
      break;
    }
    rows.push({ key: `active:${session.id}`, kind: 'active', session });
    seenSessionIds.add(session.id);
  }

  const cloudAgentStored = storedSessions.filter(s =>
    CLOUD_AGENT_PLATFORMS.has(s.created_on_platform)
  );
  const live = cloudAgentStored.filter(s => activeSessionIds.has(s.session_id));
  const offline = cloudAgentStored.filter(s => !activeSessionIds.has(s.session_id));

  const sortByUpdated = (a: StoredSession, b: StoredSession) =>
    parseTimestamp(b.status_updated_at ?? b.updated_at).getTime() -
    parseTimestamp(a.status_updated_at ?? a.updated_at).getTime();

  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; spread already prevents mutation of the source
  for (const session of [...live].sort(sortByUpdated)) {
    if (rows.length >= MAX_ROWS) {
      break;
    }
    if (!seenSessionIds.has(session.session_id)) {
      rows.push({ key: `stored:${session.session_id}`, kind: 'stored', session, isLive: true });
      seenSessionIds.add(session.session_id);
    }
  }

  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; spread already prevents mutation of the source
  for (const session of [...offline].sort(sortByUpdated)) {
    if (rows.length >= MAX_ROWS) {
      break;
    }
    if (!seenSessionIds.has(session.session_id)) {
      rows.push({ key: `stored:${session.session_id}`, kind: 'stored', session, isLive: false });
      seenSessionIds.add(session.session_id);
    }
  }

  return rows;
}

type AgentSessionsSectionProps = {
  organizationId: string | null;
};

function activeSessionTitle(session: ActiveSession): string {
  return session.title.length > 0 ? session.title : 'Untitled session';
}

function storedSessionTitle(session: StoredSession): string {
  return session.title && session.title.length > 0 ? session.title : 'Untitled session';
}

function storedSessionMeta(session: StoredSession): string {
  const tsSource = session.status_updated_at ?? session.updated_at;
  return timeAgo(parseTimestamp(tsSource)).toUpperCase();
}

function activeSessionLabel(session: ActiveSession): string {
  const repo = repoNameFromGitUrl(session.gitUrl);
  return repo ? repo.toUpperCase() : platformLabel('cloud-agent');
}

function storedSessionLabel(session: StoredSession): string {
  const repo = repoNameFromGitUrl(session.git_url);
  return repo ? repo.toUpperCase() : platformLabel(session.created_on_platform);
}

export function AgentSessionsSection({ organizationId }: Readonly<AgentSessionsSectionProps>) {
  const router = useRouter();
  const { activeSessions, storedSessions, activeSessionIds } = useAgentSessions({
    organizationId,
  });

  const rows = buildRows({ activeSessions, storedSessions, activeSessionIds });

  if (rows.length === 0) {
    return null;
  }

  const navigateTo = (sessionId: string, sessionOrgId?: string | null) => {
    const path = sessionOrgId
      ? `/(app)/agent-chat/${sessionId}?organizationId=${sessionOrgId}`
      : `/(app)/agent-chat/${sessionId}`;
    router.push(path as Href);
  };

  return (
    <View>
      <SectionHeader
        label="Agent sessions"
        actionLabel="See all"
        onActionPress={() => {
          router.push('/(app)/(tabs)/(2_agents)' as Href);
        }}
      />
      <View className="mx-4 gap-2">
        {rows.map(row => {
          if (row.kind === 'active') {
            const { session } = row;
            return (
              <View
                key={row.key}
                className="overflow-hidden rounded-2xl border border-border bg-card"
              >
                <CompactSessionRow
                  agentLabel={activeSessionLabel(session)}
                  title={activeSessionTitle(session)}
                  isLive
                  last
                  onPress={() => {
                    navigateTo(session.id);
                  }}
                />
              </View>
            );
          }
          const { session } = row;
          return (
            <View
              key={row.key}
              className="overflow-hidden rounded-2xl border border-border bg-card"
            >
              <CompactSessionRow
                agentLabel={storedSessionLabel(session)}
                title={storedSessionTitle(session)}
                meta={storedSessionMeta(session)}
                isLive={row.isLive}
                last
                onPress={() => {
                  navigateTo(session.session_id, session.organization_id);
                }}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}
