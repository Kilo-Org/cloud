import { isMarkdownPath } from './read-tool-markdown';

/** A cloud-agent attachment reference parsed from the wrapper's sandbox URL. */
export type CloudAgentAttachmentRef = { messageUuid: string; filename: string };

// Persisted history and live events carry the wrapper's sandbox URL
// `file:///tmp/attachments/<agentId>/<userId>/<messageUuid>/<filename>`
// (`services/cloud-agent-next/wrapper/src/session-bootstrap.ts`).
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

export type FilePartKind = 'image' | 'markdown' | 'other';

export function isMarkdownFilePart(filename: string | undefined): boolean {
  return isMarkdownPath(filename ?? '');
}

export function getFilePartKind(input: { mime: string; filename?: string }): FilePartKind {
  if (input.mime.startsWith('image/')) {
    return 'image';
  }
  if (isMarkdownFilePart(input.filename)) {
    return 'markdown';
  }
  return 'other';
}

function resolveName(filename: string | undefined): string {
  return filename && filename.trim() !== '' ? filename : 'File';
}

export function getFilePartAccessibilityLabel(kind: FilePartKind, filename?: string): string {
  const name = resolveName(filename);
  if (kind === 'image') {
    return `Open ${name} full screen`;
  }
  if (kind === 'markdown') {
    return `Preview ${name}`;
  }
  return `Open ${name}`;
}
