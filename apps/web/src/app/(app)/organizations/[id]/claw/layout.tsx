import { PylonSupportButton } from '@/components/pylon-support-button';
import { PylonWidget } from '@/components/pylon-widget';
import '@/app/(app)/claw/claw-chat.css';

export default function OrgClawLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <PylonWidget>
        <PylonSupportButton />
      </PylonWidget>
    </>
  );
}
