import { i18n } from '@/i18n';

import { isMarkdownPath } from './read-tool-markdown';

/** A cloud-agent attachment reference parsed from the wrapper's sandbox URL. */
export type CloudAgentAttachmentRef = { messageUuid: string; filename: string };

// Persisted history and live events carry the wrapper's sandbox URL
// `file:///tmp/attachments/<sessionId>/<userId>/<messageUuid>/<filename>`
// (`services/cloud-agent-next/src/utils/attachment-download.ts`).
// Removal condition: none — stored messages keep this form permanently.
const CLOUD_AGENT_ATTACHMENT_URL =
  /^file:\/\/\/tmp\/attachments\/[^/]+\/[^/]+\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/([^/]+)$/;

export function parseCloudAgentAttachmentUrl(url: string): CloudAgentAttachmentRef | undefined {
  const match = CLOUD_AGENT_ATTACHMENT_URL.exec(url);
  if (!match) {
    return undefined;
  }
  const messageUuid = match[1];
  const filename = match[2];
  if (messageUuid === undefined || filename === undefined) {
    return undefined;
  }
  return { messageUuid, filename };
}

export type FilePartKind = 'image' | 'video' | 'markdown' | 'other';

export function isMarkdownFilePart(filename: string | undefined): boolean {
  return isMarkdownPath(filename ?? '');
}

export function getFilePartKind(input: { mime: string; filename?: string }): FilePartKind {
  if (input.mime.startsWith('image/')) {
    return 'image';
  }
  if (input.mime.startsWith('video/')) {
    return 'video';
  }
  if (isMarkdownFilePart(input.filename)) {
    return 'markdown';
  }
  return 'other';
}

function resolveName(filename: string | undefined): string {
  // i18n-dup-ok: prReview.overview.file_* is a numeral count unit ('1 file'), which
  // languages inflect by number; this key is the standalone noun label.
  return filename && filename.trim() !== '' ? filename : i18n.t('common.file');
}

export function getFilePartAccessibilityLabel(kind: FilePartKind, filename?: string): string {
  const name = resolveName(filename);
  if (kind === 'image') {
    return i18n.t('agentChat.filePart.openFullScreen', { name });
  }
  if (kind === 'markdown') {
    return i18n.t('agentChat.filePart.preview', { name });
  }
  // 'video' lands here: the player's own fullscreen control is what "Open"
  // names, and the app has no video-specific copy to add.
  return i18n.t('common.open', { name });
}
