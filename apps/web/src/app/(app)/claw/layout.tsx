import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { PylonWidget } from '@/components/pylon-widget';
import './claw-chat.css';

export default async function ClawLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return (
    <>
      {children}
      <PylonWidget />
    </>
  );
}
