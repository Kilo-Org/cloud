import { OrgInstancePresenceMount } from './components/OrgInstancePresenceMount';

export default function OrgClawLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <OrgInstancePresenceMount />
      {children}
    </>
  );
}
