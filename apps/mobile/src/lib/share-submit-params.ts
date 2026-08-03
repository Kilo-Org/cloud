import { type AgentAttachment } from '@/lib/agent-attachments/agent-attachment-types';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type SharePayload } from '@/lib/share-payload';

/**
 * Snapshot the new-session composer as a share payload so a spawned remote
 * session can receive the same text and files through the existing share
 * prefill path. Returns null when there is nothing to carry.
 */
export function buildComposerSharePayload(input: {
  text: string;
  attachments: readonly AgentAttachment[];
}): SharePayload | null {
  const text = input.text.trim();
  const files: AgentAttachmentCandidate[] = input.attachments.map(attachment => ({
    name: attachment.filename,
    uri: attachment.localUri,
    mimeType: attachment.mimeType,
    size: attachment.size,
  }));
  if (text === '' && files.length === 0) {
    return null;
  }
  return { text, files, failedFiles: [] };
}
