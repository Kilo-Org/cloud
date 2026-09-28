import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { appendShareParams } from '@/lib/share-navigation';
import { putSharePayload } from '@/lib/share-payload';

/**
 * Stage a picture picked from the picture entry point and return the
 * new-session href that delivers it.
 *
 * Returns `null` when there is nothing to stage (cancel, denied permission, or
 * a failed launch): the caller stays where it is, so no half-made agent opens.
 *
 * Delivery is the existing share path — the returned href carries a `shareId`
 * route param, `useSharePrefill` takes the staged payload, and the composer's
 * `addCandidates` owns the files from there. There is no second delivery path.
 */
export function stagePictureForNewSession({
  candidates,
  organizationId,
}: {
  candidates: AgentAttachmentCandidate[];
  organizationId: string | null;
}): string | null {
  if (candidates.length === 0) {
    return null;
  }
  const shareId = putSharePayload({ text: '', files: candidates, failedFiles: [] });
  return appendShareParams(getNewAgentSessionPath(organizationId), shareId);
}
