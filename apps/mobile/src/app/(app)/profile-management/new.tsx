import { NewProfileScreen } from '@/components/profiles/new-profile-screen';
import { RootStackProfileScreen } from '@/components/profiles/root-stack-profile-screen';

export default function AppStackNewProfileRoute() {
  return (
    <RootStackProfileScreen>
      <NewProfileScreen stack="app" />
    </RootStackProfileScreen>
  );
}
