import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { KiloPassAwardingCreditsClient } from './KiloPassAwardingCreditsClient';

export default async function KiloPassAwardingCreditsPage() {
  await getUserFromAuthOrRedirect();

  return <KiloPassAwardingCreditsClient />;
}
