import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { LegacySessionViewer } from '@/components/cloud-agent-next/LegacySessionViewer';
import { CloudChatPageWrapperNext } from './CloudChatPageWrapperNext';

type PageProps = {
  searchParams: Promise<{ sessionId?: string }>;
};

export default async function PersonalCloudChatPage({ searchParams }: PageProps) {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/cloud/chat');
  const { sessionId } = await searchParams;

  if (!sessionId || isNewSession(sessionId)) {
    return <CloudChatPageWrapperNext />;
  }

  return <LegacySessionViewer sessionId={sessionId} />;
}
