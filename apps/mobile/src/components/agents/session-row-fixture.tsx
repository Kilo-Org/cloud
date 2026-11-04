/* eslint-disable no-literal-copy/no-literal-copy -- Development-only stored history row fixture. */
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { StoredSessionRow } from '@/components/agents/session-row';
import { i18n } from '@/i18n';

// Open the development session-row-fixture deep link to inspect Hindi history-row accessibility.
export function SessionRowFixture() {
  const [ready, setReady] = useState(false);
  const [timestamp] = useState(() => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
  useEffect(() => {
    async function prepare() {
      await i18n.changeLanguage('hi');
      setReady(true);
    }
    if (__DEV__) {
      void prepare();
    }
  }, []);
  if (!ready) {
    return null;
  }
  return (
    <View className="flex-1 justify-center bg-background">
      <StoredSessionRow
        session={{
          session_id: 'session-row-localization-fixture',
          title: 'Session label fixture',
          git_url: null,
          cloud_agent_session_id: null,
          created_on_platform: 'cli',
          created_at: timestamp,
          updated_at: timestamp,
          git_branch: null,
          status: null,
          status_updated_at: null,
          total_cost_microdollars: 10_000,
        }}
        sortBy="updated_at"
        onPress={() => {
          setReady(false);
        }}
      />
    </View>
  );
}
