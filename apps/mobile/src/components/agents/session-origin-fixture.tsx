/* eslint-disable no-literal-copy/no-literal-copy -- Development-only stored history row fixture. */
import { View } from 'react-native';

import { StoredSessionRow } from '@/components/agents/session-row';

/**
 * Stored history rows at the three origin states the eyebrow distinguishes:
 * a recorded platform, the backend's `'unknown'` sentinel, and no origin at
 * all. The last two are stored sessions of unknown origin, so their eyebrow
 * names the origin and never a live state.
 *
 * Open it with the `dev/session-origin-fixture` development link. The four
 * rows share one timestamp so the eyebrow is the only thing that differs.
 */
const FIXTURE_SESSIONS = [
  { session_id: 'session-origin-fixture-cli', title: 'Recorded origin', origin: 'cli' },
  { session_id: 'session-origin-fixture-sentinel', title: 'Sentinel origin', origin: 'unknown' },
  { session_id: 'session-origin-fixture-absent', title: 'Absent origin', origin: '' },
];

export function SessionOriginFixture() {
  const timestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  return (
    <View className="flex-1 justify-center bg-background">
      {FIXTURE_SESSIONS.map(session => (
        <StoredSessionRow
          key={session.session_id}
          session={{
            session_id: session.session_id,
            title: session.title,
            git_url: null,
            cloud_agent_session_id: null,
            created_on_platform: session.origin,
            created_at: timestamp,
            updated_at: timestamp,
            git_branch: null,
            status: null,
            status_updated_at: null,
            total_cost_microdollars: 10_000,
          }}
          sortBy="updated_at"
          onPress={() => undefined}
        />
      ))}
    </View>
  );
}
