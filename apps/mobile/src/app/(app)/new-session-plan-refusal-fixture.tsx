import { NewSessionPlanRefusalFixture } from '@/components/agents/new-session-plan-refusal-fixture';

/**
 * Development-only route for the design gate. It opens the real new-session
 * body in the state the spawn admission sets for a lapsed organization plan:
 * the failure spot above Start carries the plan explanation and no Retry.
 * Reached through `kiloapp:///dev/new-session-plan-refusal-fixture`; see
 * `src/app/+native-intent.tsx`. It is gated by that link, which only a
 * development build maps, and by the `__DEV__` check there.
 */
export default function NewSessionPlanRefusalFixtureRoute() {
  return <NewSessionPlanRefusalFixture />;
}
