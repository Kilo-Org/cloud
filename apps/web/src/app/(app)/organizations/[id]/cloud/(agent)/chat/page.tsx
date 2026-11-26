import { redirect } from 'next/navigation';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { LegacySessionViewer } from '@/components/cloud-agent-next/LegacySessionViewer';
import { CloudChatPageWrapperNext } from './CloudChatPageWrapperNext';
import { PrefetchedCloudChat } from '@/components/cloud-agent-next/server/PrefetchedCloudChat';
import { readKnownModels } from '@/components/cloud-agent-next/server/read-known-models';
import { redirectToSessionScope } from '@/components/cloud-agent-next/server/redirect-to-session-scope';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@kilocode/web-shared/lib/user/server';
import { AdminStepUpGate } from '@/lib/admin/require-admin-page';
import { AdminAccessDenied } from '@/app/admin/components/AdminAccessDenied';
import { adminNetworkRefusalFor } from '@kilocode/web-shared/lib/admin/admin-network';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sessionId?: string; at?: string }>;
};

export default async function OrganizationCloudChatPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);

  const result = await getAuthorizedOrgContext(organizationId, undefined, {
    surface: 'server-component',
  });
  if (!result.success) {
    if (result.nextResponse.status === 401) {
      redirect(await signInUrlWithCallbackPath());
    }
    // Staff without a membership who still need a passkey step-up verify here,
    // so the current URL survives verification.
    if (result.stepUp) {
      return <AdminStepUpGate requirement={result.stepUp} />;
    }
    // Staff off the admin network get the admin refusal, not a generic redirect.
    if (result.adminNetworkDenial) {
      return (
        <AdminAccessDenied message={adminNetworkRefusalFor(result.adminNetworkDenial).message} />
      );
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
