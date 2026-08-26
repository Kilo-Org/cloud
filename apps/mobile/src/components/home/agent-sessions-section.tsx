import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { expandPlatformFilter } from '@/components/agents/session-list-helpers';
import { StoredSessionRow } from '@/components/agents/session-row';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { SectionHeader } from '@/components/home/section-header';
import { Text } from '@/components/ui/text';
import {
  type ActiveSession,
  type StoredSession,
  useAgentSessions,
} from '@/lib/hooks/use-agent-sessions';
import { cn, parseTimestamp } from '@/lib/utils';

export const HOME_LIVE_SLOT_MIN_CLASS = 'min-h-[72px]';

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

export function buildRows(params: {
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

  return rows;
}

type AgentSessionsSectionProps = {
  organizationId: string | null;
};

export function AgentSessionsSection({ organizationId }: Readonly<AgentSessionsSectionProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { activeSessions, storedSessions, activeSessionIds } = useAgentSessions({
    organizationId,
  });
  const navigateToSession = useAgentSessionNavigator();

  const rows = buildRows({ activeSessions, storedSessions, activeSessionIds });

  return (
    <View>
      <SectionHeader
        label={t('home.agentSessions')}
        actionLabel={t('home.seeAll')}
        onActionPress={() => {
          router.push('/(app)/(tabs)/(2_agents)' as Href);
        }}
      />
      <View className="mx-4 gap-2">
        {rows.length === 0 && <LiveNowEmpty />}
        {rows.map(row => {
          if (row.kind === 'active') {
            const { session } = row;
            return (
              <View
                key={row.key}
                className={cn(
                  'overflow-hidden rounded-2xl border border-border bg-card',
                  HOME_LIVE_SLOT_MIN_CLASS
                )}
              >
                <RemoteSessionRow
                  session={session}
                  variant="card"
                  interactive={false}
                  onPress={() => {
                    navigateToSession(session.id);
                  }}
                />
              </View>
            );
          }
          const { session } = row;
          return (
            <View
              key={row.key}
              className={cn(
                'overflow-hidden rounded-2xl border border-border bg-card',
                HOME_LIVE_SLOT_MIN_CLASS
              )}
            >
              <StoredSessionRow
                session={session}
                sortBy="updated_at"
                variant="card"
                interactive={false}
                onPress={() => {
                  navigateToSession(session.session_id, session.organization_id);
                }}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}

function LiveNowEmpty() {
  const { t } = useTranslation();

  return (
    <View
      className={cn(
        'items-center justify-center rounded-2xl border border-border bg-card px-4',
        HOME_LIVE_SLOT_MIN_CLASS
      )}
    >
      <Text variant="muted" className="text-sm">
        {t('home.noLiveSessions')}
      </Text>
    </View>
  );
}
