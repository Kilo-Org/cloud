/* eslint-disable no-literal-copy/no-literal-copy -- Development-only stored history row fixture. */
import { useLocalSearchParams } from 'expo-router';
import { type ComponentProps, useEffect, useState } from 'react';
import { View } from 'react-native';

import { StoredSessionRow } from '@/components/agents/session-row';
import { i18n } from '@/i18n';

// Open the development session-row-fixture deep link to inspect history-row
// accessibility in one language. `lang` picks the catalog (Hindi by default) and
// `rows=repo` adds the repository-origin row that speaks its platform last.
export function SessionRowFixture() {
  const params = useLocalSearchParams<{ lang?: string; rows?: string }>();
  const requestedLanguage = params.lang ?? '';
  const lang = requestedLanguage === '' ? 'hi' : requestedLanguage;
  const repoRow = params.rows === 'repo';
  const [ready, setReady] = useState(false);
  const [timestamp] = useState(() => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
  useEffect(() => {
    async function prepare() {
      await i18n.changeLanguage(lang);
      setReady(true);
    }
    if (__DEV__) {
      void prepare();
    }
  }, [lang]);
  if (!ready) {
    return null;
  }
  return (
    <View className="flex-1 justify-center gap-6 bg-background">
      <StoredSessionRow
        session={cliSession(timestamp)}
        sortBy="updated_at"
        onPress={() => {
          setReady(false);
        }}
      />
      {repoRow ? (
        <StoredSessionRow
          session={repoSession(timestamp)}
          sortBy="updated_at"
          onPress={() => {
            setReady(false);
          }}
        />
      ) : null}
    </View>
  );
}

type FixtureSession = ComponentProps<typeof StoredSessionRow>['session'];

function cliSession(timestamp: string): FixtureSession {
  return {
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
  };
}

// The shape a history row has after a cloud run: a repository eyebrow, a cost
// and time meta, and the origin icon whose label the row speaks last.
function repoSession(timestamp: string): FixtureSession {
  return {
    session_id: 'session-row-repository-fixture',
    title: 'Conciliação de setembro',
    git_url: 'git@github.com:aurora/faturamento.git',
    cloud_agent_session_id: null,
    created_on_platform: 'cloud-agent',
    created_at: timestamp,
    updated_at: timestamp,
    git_branch: null,
    status: null,
    status_updated_at: null,
    total_cost_microdollars: 10_000,
  };
}
