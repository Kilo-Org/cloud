import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { sessionResumeSignInPath } from '@/lib/cloud-agent/session-resume-target';
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
  // Read the anchor before the auth redirect so a signed-out visitor keeps the
  // position across sign-in and does not land on the session top.
  const { at } = await searchParams;
  await getUserFromAuthOrRedirect(sessionResumeSignInPath(sessionId, at ?? null));

  if (!isNewSession(sessionId)) {
    return <LegacySessionViewer sessionId={sessionId} />;
  }

  return <SessionResumeGate sessionId={sessionId} anchorMessageId={at ?? null} />;
}
