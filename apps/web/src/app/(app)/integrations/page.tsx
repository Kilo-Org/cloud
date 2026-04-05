import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { IntegrationsPageClient } from './IntegrationsPageClient';

export default async function UserIntegrationsPage() {
  await getUserFromAuthOrRedirect('/users/sign_in');
  return <IntegrationsPageClient />;
}
