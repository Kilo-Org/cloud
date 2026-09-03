import { notFound, redirect } from 'next/navigation';
import { PageContainer } from '@/components/layouts/PageContainer';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@/lib/user/server';
import { OnPremComputeSettings } from './OnPremComputeSettings';
import { VercelComputeTrialGate } from './VercelComputeTrialGate';

export default async function OrganizationComputePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getAuthorizedOrgContext(decodeURIComponent(id), ['owner', 'admin']);
  if (!result.success) {
    if (result.nextResponse.status === 401) redirect(await signInUrlWithCallbackPath());
    notFound();
  }
  const { organization } = result.data;

  return (
    <PageContainer>
      <OnPremComputeSettings key={organization.id} organizationId={organization.id} />
      <VercelComputeTrialGate organizationId={organization.id} />
    </PageContainer>
  );
}
