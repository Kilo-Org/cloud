import { useState } from 'react';
import type { JSX } from 'react';
import { AgentsSessionList } from './agents-session-list';
import { AgentsSessionView } from './agents-session-view';
import { AgentsNewSession } from './agents-new-session';

type AgentsView = { kind: 'list' } | { kind: 'session'; kiloSessionId: string } | { kind: 'new' };

export const AgentsMode = (): JSX.Element => {
  const [view, setView] = useState<AgentsView>({ kind: 'list' });

  if (view.kind === 'session') {
    return (
      <AgentsSessionView
        kiloSessionId={view.kiloSessionId}
        onBack={() => {
          setView({ kind: 'list' });
        }}
      />
    );
  }

  if (view.kind === 'new') {
    return (
      <AgentsNewSession
        onCancel={() => {
          setView({ kind: 'list' });
        }}
        onCreated={(kiloSessionId: string) => {
          setView({ kiloSessionId, kind: 'session' });
        }}
      />
    );
  }

  return (
    <AgentsSessionList
      onNewSession={() => {
        setView({ kind: 'new' });
      }}
      onOpenSession={(kiloSessionId: string) => {
        setView({ kiloSessionId, kind: 'session' });
      }}
    />
  );
};
