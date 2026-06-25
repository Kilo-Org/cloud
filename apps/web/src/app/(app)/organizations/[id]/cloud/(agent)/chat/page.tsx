import { isNewSession } from '@/lib/cloud-agent/session-type';
import { LegacySessionViewer } from '@/components/cloud-agent-next/LegacySessionViewer';
import { CloudChatPageWrapperNext } from './CloudChatPageWrapperNext';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sessionId?: string }>;
};

export default async function OrganizationCloudChatPage({ params, searchParams }: PageProps) {
  const { organization, canonicalRouteIdentifier } =
    await requireCanonicalOrganizationRouteContext(params);
  const { sessionId } = await searchParams;

  if (!sessionId || isNewSession(sessionId)) {
    return <CloudChatPageWrapperNext organizationId={organization.id} />;
  }

  return <LegacySessionViewer sessionId={sessionId} organizationId={canonicalRouteIdentifier} />;
}
