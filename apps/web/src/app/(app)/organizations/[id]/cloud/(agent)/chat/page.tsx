import { redirect } from 'next/navigation';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { LegacySessionViewer } from '@/components/cloud-agent-next/LegacySessionViewer';
import { CloudChatPageWrapperNext } from './CloudChatPageWrapperNext';
import { PrefetchedCloudChat } from '@/components/cloud-agent-next/server/PrefetchedCloudChat';
import { readKnownModels } from '@/components/cloud-agent-next/server/read-known-models';
import { redirectToSessionScope } from '@/components/cloud-agent-next/server/redirect-to-session-scope';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@kilocode/web-shared/lib/user/server';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sessionId?: string; at?: string }>;
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

  const { sessionId, at } = await searchParams;

  if (!sessionId || isNewSession(sessionId)) {
    if (sessionId) {
      await redirectToSessionScope({
        sessionId,
        userId: result.data.user.id,
        organizationId,
        anchorMessageId: at ?? null,
      });
    }
    const knownModels = await readKnownModels(result.data.user.id);
    const page = (
      <CloudChatPageWrapperNext
        organizationId={organizationId}
        organizationName={result.data.organization.name}
        organizationRole={result.data.user.role}
        currentUserId={result.data.user.id}
        knownModels={knownModels}
      />
    );
    return sessionId ? (
      <PrefetchedCloudChat sessionId={sessionId} organizationId={organizationId}>
        {page}
      </PrefetchedCloudChat>
    ) : (
      page
    );
  }

  return <LegacySessionViewer sessionId={sessionId} organizationId={organizationId} />;
}
