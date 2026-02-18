import { redirect } from 'next/navigation';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { CloudChatPageWrapper } from './CloudChatPageWrapper';
import { CloudChatPageWrapperNext } from './CloudChatPageWrapperNext';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@/lib/user.server';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sessionId?: string }>;
};

export default async function OrganizationCloudChatPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);

  const result = await getAuthorizedOrgContext(organizationId);
  if (!result.success) {
    if (result.nextResponse.status === 401) {
      redirect(await signInUrlWithCallbackPath());
    }
    redirect('/profile');
  }

  const { sessionId } = await searchParams;

  if (!sessionId || isNewSession(sessionId)) {
    return <CloudChatPageWrapperNext organizationId={organizationId} />;
  }

  return <CloudChatPageWrapper organizationId={organizationId} />;
}
