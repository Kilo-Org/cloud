import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from 'openclaw/plugin-sdk/outbound-media';
import type { ContentBlock, KiloChatClient } from './client.js';
import { ATTACHMENT_MAX_BYTES } from './synced/schemas.js';

// Filename fallbacks when the SDK's media loader does not produce one (e.g.
// the source URL had no path or extension). Keep this conservative — kilo-chat
// stores the filename in the attachment row and surfaces it as Content-Disposition.
const DEFAULT_FILENAME_BY_MIME: Record<string, string> = {
  'image/png': 'image.png',
  'image/jpeg': 'image.jpg',
  'image/gif': 'image.gif',
  'image/webp': 'image.webp',
  'image/heic': 'image.heic',
  'image/heif': 'image.heif',
  'video/mp4': 'video.mp4',
  'video/quicktime': 'video.mov',
  'audio/mpeg': 'audio.mp3',
  'audio/mp4': 'audio.m4a',
  'audio/ogg': 'audio.ogg',
  'audio/wav': 'audio.wav',
  'application/pdf': 'document.pdf',
};

export type LoadedOutboundMedia = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

export type OutboundMediaLoadContext = Pick<
  OutboundMediaLoadOptions,
  'mediaAccess' | 'mediaLocalRoots' | 'mediaReadFile'
>;

export type MediaLoader = (
  mediaUrl: string,
  context?: OutboundMediaLoadContext
) => Promise<LoadedOutboundMedia>;

export function isHttpUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveFilename(contentType: string | undefined, suggested: string | undefined): string {
  if (suggested && suggested.length > 0) return suggested;
  if (contentType && DEFAULT_FILENAME_BY_MIME[contentType]) {
    return DEFAULT_FILENAME_BY_MIME[contentType];
  }
  return 'file.bin';
}

export async function loadOutboundMedia(
  mediaUrl: string,
  context: OutboundMediaLoadContext = {}
): Promise<LoadedOutboundMedia> {
  const loaded = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: ATTACHMENT_MAX_BYTES,
    mediaAccess: context.mediaAccess,
    mediaLocalRoots: context.mediaLocalRoots,
    mediaReadFile: context.mediaReadFile,
  });
  return {
    buffer: Buffer.isBuffer(loaded.buffer) ? loaded.buffer : Buffer.from(loaded.buffer),
    contentType: loaded.contentType,
    fileName: loaded.fileName,
  };
}

export async function sendKiloChatMediaMessage(params: {
  client: Pick<KiloChatClient, 'createMessage' | 'initAttachment'>;
  conversationId: string;
  mediaUrl: string;
  caption?: string;
  inReplyToMessageId?: string;
  mediaAccess?: OutboundMediaLoadOptions['mediaAccess'];
  mediaLocalRoots?: OutboundMediaLoadOptions['mediaLocalRoots'];
  mediaReadFile?: OutboundMediaLoadOptions['mediaReadFile'];
  fetchImpl?: typeof fetch;
  loadMediaImpl?: MediaLoader;
}): Promise<{ messageId: string }> {
  const caption = params.caption ?? '';
  const mediaUrl = params.mediaUrl;
  if (isHttpUrl(mediaUrl)) {
    const content: ContentBlock[] = [];
    if (caption.length > 0) {
      content.push({ type: 'text', text: caption });
    }
    content.push({ type: 'text', text: mediaUrl.trim() });
    return await params.client.createMessage({
      conversationId: params.conversationId,
      content,
      inReplyToMessageId: params.inReplyToMessageId,
    });
  }

  const loader = params.loadMediaImpl ?? loadOutboundMedia;
  const media = await loader(mediaUrl, {
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });
  const mimeType = media.contentType ?? 'application/octet-stream';
  const filename = resolveFilename(media.contentType, media.fileName);
  const size = media.buffer.length;

  const init = await params.client.initAttachment({
    conversationId: params.conversationId,
    mimeType,
    size,
    filename,
  });

  const putFetch = params.fetchImpl ?? fetch;
  const putResponse = await putFetch(init.putUrl, {
    method: 'PUT',
    headers: init.putHeaders,
    body: media.buffer,
  });
  if (!putResponse.ok) {
    throw new Error(
      `kilo-chat: R2 PUT responded ${putResponse.status}: ${await putResponse.text().catch(() => '')}`
    );
  }
  // R2 returns an empty body on PUT — drain it just in case to avoid
  // hanging the keep-alive connection.
  void putResponse.body?.cancel();

  const content: ContentBlock[] = [
    {
      type: 'attachment',
      attachmentId: init.attachmentId,
      mimeType,
      size,
      filename,
    },
  ];
  if (caption.length > 0) {
    content.push({ type: 'text', text: caption });
  }

  return await params.client.createMessage({
    conversationId: params.conversationId,
    content,
    inReplyToMessageId: params.inReplyToMessageId,
  });
}
