import * as z from 'zod';
import { MAX_PROFILE_ENV_VARS } from './runtime-environment';
import { RuntimeProfileLimits } from './runtime-profile';

/**
 * Caps for the configuration `prepareSession` accepts and persists.
 *
 * Declared once because two layers validate the same payload: the web input
 * schema (`apps/web/src/routers/cloud-agent-next-schemas.ts`) and the Worker's
 * persistence mirror (`persistence/schemas.ts`). Each constant mirrors a limit
 * the Worker already enforces downstream, so a payload rejected here would
 * otherwise be decrypted and materialized first and fail with a generic attach
 * error.
 *
 * `shared/sandbox-control-protocol.ts` builds its attach schema from these
 * constants and `schema.ts` reads `MAX_ENV_VARS` and `MAX_MCP_SERVERS` from
 * here, so none of the numbers is restated anywhere. This module must stay
 * importable from the Next.js app: it may depend on zod and same-directory
 * shared modules only.
 */

/** `sessionAttachMcpServersSchema` accepts at most 20 servers; `Limits.MAX_MCP_SERVERS` re-exports it. */
export const MAX_MCP_SERVERS = 20;

/** Record key for a server name, in the attach schema and in both prepareSession mirrors. */
export const MAX_MCP_SERVER_NAME_LENGTH = 100;

/** Attach schema caps each server's environment or headers record at 50 entries. */
export const MAX_MCP_ENV_OR_HEADERS_PER_SERVER = 50;

/** Record keys for env vars and headers: `z.string().min(1).max(256)`. */
export const MAX_MCP_ENV_OR_HEADER_KEY_LENGTH = 256;

/** Attach schema caps a local server's command array at 50 elements. */
export const MAX_MCP_COMMAND_ARGS = 50;

/** Attach schema caps each command argument at 8192 characters. */
export const MAX_MCP_COMMAND_ARG_LENGTH = 8192;

/**
 * Attach schema caps one environment value or header value at 8192 characters.
 * A plain secret therefore travels at most that long, and an encrypted envelope
 * carries it after base64 and AES-256-GCM expansion.
 */
export const MAX_MCP_SECRET_VALUE_LENGTH = 8192;

/** Attach schema caps a remote server URL at 4096 characters. */
export const MAX_MCP_REMOTE_URL_LENGTH = 4096;

/** Caps one skill's companion files. */
export const MAX_RUNTIME_SKILL_COMPANION_FILES =
  RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES;

/** Caps the summed character length of one skill's companion files. */
export const MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL =
  RuntimeProfileLimits.MAX_RUNTIME_SKILL_COMPANION_FILES_TOTAL;

/** `Limits.MAX_ENV_VARS` re-exports it; caps the prepareSession env-var record. */
export const MAX_ENV_VARS = MAX_PROFILE_ENV_VARS;

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
 * Plaintext budget for the MCP configuration of one session. The sandbox attach
 * schema applies the same number to the serialized plaintext it materializes, so
 * one declaration bounds both the submitted configuration and the materialized
 * one.
 */
export const MAX_MCP_PLAINTEXT_BYTES = 80 * 1024;

/** AES-256-GCM frames `encryptedData` with a 16-byte IV and a 16-byte tag. */
const ENVELOPE_FRAMING_BYTES = 32;

/** Narrows a parsed schema value to a plain object without asserting its shape. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Bytes a secret value contributes to the materialized configuration, without
 * decrypting it. A plain value is charged its JSON-escaped size, exactly as the
 * attach schema measures it. A GCM ciphertext is exactly as long as its
 * plaintext and base64 is four thirds of the ciphertext, so an envelope is
 * charged its decoded byte count: escaping depends on content that is not
 * readable here, and the budget bounds the decrypted work rather than the exact
 * serialized size.
 */
const secretPlaintextBytes = (value: unknown): number => {
  if (typeof value === 'string') {
    // Two quotes are already in the frame, so charge the escaped content only.
    return new TextEncoder().encode(JSON.stringify(value)).byteLength - 2;
  }
  if (!isRecord(value)) return 0;
  const data = value.encryptedData;
  if (typeof data !== 'string') return 0;
  return Math.max(0, Math.ceil((data.length * 3) / 4) - ENVELOPE_FRAMING_BYTES);
};

/**
 * The configuration as the sandbox attach schema measures it: the record with
 * every secret value replaced by an empty string, so its serialized size holds
 * everything except the secret payload itself.
 */
const frameOf = (servers: Record<string, unknown>): unknown => {
  const frame: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) {
      frame[name] = server;
      continue;
    }
    const copy: Record<string, unknown> = { ...server };
    for (const field of ['environment', 'headers']) {
      const values = copy[field];
      if (!isRecord(values)) continue;
      copy[field] = Object.fromEntries(Object.keys(values).map(key => [key, '']));
    }
    frame[name] = copy;
  }
  return frame;
};

/**
 * Bytes the materialized MCP configuration would occupy: the JSON frame around
 * the secrets plus each secret's plaintext size. Envelope framing (the wrapped
 * key and the algorithm fields) is excluded because the attach schema measures
 * the plaintext, not the envelopes that carry it.
 */
const materializedBytes = (servers: Record<string, unknown>): number => {
  let total = new TextEncoder().encode(JSON.stringify(frameOf(servers))).byteLength;
  for (const server of Object.values(servers)) {
    if (!isRecord(server)) continue;
    for (const field of ['environment', 'headers']) {
      const values = server[field];
      if (!isRecord(values)) continue;
      for (const value of Object.values(values)) {
        total += secretPlaintextBytes(value);
      }
    }
  }
  return total;
};

/**
 * Record of MCP servers keyed by name. The caller passes its own server schema
 * because the web input and the Worker persistence mirror validate slightly
 * different value shapes (plain strings vs. envelopes).
 */
export function mcpServersRecordSchema<ServerSchema extends z.ZodType>(serverSchema: ServerSchema) {
  return z
    .record(z.string().min(1).max(MAX_MCP_SERVER_NAME_LENGTH), serverSchema)
    .refine(servers => Object.keys(servers).length <= MAX_MCP_SERVERS, {
      message: `A session can have at most ${MAX_MCP_SERVERS} MCP servers`,
    })
    .refine(servers => materializedBytes(servers) <= MAX_MCP_PLAINTEXT_BYTES, {
      message: `MCP configuration would materialize more than ${MAX_MCP_PLAINTEXT_BYTES} bytes of plaintext`,
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
    .record(z.string().min(1).max(MAX_MCP_ENV_OR_HEADER_KEY_LENGTH), valueSchema)
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
