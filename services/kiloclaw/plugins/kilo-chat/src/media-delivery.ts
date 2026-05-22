import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from 'openclaw/plugin-sdk/outbound-media';
import { basename, isAbsolute, resolve } from 'node:path';
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

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
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

function mediaAccessForChannelRead(
  mediaAccess: OutboundMediaLoadOptions['mediaAccess'] | undefined
): OutboundMediaLoadOptions['mediaAccess'] | undefined {
  if (!mediaAccess) return undefined;
  return {
    ...(mediaAccess.localRoots ? { localRoots: mediaAccess.localRoots } : {}),
    ...(mediaAccess.workspaceDir ? { workspaceDir: mediaAccess.workspaceDir } : {}),
  };
}

function resolveFilename(contentType: string | undefined, suggested: string | undefined): string {
  if (suggested && suggested.length > 0) return suggested;
  if (contentType && DEFAULT_FILENAME_BY_MIME[contentType]) {
    return DEFAULT_FILENAME_BY_MIME[contentType];
  }
  return 'file.bin';
}

function resolveLocalMediaPath(mediaUrl: string, context: OutboundMediaLoadContext): string {
  const workspaceDir = context.mediaAccess?.workspaceDir;
  if (workspaceDir && !isAbsolute(mediaUrl)) return resolve(workspaceDir, mediaUrl);
  return mediaUrl;
}

function inferMimeFromFilename(fileName: string | undefined): string | undefined {
  const extension = fileName?.split('.').pop()?.toLowerCase();
  return extension ? MIME_BY_EXTENSION[extension] : undefined;
}

export async function loadOutboundMedia(
  mediaUrl: string,
  context: OutboundMediaLoadContext = {}
): Promise<LoadedOutboundMedia> {
  const readFile = context.mediaReadFile ?? context.mediaAccess?.readFile;
  if (readFile && !isHttpUrl(mediaUrl)) {
    const filePath = resolveLocalMediaPath(mediaUrl, context);
    const buffer = await readFile(filePath);
    const fileName = basename(filePath) || undefined;
    return {
      buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      contentType: inferMimeFromFilename(fileName),
      fileName,
    };
  }

  const channelMediaAccess = mediaAccessForChannelRead(context.mediaAccess);
  const loaded = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: ATTACHMENT_MAX_BYTES,
    mediaAccess: channelMediaAccess,
    mediaLocalRoots: context.mediaLocalRoots ?? channelMediaAccess?.localRoots,
  });
  return {
    buffer: Buffer.isBuffer(loaded.buffer) ? loaded.buffer : Buffer.from(loaded.buffer),
    contentType: loaded.contentType,
    fileName: loaded.fileName,
  };
}

export async function sendKiloChatLoadedMediaMessage(params: {
  client: Pick<KiloChatClient, 'createMessage' | 'initAttachment'>;
  conversationId: string;
  media: LoadedOutboundMedia;
  caption?: string;
  inReplyToMessageId?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ messageId: string }> {
  const caption = params.caption ?? '';
  const mimeType = params.media.contentType ?? 'application/octet-stream';
  const filename = resolveFilename(params.media.contentType, params.media.fileName);
  const size = params.media.buffer.length;

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
    body: params.media.buffer,
  });
  if (!putResponse.ok) {
    throw new Error(
      `kilo-chat: R2 PUT responded ${putResponse.status}: ${await putResponse.text().catch(() => '')}`
    );
  }
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
  return sendKiloChatLoadedMediaMessage({
    client: params.client,
    conversationId: params.conversationId,
    media,
    caption,
    inReplyToMessageId: params.inReplyToMessageId,
    fetchImpl: params.fetchImpl,
  });
}
