import { redirect } from 'next/navigation';
import { CloudChatPageWrapper } from './CloudChatPageWrapper';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCloudNextChatPage({ params }: PageProps) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);

  // Auth check - redirect if not authorized
  const { success } = await getAuthorizedOrgContext(organizationId);
  if (!success) {
    redirect('/profile');
  }

  return <CloudChatPageWrapper organizationId={organizationId} />;
}
