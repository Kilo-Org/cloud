import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { PersonalInstancePresenceMount } from './components/PersonalInstancePresenceMount';

export default async function ClawLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return (
    <>
      <PersonalInstancePresenceMount />
      {children}
    </>
  );
}
