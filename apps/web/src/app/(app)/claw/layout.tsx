import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { PylonWidget } from '@/components/pylon-widget';
import { PylonSupportButton } from '@/components/pylon-support-button';
import { PersonalInstancePresenceMount } from './components/PersonalInstancePresenceMount';

export default async function ClawLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return (
    <>
      <PersonalInstancePresenceMount />
      {children}
      <PylonWidget>
        <PylonSupportButton />
      </PylonWidget>
    </>
  );
}
