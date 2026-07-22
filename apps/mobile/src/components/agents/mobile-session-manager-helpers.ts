import { type RemoteAttachmentPart } from 'cloud-agent-sdk';

import { type AgentAttachmentSubmissionPayload } from '@/lib/agent-attachments/agent-attachment-types';
import { mimeForExtension, normalizeAttachmentExtension } from '@/lib/agent-attachments/validate';
import { trpcClient } from '@/lib/trpc';

/**
 * Build the `RemoteAttachmentPart[]` payload for a CAPABLE remote CLI
 * session (the active CLI advertised `capabilities.attachments: true`).
 * For each `file` in the composer's submission payload this mints a
 * presigned GET via `trpcClient.cloudAgentNext.getAttachmentDownloadUrl`
 * and returns the wire part the SDK appends to `send_message.parts`
 * (after the text part).
 *
 * Contract:
 *  - `filename` on the wire is the SERVER-ISSUED `remoteName`
 *    (`<uuid>.<ext>`), NEVER the original picker filename.
 *  - `mime` is derived SOLELY from the `remoteName` extension via the
 *    canonical table in `agent-attachments/validate` — the picker MIME
 *    is not consulted.
 *
 * Sequencing: callers `await` the full array; one failed presign
 * propagates so the composer can surface the failure through the
 * existing send pipeline.
 */
export async function buildRemoteAttachmentParts(
  submission: AgentAttachmentSubmissionPayload
): Promise<RemoteAttachmentPart[]> {
  const parts = await Promise.all(
    submission.files.map(async file => {
      const result = await trpcClient.cloudAgentNext.getAttachmentDownloadUrl.mutate({
        messageUuid: submission.wire.path,
        filename: file.remoteName,
      });
      const mime = mimeForExtension(normalizeAttachmentExtension(file.remoteName));
      return {
        type: 'file',
        mime,
        filename: file.remoteName,
        url: result.signedUrl,
      } satisfies RemoteAttachmentPart;
    })
  );
  return parts;
}
