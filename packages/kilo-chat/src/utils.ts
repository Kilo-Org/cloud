import { decodeTime } from 'ulid';

/** Extract the millisecond timestamp encoded in a ULID. */
export function ulidToTimestamp(ulid: string): number {
  return decodeTime(ulid);
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
export type ConversationCursor = { t: number; c: string };

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
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
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      't' in parsed &&
      'c' in parsed &&
      typeof (parsed as { t: unknown }).t === 'number' &&
      typeof (parsed as { c: unknown }).c === 'string'
    ) {
      const { t, c } = parsed as { t: number; c: string };
      return { t, c };
    }
    return null;
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
