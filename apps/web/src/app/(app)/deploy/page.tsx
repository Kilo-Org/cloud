import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { DeployPageClient } from './DeployPageClient';
import { notFound } from 'next/navigation';
import { ENABLE_DEPLOY_FEATURE } from '@/lib/constants';

export default async function DeployPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/deploy');

  if (!ENABLE_DEPLOY_FEATURE) {
    return notFound();
  }

  return <DeployPageClient />;
}
