import {
  AGENT_ATTACHMENT_EXTENSIONS,
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_ATTACHMENT_MAX_FILES,
  type AgentAttachmentExtension,
} from './constants';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

type ClassifiedAttachment =
  | { ok: true; kind: 'image' | 'document'; extension: AgentAttachmentExtension }
  | { ok: false; reason: 'unsupported' | 'too-large' };

type Candidate = { name: string; mimeType?: string; size?: number };

export function classifyAttachment(candidate: Candidate): ClassifiedAttachment {
  const ext = candidate.name.split('.').pop()?.toLowerCase();
  if (!ext || !(AGENT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (typeof candidate.size === 'number' && candidate.size > AGENT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  return {
    ok: true,
    kind: IMAGE_EXTENSIONS.has(ext) ? 'image' : 'document',
    extension: ext as AgentAttachmentExtension,
  };
}

export function canAddAttachments(
  currentCount: number,
  incomingCount: number
): { ok: boolean; acceptedCount: number; truncated?: boolean } {
  const remaining = AGENT_ATTACHMENT_MAX_FILES - currentCount;
  if (remaining <= 0) {
    return { ok: false, acceptedCount: 0 };
  }
  if (incomingCount <= remaining) {
    return { ok: true, acceptedCount: incomingCount };
  }
  return { ok: true, acceptedCount: remaining, truncated: true };
}
