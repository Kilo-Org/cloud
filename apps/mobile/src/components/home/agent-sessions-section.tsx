import { type Href, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { CompactSessionRow } from '@/components/home/compact-session-row';
import { SectionHeader } from '@/components/home/section-header';
import {
  expandPlatformFilter,
  formatGitUrlProject,
} from '@/components/agents/session-list-helpers';
import { Text } from '@/components/ui/text';
import {
  type ActiveSession,
  type StoredSession,
  useAgentSessions,
} from '@/lib/hooks/use-agent-sessions';
import { parseTimestamp, timeAgo } from '@/lib/utils';

const MAX_ROWS = 3;
const CLOUD_AGENT_PLATFORMS = new Set(expandPlatformFilter(['cloud-agent']));

type StatusPresentation = {
  label: string | null;
  tone: 'running' | 'ready' | 'idle';
};

function presentStatus(status: string | null | undefined): StatusPresentation {
  if (!status) {
    return { label: null, tone: 'idle' };
  }
  const normalized = status.toLowerCase();
  if (normalized.includes('running') || normalized === 'active') {
    return { label: 'Running', tone: 'running' };
  }
  if (normalized.includes('pr') || normalized.includes('ready') || normalized.includes('review')) {
    return { label: 'PR ready', tone: 'ready' };
  }
  if (normalized.includes('complete') || normalized.includes('done')) {
    return { label: 'Completed', tone: 'idle' };
  }
  return { label: status, tone: 'idle' };
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
    <View className="gap-2">
      <SectionHeader
        label="Agent sessions"
        action={
          <Pressable
            onPress={() => {
              router.push('/(app)/(tabs)/(2_agents)' as Href);
            }}
            hitSlop={8}
            accessibilityLabel="See all agent sessions"
          >
            <Text className="text-sm text-primary">See all</Text>
          </Pressable>
        }
      />
      <View className="mx-4 gap-2">
        {rows.map(row => {
          if (row.kind === 'active') {
            const { session } = row;
            const status = presentStatus(session.status);
            return (
              <CompactSessionRow
                key={row.key}
                repoName={repoNameFromGitUrl(session.gitUrl)}
                title={session.title.length > 0 ? session.title : 'Untitled session'}
                statusLabel={status.label}
                statusTone={status.tone}
                timeLabel={null}
                isLive
                onPress={() => {
                  navigateTo(session.id);
                }}
              />
            );
          }
          const { session } = row;
          const title =
            session.title && session.title.length > 0 ? session.title : 'Untitled session';
          const status = presentStatus(session.status);
          const tsSource = session.status_updated_at ?? session.updated_at;
          return (
            <CompactSessionRow
              key={row.key}
              repoName={repoNameFromGitUrl(session.git_url)}
              title={title}
              statusLabel={status.label}
              statusTone={status.tone}
              timeLabel={timeAgo(parseTimestamp(tsSource))}
              isLive={row.isLive}
              onPress={() => {
                navigateTo(session.session_id, session.organization_id);
              }}
            />
          );
        })}
      </View>
    </View>
  );
}
