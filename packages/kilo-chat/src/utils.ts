import { decodeTime } from 'ulid';
import type { z } from 'zod';

import { conversationCursorSchema } from './schemas';
import type { AttachmentBlock, InputContentBlock, ReplyToMessageSnapshot } from './types';

const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** Extract the millisecond timestamp encoded in a ULID. */
export function ulidToTimestamp(ulid: string): number {
  return decodeTime(ulid);
}

export function formatFileSize(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${FILE_SIZE_UNITS[unitIndex]}`;
  }

  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${FILE_SIZE_UNITS[unitIndex]}`;
}

export function remainingEditableAttachments(
  originalAttachments: readonly AttachmentBlock[],
  removedAttachmentIds: Iterable<string>
): AttachmentBlock[] {
  const removedAttachmentIdSet = new Set(removedAttachmentIds);
  return originalAttachments.filter(
    attachment => !removedAttachmentIdSet.has(attachment.attachmentId)
  );
}

export function buildMessageEditContent({
  text,
  originalAttachments,
  removedAttachmentIds,
}: {
  text: string;
  originalAttachments: readonly AttachmentBlock[];
  removedAttachmentIds: Iterable<string>;
}): InputContentBlock[] {
  const trimmedText = text.trim();
  const textBlocks: InputContentBlock[] =
    trimmedText.length > 0 ? [{ type: 'text', text: trimmedText }] : [];
  return [
    ...textBlocks,
    ...remainingEditableAttachments(originalAttachments, removedAttachmentIds),
  ];
}

/**
 * Opaque cursor for conversation list pagination. Encodes the sort key and
 * tie-breaker of the last row on the current page so the server can resume
 * with a strict WHERE comparison instead of an OFFSET.
 *
 * The `t` value is the sort key used by MembershipDO.listConversations:
 * `coalesce(last_activity_at, joined_at)`. `c` is the conversation_id
 * (ULID) tie-breaker.
 */
export type ConversationCursor = z.infer<typeof conversationCursorSchema>;

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeConversationCursor(cursor: ConversationCursor): string {
  const json = JSON.stringify(cursor);
  return base64urlEncode(new TextEncoder().encode(json));
}

export function decodeConversationCursor(encoded: string): ConversationCursor | null {
  try {
    const json = new TextDecoder().decode(base64urlDecode(encoded));
    const parsed: unknown = JSON.parse(json);
    const cursor = conversationCursorSchema.safeParse(parsed);
    return cursor.success ? cursor.data : null;
  } catch {
    return null;
  }
}

/**
 * Extract plain text from an array of content blocks.
 *
 * Concatenates adjacent text blocks without a separator. Long replies are
 * split across multiple text blocks at arbitrary UTF-16 boundaries by the
 * producer (see services/kiloclaw/plugins/kilo-chat/src/preview-stream.ts),
 * so any separator here would inject stray characters into the reconstructed
 * message text.
 */
export function contentBlocksToText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

type PreviewBlock = { type: string; text?: string; filename?: string; mimeType?: string };

/**
 * Structured label for one attachment in a preview: its filename when present,
 * or a stable fallback code for a nameless attachment. Mobile maps the
 * `image`/`attachment` codes to catalog keys; web keeps the English strings
 * `contentBlocksPreviewText` returns.
 */
export type AttachmentPreviewLabel =
  | { kind: 'filename'; filename: string }
  | { kind: 'image' }
  | { kind: 'attachment' };

export function contentBlocksAttachmentPreviewLabels(
  content: Array<PreviewBlock>
): AttachmentPreviewLabel[] {
  return content
    .filter(
      (b): b is { type: 'attachment'; filename?: string; mimeType?: string } =>
        b.type === 'attachment'
    )
    .map(a =>
      a.filename
        ? { kind: 'filename', filename: a.filename }
        : { kind: a.mimeType?.startsWith('image/') ? 'image' : 'attachment' }
    );
}

/**
 * Short, human-readable single-line preview of a message's content blocks.
 * Falls back to attachment filenames (or a mime-typed descriptor) when no
 * text is present, so attachment-only messages don't render as empty strings
 * in reply previews, conversation list previews, etc.
 */
export function contentBlocksPreviewText(content: Array<PreviewBlock>): string {
  const text = contentBlocksToText(content).trim();
  if (text) return text;
  const labels = contentBlocksAttachmentPreviewLabels(content);
  if (labels.length === 0) return '';
  return labels
    .map(label => {
      switch (label.kind) {
        case 'filename':
          return label.filename;
        case 'image':
          return 'Image';
        case 'attachment':
          return 'Attachment';
      }
    })
    .join(', ');
}

const REPLY_PREVIEW_MAX_CHARS = 160;

type ReplySnapshotParent = {
  senderId: string;
  deleted: boolean;
  content: Array<PreviewBlock>;
};

export function buildReplyToMessageSnapshot(
  messageId: string,
  parent: ReplySnapshotParent | null | undefined
): ReplyToMessageSnapshot {
  if (!parent) {
    return { messageId, senderId: null, deleted: true, previewText: null };
  }

  if (parent.deleted) {
    return { messageId, senderId: parent.senderId, deleted: true, previewText: null };
  }

  const preview = contentBlocksPreviewText(parent.content);
  return {
    messageId,
    senderId: parent.senderId,
    deleted: false,
    previewText: (preview || 'Message').slice(0, REPLY_PREVIEW_MAX_CHARS),
  };
}
