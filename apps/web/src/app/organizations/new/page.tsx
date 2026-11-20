import { Suspense } from 'react';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { CreateOrganizationPage } from '@/components/organizations/new/CreateOrganizationPage';
import { hasFirstOrganizationTrialOffer } from '@/lib/organization-trial-offer';

export default async function Page() {
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(`/organizations/new`)}`
  );
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CreateOrganizationPage
        showFirstOrganizationTrialOffer={hasFirstOrganizationTrialOffer(user)}
      />
    </Suspense>
  );
}
