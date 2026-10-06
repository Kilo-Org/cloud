import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { NewSessionPanel } from '@/components/cloud-agent-next/NewSessionPanel';

export default async function PersonalCloudPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/cloud');
  return <NewSessionPanel currentUserId={user.id} />;
}
