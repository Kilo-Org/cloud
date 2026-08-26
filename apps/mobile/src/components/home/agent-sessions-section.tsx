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

/**
 * Agents tab index href, used by Home See-all. Kept as a named export so the
 * section test can assert this lands on the live index, never the history
 * subpage. The trailing slash pins the index route of the Agents stack.
 */
export const AGENTS_INDEX_HREF = '/(app)/(tabs)/(2_agents)/' as const;

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
          // `navigate` switches to the Agents tab but keeps a pushed history
          // screen on top (expo-router turns the cross-tab navigate into a
          // JUMP_TO). The follow-up `dismissTo` pops that nested stack to the
          // index route, so Home See-all always lands on the live list.
          router.navigate(AGENTS_INDEX_HREF as Href);
          router.dismissTo(AGENTS_INDEX_HREF as Href);
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
                  navigateToSession(
                    session.session_id,
                    session.organization_id,
                    session.title ?? undefined
                  );
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
