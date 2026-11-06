import { Redirect } from 'expo-router';

import { SessionContextSheetFixture } from '@/components/agents/session-context-sheet-fixture';

// Dev-only design-gate surface: the dev context-sheet fixture link mounts the
// session context sheet the native presentation draws over a session, on
// sample data, so the gate measures it without a live session.
export default function ContextSheetFixtureRoute() {
  return __DEV__ ? <SessionContextSheetFixture /> : <Redirect href="/(auth)/login" />;
}
