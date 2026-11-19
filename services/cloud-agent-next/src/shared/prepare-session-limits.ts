import * as z from 'zod';

/**
 * Caps for the configuration `prepareSession` accepts and persists.
 *
 * Declared once because two layers validate the same payload: the web input
 * schema (`apps/web/src/routers/cloud-agent-next-schemas.ts`) and the Worker's
 * persistence mirror (`persistence/schemas.ts`). Each constant mirrors a limit
 * the Worker already enforces downstream, so a payload rejected here would
 * otherwise be decrypted and materialized first and fail with a generic attach
 * error.
 */

/** `sessionAttachMcpServersSchema` accepts at most 20 servers; `Limits.MAX_MCP_SERVERS` agrees. */
export const MAX_MCP_SERVERS = 20;

/** Attach schema record key for a server name: `z.string().max(100)`. */
export const MAX_MCP_SERVER_NAME_LENGTH = 100;

/** Attach schema caps each server's environment or headers record at 50 entries. */
export const MAX_MCP_ENV_OR_HEADERS_PER_SERVER = 50;

/** Attach schema record keys for env vars and headers: `z.string().min(1).max(256)`. */
export const MAX_MCP_ENV_OR_HEADER_KEY_LENGTH = 256;

/** Attach schema caps a local server's command array at 50 elements. */
export const MAX_MCP_COMMAND_ARGS = 50;

/** Attach schema caps each command argument at 8192 characters. */
export const MAX_MCP_COMMAND_ARG_LENGTH = 8192;

/** Attach schema caps a remote server URL at 4096 characters. */
export const MAX_MCP_REMOTE_URL_LENGTH = 4096;

/** `RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES` caps one skill's companion files. */
export const MAX_RUNTIME_SKILL_COMPANION_FILES = 40;

/** `Limits.MAX_ENV_VARS` caps the prepareSession env-var record; the Worker agrees. */
export const MAX_ENV_VARS = 50;

/**
 * `RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL` caps the summed
 * character length of one skill's companion files.
 */
export const MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL = 500_000;

/**
 * Envelope `encryptedData`: a 8192 UTF-16 unit plaintext is at most 24,576
 * UTF-8 bytes, and AES-256-GCM adds a 16-byte IV and a 16-byte tag — 24,608
 * bytes, which base64 encodes to 32,812 characters. The cap rounds up to
 * 32,816 for headroom.
 */
export const MAX_ENCRYPTED_DATA_LENGTH = 32_816;

/**
 * Envelope `encryptedDEK`: RSA-4096 OAEP-SHA256 wraps the 32-byte AES key into
 * a 512-byte ciphertext, which base64 encodes to exactly 684 characters.
 */
export const MAX_ENCRYPTED_DEK_LENGTH = 684;

/**
 * Record of MCP servers keyed by name. The caller passes its own server schema
 * because the web input and the Worker persistence mirror validate slightly
 * different value shapes (plain strings vs. envelopes).
 */
export function mcpServersRecordSchema<ServerSchema extends z.ZodType>(serverSchema: ServerSchema) {
  return z
    .record(z.string().max(MAX_MCP_SERVER_NAME_LENGTH), serverSchema)
    .refine(servers => Object.keys(servers).length <= MAX_MCP_SERVERS, {
      message: `A session can have at most ${MAX_MCP_SERVERS} MCP servers`,
    });
}

/**
 * Record of environment variables or remote headers for one MCP server. The
 * caller passes its own value schema for the same reason as above.
 */
export function mcpEnvOrHeadersRecordSchema<ValueSchema extends z.ZodType>(
  valueSchema: ValueSchema
) {
  return z
    .record(z.string().max(MAX_MCP_ENV_OR_HEADER_KEY_LENGTH), valueSchema)
    .refine(values => Object.keys(values).length <= MAX_MCP_ENV_OR_HEADERS_PER_SERVER, {
      message: `An MCP server can have at most ${MAX_MCP_ENV_OR_HEADERS_PER_SERVER} environment variables or headers`,
    });
}

/** Command array of a local MCP server: 1-50 arguments of at most 8192 characters. */
export const mcpCommandSchema = z
  .array(z.string().max(MAX_MCP_COMMAND_ARG_LENGTH))
  .min(1, 'Command array must have at least one element')
  .max(MAX_MCP_COMMAND_ARGS, `A command may have at most ${MAX_MCP_COMMAND_ARGS} arguments`);

/** URL of a remote MCP server: a valid URL of at most 4096 characters. */
export const mcpRemoteUrlSchema = z
  .string()
  .url('URL must be a valid URL format')
  .max(
    MAX_MCP_REMOTE_URL_LENGTH,
    `Remote MCP server URL must be at most ${MAX_MCP_REMOTE_URL_LENGTH} characters`
  );
