import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { WastelandListPageClient } from './WastelandListPageClient';

export default async function WastelandPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/wasteland');

  return <WastelandListPageClient />;
}
