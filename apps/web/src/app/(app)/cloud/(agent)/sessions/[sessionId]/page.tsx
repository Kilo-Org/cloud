import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { LegacySessionViewer } from '@/components/cloud-agent-next/LegacySessionViewer';
import { SessionResumeGate } from './SessionResumeGate';

type PageProps = {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ at?: string }>;
};

/**
 * Universal session link target. Lives in the `(agent)` group so it inherits
 * the Cloud Agent provider and sidebar while keeping the `/cloud/sessions/<id>`
 * URL the link already carries. Legacy transcripts have no portable position,
 * so they keep the existing viewer unchanged.
 */
export default async function SessionResumePage({ params, searchParams }: PageProps) {
  const { sessionId } = await params;
  await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/cloud/sessions/${encodeURIComponent(sessionId)}`
  );

  if (!isNewSession(sessionId)) {
    return <LegacySessionViewer sessionId={sessionId} />;
  }

  const { at } = await searchParams;
  return <SessionResumeGate sessionId={sessionId} anchorMessageId={at ?? null} />;
}
