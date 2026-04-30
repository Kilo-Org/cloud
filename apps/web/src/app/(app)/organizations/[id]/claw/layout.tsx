import { PylonSupportButton } from '@/components/pylon-support-button';
import { PylonWidget } from '@/components/pylon-widget';
import { OrgInstancePresenceMount } from './components/OrgInstancePresenceMount';
import '@/app/(app)/claw/claw-chat.css';

export default function OrgClawLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <OrgInstancePresenceMount />
      {children}
      <PylonWidget>
        <PylonSupportButton />
      </PylonWidget>
    </>
  );
}
