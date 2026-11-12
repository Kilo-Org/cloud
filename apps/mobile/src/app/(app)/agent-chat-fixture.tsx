import { Redirect } from 'expo-router';
import { useMemo } from 'react';

import { SessionDetailContent } from '@/components/agents/session-detail-content';
import {
  AGENT_CHAT_FIXTURE_SESSION_ID,
  createAgentChatFixtureManager,
} from '@/components/agents/agent-chat-live-fixture';
import { SessionManagerContext } from '@/components/agents/session-manager-context';

/** A personal session, already resolved: the scope the fixture reports. */
const FIXTURE_DISPLAY_SCOPE = { organizationId: null, isResolved: true };

/**
 * Development-only route for the design gate: the agent chat screen — transcript
 * and composer — on a fixed transcript and a manager that never changes. A live
 * session keeps moving while a cell samples it, so this is the screen the gate
 * can compare between two revisions. The refused message renders as an
 * undelivered bubble with Retry, and the composer stays empty.
 *
 * The development fixture path in `src/app/+native-intent.tsx` maps to it, and a
 * release build refuses the path outright so the fixture is never reachable.
 */
export default function AgentChatFixtureRoute() {
  const manager = useMemo(() => createAgentChatFixtureManager(), []);
  if (!__DEV__) {
    return <Redirect href="/(auth)/login" />;
  }
  return (
    <SessionManagerContext.Provider value={manager}>
      <SessionDetailContent
        sessionId={AGENT_CHAT_FIXTURE_SESSION_ID}
        displayScope={FIXTURE_DISPLAY_SCOPE}
      />
    </SessionManagerContext.Provider>
  );
}
