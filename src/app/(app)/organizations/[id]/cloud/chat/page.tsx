import { redirect } from 'next/navigation';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { CloudChatPageWrapper } from './CloudChatPageWrapper';
import { CloudChatPageWrapperNext } from './CloudChatPageWrapperNext';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sessionId?: string }>;
};

export default async function OrganizationCloudChatPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);

  const { success } = await getAuthorizedOrgContext(organizationId);
  if (!success) {
    redirect('/profile');
  }

  const { sessionId } = await searchParams;

  if (!sessionId || isNewSession(sessionId)) {
    return <CloudChatPageWrapperNext organizationId={organizationId} />;
  }

  return <CloudChatPageWrapper organizationId={organizationId} />;
}
