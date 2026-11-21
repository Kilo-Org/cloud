import { ProfilesListScreen } from '@/components/profiles/profiles-list-screen';
import { AGENTS_SESSIONS_HREF } from '@/lib/agents-sessions-route';

/**
 * Profile management opened from the root `(app)` Stack (the new-session form,
 * an agent session). Back returns to the screen that opened it instead of the
 * Profile tab root; the Profile tab keeps its own copy at
 * `(tabs)/(3_profile)/profiles`. This list is the root of its Stack, so with no
 * history to pop the header Back replaces it with the sessions list that opens
 * the profile tree.
 */
export default function AppStackProfilesListRoute() {
  return <ProfilesListScreen stack="app" backFallback={AGENTS_SESSIONS_HREF} />;
}
