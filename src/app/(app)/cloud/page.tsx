import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { CloudNextSessionsPage } from '@/components/cloud-agent-next/CloudNextSessionsPage';

export default async function PersonalCloudPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/cloud');

  return <CloudNextSessionsPage />;
}
