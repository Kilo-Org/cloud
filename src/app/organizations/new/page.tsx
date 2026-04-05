import { Suspense } from 'react';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { CreateOrganizationPage } from '@/components/organizations/new/CreateOrganizationPage';

export default async function Page() {
  await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(`/organizations/new`)}`
  );
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CreateOrganizationPage />
    </Suspense>
  );
}
