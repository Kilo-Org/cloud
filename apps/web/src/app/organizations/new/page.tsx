import { Suspense } from 'react';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { CreateOrganizationPage } from '@/components/organizations/new/CreateOrganizationPage';
import { userHasOrganizationTrialEligibility } from '@kilocode/web-shared/lib/organizations/organization-creation-limit';

export default async function Page() {
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(`/organizations/new`)}`
  );
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CreateOrganizationPage
        showFirstOrganizationTrialOffer={userHasOrganizationTrialEligibility(user)}
      />
    </Suspense>
  );
}
