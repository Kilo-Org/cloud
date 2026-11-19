import {
  PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES,
  isPreviewTunnelWebSocketId,
  type PreviewTunnelFrame,
} from '../shared/preview-tunnel-protocol.js';

/**
 * Socket tags and attachments of the `PreviewTunnel` Durable Object. They are
 * the only state that survives hibernation: the tunnel socket has the tag
 * `tunnel`, and a browser socket has `browser` and `ws:<stream id>`. Both keep
 * the sequence number of their tunnel in the attachment.
 */
export const TUNNEL_TAG = 'tunnel';
export const BROWSER_TAG = 'browser';
const STREAM_TAG_PREFIX = 'ws:';

export function streamTag(id: number): string {
  return `${STREAM_TAG_PREFIX}${id}`;
}

export function browserStreamId(tags: readonly string[]): number | null {
  const tag = tags.find(candidate => candidate.startsWith(STREAM_TAG_PREFIX));
  if (tag === undefined) return null;
  const id = Number(tag.slice(STREAM_TAG_PREFIX.length));
  return Number.isInteger(id) && isPreviewTunnelWebSocketId(id) ? id : null;
}

export function writeTunnelSeq(socket: WebSocket, tunnelSeq: number): void {
  socket.serializeAttachment({ tunnelSeq });
}

export function readTunnelSeq(socket: WebSocket): number | null {
  const attachment: unknown = socket.deserializeAttachment();
  if (typeof attachment !== 'object' || attachment === null) return null;
  const seq = (attachment as { tunnelSeq?: unknown }).tunnelSeq;
  return typeof seq === 'number' && Number.isInteger(seq) ? seq : null;
}

function textOverBound(text: string): boolean {
  // Each UTF-16 unit is at most 3 UTF-8 bytes, so a short text needs no encode.
  if (text.length * 3 <= PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES;
}

/** The tunnel frame for one browser message, or null when it is over the message bound. */
export function browserMessageFrame(
  stream: number,
  message: string | ArrayBuffer
): PreviewTunnelFrame | null {
  if (typeof message === 'string') {
    return textOverBound(message) ? null : { type: 'ws_text', stream, text: message };
  }
  return message.byteLength > PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES
    ? null
    : { type: 'ws_binary', stream, bytes: new Uint8Array(message) };
}

export function offeredProtocols(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(',')
    .map(protocol => protocol.trim())
    .filter(protocol => protocol.length > 0);
}
