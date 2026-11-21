import { ProfilesListScreen } from '@/components/profiles/profiles-list-screen';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';

export default function ProfilesListRoute() {
  return <ProfilesListScreen stack="profileTab" backFallback={PROFILE_TAB_HREF} />;
}
