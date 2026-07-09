export const AGENT_ATTACHMENT_MAX_FILES = 5;
export const AGENT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export const AGENT_ATTACHMENT_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'pdf',
  'txt',
  'md',
  'csv',
] as const;

export type AgentAttachmentExtension = (typeof AGENT_ATTACHMENT_EXTENSIONS)[number];

export const AGENT_ATTACHMENT_MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
} as const satisfies Record<AgentAttachmentExtension, string>;
