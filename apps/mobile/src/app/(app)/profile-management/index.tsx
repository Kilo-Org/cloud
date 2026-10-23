import { ProfilesListScreen } from '@/components/profiles/profiles-list-screen';
import { RootStackProfileScreen } from '@/components/profiles/root-stack-profile-screen';

/**
 * Profile management opened from the root `(app)` Stack (the new-session form,
 * an agent session). Back returns to the screen that opened it instead of the
 * Profile tab root; the Profile tab keeps its own copy at
 * `(tabs)/(3_profile)/profiles`.
 */
export default function AppStackProfilesListRoute() {
  return (
    <RootStackProfileScreen>
      <ProfilesListScreen stack="app" />
    </RootStackProfileScreen>
  );
}
