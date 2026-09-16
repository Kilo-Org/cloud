/**
 * Zod schemas for every payload the kilo-mcp worker parses from an untrusted
 * caller: the JSON-RPC transport envelope, the MCP tool arguments, the
 * worker-owned OAuth helper query/form inputs, and the client headers this
 * worker forwards to apps/web.
 *
 * Trusted data is deliberately NOT re-validated here: apps/web tRPC responses
 * and the committed `catalog.json` are trusted artifacts. The catalog tool
 * `input` stays validated by AJV against the published JSON Schema
 * (`src/call.ts`); zod covers the transport/envelope and the worker-owned
 * query and form inputs.
 */
import { z } from 'zod';
import { MAX_SEARCH_LIMIT } from './search';

/** Maximum length of a forwarded client header value (defends the upstream trust boundary). */
export const MAX_CLIENT_HEADER_LENGTH = 1024;

/** A caller-supplied string that must carry at least one non-whitespace character. */
const nonWhitespaceString = (field: string): z.ZodType<string> =>
  z.string().refine(value => value.trim().length > 0, `${field} must be a non-empty string`);

/**
 * The JSON-RPC 2.0 request envelope. Arrays (batch requests) and `null` are
 * rejected by construction. `id` may be absent, `null`, a string, or a number;
 * `params` stays unknown because its shape depends on `method`.
 */
export const jsonRpcEnvelopeSchema = z
  .object({
    jsonrpc: z.string().optional(),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: nonWhitespaceString('method'),
    params: z.unknown().optional(),
  })
  .passthrough();

/** The `initialize` request params this worker reads (protocol version + client name). */
export const initializeParamsSchema = z
  .object({
    protocolVersion: z.string().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    clientInfo: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** The `tools/call` params: a non-empty tool name and an optional argument object. */
export const toolsCallParamsSchema = z
  .object({
    name: nonWhitespaceString('name'),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** The `search` tool arguments: a non-empty query and an optional bounded limit. */
export const searchArgsSchema = z
  .object({
    query: nonWhitespaceString('query'),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  })
  .passthrough();

/** The `call` tool arguments: a non-empty catalog path and an optional input object. */
export const callArgsSchema = z
  .object({
    path: nonWhitespaceString('path'),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * The RFC 7591 dynamic client registration metadata, read from the untrusted
 * registration body before the library stores the client. Only the fields this
 * worker inspects or rejects are typed; every other RFC 7591 member passes
 * through untouched so a valid client is never refused for an unknown field.
 * `redirect_uris` stays optional here because the library enforces its own
 * grant-specific requirements; this schema rejects only type confusion, and
 * `clientRegistrationCallback` rejects a `scope` this server does not issue.
 */
export const clientRegistrationSchema = z
  .object({
    redirect_uris: z.array(z.string().min(1)).optional(),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    scope: z.string().optional(),
    client_name: z.string().optional(),
    client_uri: z.string().optional(),
    logo_uri: z.string().optional(),
    contacts: z.array(z.string()).optional(),
    tos_uri: z.string().optional(),
    policy_uri: z.string().optional(),
    jwks_uri: z.string().optional(),
    software_id: z.string().optional(),
    software_version: z.string().optional(),
  })
  .passthrough();

/** The consent page's pairing-status query (`?code=`), read from the untrusted URL. */
export const pairingStatusQuerySchema = z.object({
  code: z.string().min(1),
});

/** The org picker's query (`?code=`), read from the untrusted URL. */
export const orgPickerQuerySchema = z.object({
  code: z.string().min(1),
});

/** The org picker's POST body (form-encoded), read from the untrusted request. */
export const orgPickerFormSchema = z.object({
  organization_id: z.string().min(1),
});

/** A header value safe to forward upstream: bounded length, no CR/LF (header injection). */
const forwardedHeaderValue = z
  .string()
  .max(MAX_CLIENT_HEADER_LENGTH)
  .refine(value => !/[\r\n]/.test(value), 'header values must not contain CR or LF');

/**
 * The client-identity headers forwarded to apps/web when opening a device-auth
 * pairing (see `src/oauth/kilo-pairing.ts`). A `Headers` instance is not a plain
 * object, so callers pass `Object.fromEntries(headers)`. The Fetch Headers
 * iterator lowercases names, so the keys below are lowercase — including
 * `cf-connecting-ip` — or the value would be silently stripped. Absent headers
 * are omitted rather than set to a default.
 */
export const forwardedClientHeadersSchema = z.object({
  'cf-connecting-ip': forwardedHeaderValue.optional(),
  'x-forwarded-for': forwardedHeaderValue.optional(),
  'user-agent': forwardedHeaderValue.optional(),
});

export type JsonRpcEnvelope = z.infer<typeof jsonRpcEnvelopeSchema>;
export type InitializeParams = z.infer<typeof initializeParamsSchema>;
export type ToolsCallParams = z.infer<typeof toolsCallParamsSchema>;
export type SearchArgs = z.infer<typeof searchArgsSchema>;
export type CallArgs = z.infer<typeof callArgsSchema>;
export type ClientRegistration = z.infer<typeof clientRegistrationSchema>;
export type PairingStatusQuery = z.infer<typeof pairingStatusQuerySchema>;
export type OrgPickerQuery = z.infer<typeof orgPickerQuerySchema>;
export type OrgPickerForm = z.infer<typeof orgPickerFormSchema>;
export type ForwardedClientHeaders = z.infer<typeof forwardedClientHeadersSchema>;
