import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { CloudNextSessionsPage } from '@/components/cloud-agent-next/CloudNextSessionsPage';

export default async function PersonalCloudNextPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/cloud-next');

  return <CloudNextSessionsPage />;
}
