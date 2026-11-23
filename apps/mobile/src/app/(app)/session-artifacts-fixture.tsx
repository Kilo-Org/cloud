import { Redirect, useLocalSearchParams } from 'expo-router';

import {
  isSessionArtifactsFixtureState,
  SessionArtifactsFixture,
  type SessionArtifactsFixtureState,
} from '@/components/agents/session-artifacts/session-artifacts-fixture';

/**
 * Development-only route for the design gate: the session artifacts sheet in one
 * state, so every state is measurable on a device that has no session with
 * saved files. The development fixture path in `src/app/+native-intent.tsx` maps
 * to it and names the state; a release build redirects away.
 */
export default function SessionArtifactsFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  if (!__DEV__) {
    return <Redirect href="/(auth)/login" />;
  }
  const fixtureState: SessionArtifactsFixtureState = isSessionArtifactsFixtureState(state)
    ? state
    : 'loaded';
  return <SessionArtifactsFixture state={fixtureState} />;
}
