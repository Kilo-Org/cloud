import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { LegacySessionViewer } from '@/components/cloud-agent-next/LegacySessionViewer';
import { CloudChatPageWrapperNext } from './CloudChatPageWrapperNext';
import { PrefetchedCloudChat } from '@/components/cloud-agent-next/server/PrefetchedCloudChat';
import { readKnownModels } from '@/components/cloud-agent-next/server/read-known-models';
import { redirectToSessionScope } from '@/components/cloud-agent-next/server/redirect-to-session-scope';

type PageProps = {
  searchParams: Promise<{ sessionId?: string; at?: string }>;
};

export default async function PersonalCloudChatPage({ searchParams }: PageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/cloud/chat');
  const { sessionId, at } = await searchParams;

  if (sessionId && !isNewSession(sessionId)) return <LegacySessionViewer sessionId={sessionId} />;
  if (sessionId) {
    await redirectToSessionScope({
      sessionId,
      userId: user.id,
      organizationId: null,
      anchorMessageId: at ?? null,
    });
  }

  const knownModels = await readKnownModels(user.id);
  const page = <CloudChatPageWrapperNext currentUserId={user.id} knownModels={knownModels} />;
  return sessionId ? (
    <PrefetchedCloudChat sessionId={sessionId} organizationId={null}>
      {page}
    </PrefetchedCloudChat>
  ) : (
    page
  );
}
