export const AGENT_ATTACHMENT_MAX_FILES = 5;
export const AGENT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Extensions that are NEVER allowed regardless of the picker's reported MIME
 * type. The cloud-agent storage layer rejects these as executables, so we
 * mirror the deny list client-side to give a precise error at the chip
 * instead of a round-trip rejection.
 */
export const AGENT_ATTACHMENT_DENIED_EXTENSIONS = new Set([
  'exe',
  'dll',
  'msi',
  'com',
  'scr',
  'apk',
  'ipa',
  'dmg',
  'pkg',
]);

/**
 * Normalized extensions must match this regex. Anything that does not is
 * coerced to `bin` and treated as opaque binary. Keeping the bound tight
 * protects the server's storage key and the wire contract.
 */
export const AGENT_ATTACHMENT_EXTENSION_REGEX = /^[a-z0-9]{1,16}$/;

/**
 * Fallback extension when the candidate's filename has no parseable
 * extension or the extension does not match the allowed regex. Consumers
 * derive MIME from the extension, so the fallback MUST be present in
 * `AGENT_ATTACHMENT_MIME_BY_EXTENSION`.
 */
export const AGENT_ATTACHMENT_FALLBACK_EXTENSION = 'bin';

/**
 * Canonical extension → MIME table. MUST stay in lock-step with the server's
 * allowed content type set; the parity test in `validate.test.ts` asserts
 * every entry resolves to a defined MIME.
 */
export const AGENT_ATTACHMENT_MIME_BY_EXTENSION = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  // Documents
  pdf: 'application/pdf',
  // Text-ish source — server treats all of these as text/plain
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
  // Opaque binary fallback
  bin: 'application/octet-stream',
} as const satisfies Record<string, string>;

export type AgentAttachmentMime =
  (typeof AGENT_ATTACHMENT_MIME_BY_EXTENSION)[keyof typeof AGENT_ATTACHMENT_MIME_BY_EXTENSION];

/**
 * Any extension that survives normalization. Callers MUST go through
 * `AGENT_ATTACHMENT_MIME_BY_EXTENSION` to resolve MIME — there is no
 * closed union of accepted extensions, and a picker can supply extensions
 * outside this list.
 */
export type AgentAttachmentExtension = keyof typeof AGENT_ATTACHMENT_MIME_BY_EXTENSION;
