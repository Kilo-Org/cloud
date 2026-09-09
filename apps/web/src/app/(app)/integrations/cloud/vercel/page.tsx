import { PageContainer } from '@/components/layouts/PageContainer';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { VercelComputeSettings } from '@/components/integrations/cloud/VercelComputeSettings';

export default async function PersonalVercelComputePage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/integrations/cloud/vercel');

  return (
    <PageContainer>
      <VercelComputeSettings />
    </PageContainer>
  );
}
