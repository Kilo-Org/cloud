import {
  AGENT_ATTACHMENT_DENIED_EXTENSIONS,
  AGENT_ATTACHMENT_EXTENSION_REGEX,
  AGENT_ATTACHMENT_FALLBACK_EXTENSION,
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_ATTACHMENT_MAX_FILES,
  AGENT_ATTACHMENT_MIME_BY_EXTENSION,
  type AgentAttachmentExtension,
  type AgentAttachmentMime,
} from './constants';

const IMAGE_EXTENSIONS = new Set<AgentAttachmentExtension>(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/**
 * Normalize a candidate's filename extension.
 *
 * - Lower-cased, dot-stripped.
 * - Falls back to {@link AGENT_ATTACHMENT_FALLBACK_EXTENSION} when the
 *   filename has no extension or the extension does not match
 *   {@link AGENT_ATTACHMENT_EXTENSION_REGEX}.
 * - Never throws; the result is always a known key in
 *   {@link AGENT_ATTACHMENT_MIME_BY_EXTENSION}.
 */
export function normalizeAttachmentExtension(name: string): AgentAttachmentExtension {
  const dot = name.lastIndexOf('.');
  if (dot === -1 || dot === name.length - 1) {
    return AGENT_ATTACHMENT_FALLBACK_EXTENSION;
  }
  const raw = name.slice(dot + 1).toLowerCase();
  return AGENT_ATTACHMENT_EXTENSION_REGEX.test(raw)
    ? (raw as AgentAttachmentExtension)
    : AGENT_ATTACHMENT_FALLBACK_EXTENSION;
}

/**
 * Resolve the canonical MIME for a normalized extension. The picker MIME
 * is intentionally NOT consulted: OS pickers report generic types like
 * `application/octet-stream` for anything the platform doesn't recognize,
 * and the cloud-agent storage layer rejects anything outside the
 * allow-list. The extension is the single source of truth.
 *
 * When the extension is not in {@link AGENT_ATTACHMENT_MIME_BY_EXTENSION}
 * the lookup falls back to `application/octet-stream` so the picker
 * contract is total and never leaks `undefined` into the upload path.
 */
export function mimeForExtension(extension: string): AgentAttachmentMime {
  // Index via a string map so missing keys are `undefined` at the type
  // level (the const table alone would make `??` look unnecessary).
  const mimeByExtension: Readonly<Record<string, AgentAttachmentMime | undefined>> =
    AGENT_ATTACHMENT_MIME_BY_EXTENSION;
  return mimeByExtension[extension] ?? 'application/octet-stream';
}

type ClassifiedAttachment =
  | { ok: true; kind: 'image' | 'document'; extension: AgentAttachmentExtension; size: number }
  | {
      ok: false;
      reason: 'denied' | 'empty' | 'too-large';
    };

type AttachmentCandidate = { name: string; size: number };

/**
 * Classify a candidate attachment for the cloud-agent composer.
 *
 * The picker `mimeType` is intentionally ignored: the extension is the
 * single source of truth for both the deny list and the MIME we send to
 * the server. `size` is the **measured** local byte size (see
 * `getInfoAsync` in `use-agent-attachment-upload`); the picker-reported
 * size is unreliable on iOS and must not be trusted.
 */
export function classifyAttachment(candidate: AttachmentCandidate): ClassifiedAttachment {
  if (candidate.size <= 0) {
    return { ok: false, reason: 'empty' };
  }
  const extension = normalizeAttachmentExtension(candidate.name);
  if (AGENT_ATTACHMENT_DENIED_EXTENSIONS.has(extension)) {
    return { ok: false, reason: 'denied' };
  }
  if (candidate.size > AGENT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  return {
    ok: true,
    kind: IMAGE_EXTENSIONS.has(extension) ? 'image' : 'document',
    extension,
    size: candidate.size,
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

const CLASSIFICATION_FAILURE_MESSAGES = {
  denied: "Executable files can't be attached",
  empty: 'File is empty',
  'too-large': 'Files must be 5 MB or smaller',
} as const satisfies Record<'denied' | 'empty' | 'too-large', string>;

/**
 * Human-readable copy for a single classification outcome. Centralized so
 * the picker, the upload hook, and the chip surface use the same strings.
 */
export function describeClassificationFailure(reason: 'denied' | 'empty' | 'too-large'): string {
  return CLASSIFICATION_FAILURE_MESSAGES[reason];
}
