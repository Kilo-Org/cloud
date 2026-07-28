import { type Href, useRouter } from 'expo-router';
import { View } from 'react-native';

import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { expandPlatformFilter } from '@/components/agents/session-list-helpers';
import { StoredSessionRow } from '@/components/agents/session-row';
import { SectionHeader } from '@/components/home/section-header';
import { Text } from '@/components/ui/text';
import {
  type ActiveSession,
  type StoredSession,
  useAgentSessions,
} from '@/lib/hooks/use-agent-sessions';
import { parseTimestamp } from '@/lib/utils';

const MAX_ROWS = 3;
const CLOUD_AGENT_PLATFORMS = new Set(expandPlatformFilter(['cloud-agent']));

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
      rows.push({ key: `stored:${session.session_id}`, kind: 'stored', session });
      seenSessionIds.add(session.session_id);
    }
  }

  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; spread already prevents mutation of the source
  for (const session of [...offline].sort(sortByUpdated)) {
    if (rows.length >= MAX_ROWS) {
      break;
    }
    if (!seenSessionIds.has(session.session_id)) {
      rows.push({ key: `stored:${session.session_id}`, kind: 'stored', session });
      seenSessionIds.add(session.session_id);
    }
  }

  return rows;
}

// Whether the Home "Agent sessions" section has anything to render — mirrors
// buildRows' inclusion rule (any active session, or a cloud-agent stored
// session; stored CLI/other-platform sessions live on the Agents tab, not
// Home). The Home screen gates its section/promo/new-task button on this so a
// CLI-only account shows the first-use promo instead of an empty section.
export function hasDisplayableAgentSessions(
  storedSessions: StoredSession[],
  activeSessions: ActiveSession[]
): boolean {
  return (
    activeSessions.length > 0 ||
    storedSessions.some(s => CLOUD_AGENT_PLATFORMS.has(s.created_on_platform))
  );
}

type AgentSessionsSectionProps = {
  organizationId: string | null;
};

export function AgentSessionsSection({ organizationId }: Readonly<AgentSessionsSectionProps>) {
  const router = useRouter();
  const { activeSessions, storedSessions, activeSessionIds, activeIsError } = useAgentSessions({
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
      {activeIsError ? (
        <Text variant="muted" className="mx-4 mb-2 text-xs">
          Showing saved sessions — live status may be out of date
        </Text>
      ) : null}
      <View className="mx-4 gap-2">
        {rows.map(row => {
          if (row.kind === 'active') {
            const { session } = row;
            return (
              <View
                key={row.key}
                className="overflow-hidden rounded-2xl border border-border bg-card"
              >
                <RemoteSessionRow
                  session={session}
                  variant="card"
                  interactive={false}
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
              <StoredSessionRow
                session={session}
                sortBy="updated_at"
                variant="card"
                interactive={false}
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
