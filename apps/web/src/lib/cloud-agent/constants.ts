/**
 * Image upload constraints for Cloud Agent messages
 */
export const CLOUD_AGENT_IMAGE_ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type CloudAgentImageAllowedType = (typeof CLOUD_AGENT_IMAGE_ALLOWED_TYPES)[number];

export const CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION: Record<CloudAgentImageAllowedType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const CLOUD_AGENT_IMAGE_MAX_COUNT = 5;
export const CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const CLOUD_AGENT_IMAGE_MAX_DIMENSION_PX = 1536;

export const CLOUD_AGENT_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 min

/**
 * File upload constraints for Cloud Agent prompts. Kept separate from the
 * image-only contract used by App Builder and older Cloud Agent upload flows.
 */
export const CLOUD_AGENT_ATTACHMENT_ALLOWED_TYPES = [
  ...CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const;

export type CloudAgentAttachmentAllowedType = (typeof CLOUD_AGENT_ATTACHMENT_ALLOWED_TYPES)[number];

export const CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION: Record<
  CloudAgentAttachmentAllowedType,
  string
> = {
  ...CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION,
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

export const CLOUD_AGENT_ATTACHMENT_MAX_COUNT = 5;
export const CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const CLOUD_AGENT_ATTACHMENT_PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 min

/**
 * Filename-derived extensions that are never stored or downloaded, regardless
 * of the caller-supplied MIME. The allow-list is enforced at every layer that
 * validates a stored filename: the web tRPC schemas, the cloud-agent-next
 * persistence schema, the cloud-agent-next runtime download helper, and the
 * R2 download-presign helper.
 */
export const CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS = [
  'exe',
  'dll',
  'msi',
  'com',
  'scr',
  'apk',
  'ipa',
  'dmg',
  'pkg',
] as const;

export type CloudAgentAttachmentDeniedExtension =
  (typeof CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS)[number];

/**
 * Wire-format pattern for a caller-supplied extension on the upload-presign
 * input. The extension is lowercased, alpha-numeric, and at most 16 chars.
 * The deny-list is checked separately so this regex stays a pure shape rule.
 */
export const CLOUD_AGENT_ATTACHMENT_EXTENSION_REGEX = /^[a-z0-9]{1,16}$/;

/**
 * Relaxed contentType shape used when the caller supplies an extension and we
 * accept any reasonable MIME. The 128-char cap is a safety net; the regex
 * matches `type/subtype` plus a small set of structural characters.
 */
export const CLOUD_AGENT_ATTACHMENT_RELAXED_CONTENT_TYPE_REGEX = /^[\w.+-]+\/[\w.+-]+$/;
export const CLOUD_AGENT_ATTACHMENT_MAX_CONTENT_TYPE_LENGTH = 128;

/**
 * Server-stored filename regex. The UUID prefix is preserved so the
 * presign/download helpers can derive the R2 key from caller-supplied
 * metadata alone. The suffix is the union of the legacy 9-extension allow-list
 * and the relaxed `^[a-z0-9]{1,16}$` pattern; the deny-list is enforced by
 * the shared validation helper.
 */
export const CLOUD_AGENT_ATTACHMENT_RELAXED_FILENAME_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[a-z0-9]{1,16}$/;

/**
 * Canonical extension → MIME map. The STORED extension is the single source
 * of MIME truth for the worker (which derives the prompt MIME from the
 * filename suffix). A new extension without a mapping falls back to
 * `application/octet-stream`; the `bin` no-extension fallback also resolves
 * to `application/octet-stream`.
 */
export const CLOUD_AGENT_ATTACHMENT_EXTENSION_TO_MIME: Record<string, string> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  // pdf
  pdf: 'application/pdf',
  // text-y formats — surfaced as `text/plain` for the prompt; the worker's
  // prompt-shape rule still routes these through the file part path.
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/plain',
  log: 'text/plain',
  json: 'text/plain',
  xml: 'text/plain',
  yaml: 'text/plain',
  yml: 'text/plain',
  toml: 'text/plain',
  ini: 'text/plain',
  html: 'text/plain',
  css: 'text/plain',
  js: 'text/plain',
  jsx: 'text/plain',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/plain',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  hpp: 'text/plain',
  sh: 'text/plain',
  sql: 'text/plain',
};

export const CLOUD_AGENT_ATTACHMENT_FALLBACK_MIME = 'application/octet-stream';
export const CLOUD_AGENT_ATTACHMENT_FALLBACK_EXTENSION = 'bin';

/**
 * Resolve the canonical MIME for a stored extension. Returns the fallback
 * for unknown / missing / invalid extensions; the worker relies on this as
 * the single source of truth so `getPromptMime` cannot diverge.
 */
export function getPromptMimeForExtension(extension: string | undefined | null): string {
  if (!extension) return CLOUD_AGENT_ATTACHMENT_FALLBACK_MIME;
  const normalized = extension.toLowerCase();
  return (
    CLOUD_AGENT_ATTACHMENT_EXTENSION_TO_MIME[normalized] ?? CLOUD_AGENT_ATTACHMENT_FALLBACK_MIME
  );
}

/**
 * Normalize a caller-supplied extension: empty / non-conforming → `bin`. The
 * R2 key, the stored filename, and the download-presign helper all use the
 * normalized value so the wire-payload and the R2 basename can never disagree.
 */
export function normalizeAttachmentExtension(extension: string | undefined | null): string {
  if (extension && CLOUD_AGENT_ATTACHMENT_EXTENSION_REGEX.test(extension)) {
    return extension.toLowerCase();
  }
  return CLOUD_AGENT_ATTACHMENT_FALLBACK_EXTENSION;
}

export type CloudAgentAttachments = {
  path: string;
  files: string[];
};

/**
 * Maximum prompt length (in characters) accepted by the cloud agent.
 *
 * Mirrors the server-side cap in `services/cloud-agent-next/src/schema.ts`
 * (`Limits.MAX_PROMPT_LENGTH`). Prompts exceeding this would be rejected by
 * the worker, so we enforce the same limit client-side to give users
 * immediate feedback.
 */
export const CLOUD_AGENT_PROMPT_MAX_LENGTH = 100_000;
