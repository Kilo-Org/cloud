/**
 * Pure view-model helpers for the profile MCP servers screen.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-mcp-model.test.ts`. The screen owns rendering and the
 * network calls; this module owns the row projection, the add/edit form state,
 * the client-side validation that runs before a `createMcp`/`updateMcp`, and
 * the payload the mutations send.
 *
 * The source type is structural, so a test needs no tRPC type and the screen
 * passes the `agentProfiles.get` result straight in. The payload mirrors the
 * server's `mcpServerFullInputSchema`; the screen hands it to the mutation and
 * TypeScript checks it against the tRPC input there.
 */

import { formatRecord, parseRecord } from '@/components/profiles/mcp-json';

/** The fields of an MCP server the screen reads. Structural, so tests are easy. */
export type McpServerSource = Readonly<{
  id: string;
  name: string;
  type: 'local' | 'remote';
  enabled: boolean;
  timeout: number | null;
  config: Readonly<{
    command?: readonly string[];
    url?: string;
    environment?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
  }>;
}>;

/** One MCP server row as the screen renders it. */
export type McpServerRow = Readonly<{
  id: string;
  name: string;
  type: 'local' | 'remote';
  enabled: boolean;
  /** The command line (local) or URL (remote); empty when the config is odd. */
  summary: string;
  /** How many env (local) or header (remote) keys the server carries. */
  secretCount: number;
}>;

/**
 * The number of env/header keys on the server, matching the web editor's
 * `countSecretValues`: local servers count `environment`, remote count
 * `headers`. GET responses mask every value, so the count is all the row can
 * show about them.
 */
export function countSecretValues(server: McpServerSource): number {
  if (server.type === 'local') {
    return Object.keys(server.config.environment ?? {}).length;
  }
  return Object.keys(server.config.headers ?? {}).length;
}

/** The command line (local) or URL (remote) the row shows under the name. */
export function mcpServerSummary(server: McpServerSource): string {
  if (server.type === 'local') {
    return formatCommand(server.config.command ?? []);
  }
  return server.config.url ?? '';
}

/** Project the profile's MCP servers into the rows the list renders. */
export function mcpServerRows(servers: readonly McpServerSource[]): McpServerRow[] {
  return servers.map(server => ({
    id: server.id,
    name: server.name,
    type: server.type,
    enabled: server.enabled,
    summary: mcpServerSummary(server),
    secretCount: countSecretValues(server),
  }));
}

export type McpFormType = 'local' | 'remote';

/** The add/edit form fields. All strings; the sheet owns the refs. */
export type McpFormState = Readonly<{
  name: string;
  type: McpFormType;
  enabled: boolean;
  command: string;
  url: string;
  configJson: string;
  timeout: string;
}>;

/**
 * Seed the form from the server being edited, or blank defaults for an add.
 * The masked env/header values round-trip verbatim (`formatRecord`), so the
 * user sees every key and rotates only the ones they retype.
 */
export function initialMcpFormState(server?: McpServerSource): McpFormState {
  if (server === undefined) {
    return {
      name: '',
      type: 'local',
      enabled: true,
      command: '',
      url: '',
      configJson: '',
      timeout: '',
    };
  }
  return {
    name: server.name,
    type: server.type,
    enabled: server.enabled,
    command: server.type === 'local' ? formatCommand(server.config.command ?? []) : '',
    url: server.type === 'remote' ? (server.config.url ?? '') : '',
    configJson: formatRecord(
      server.type === 'local' ? server.config.environment : server.config.headers
    ),
    timeout: server.timeout === null ? '' : String(server.timeout),
  };
}

/** Server bounds: name pattern and max, command list, timeout range, url, record. */
const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MCP_NAME_MAX_LENGTH = 100;
const MCP_TIMEOUT_MAX = 3_600_000;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
/** Server bound: `mcpRemoteConfigInputSchema`'s `z.string().url().max(2048)`. */
const MCP_URL_MAX_LENGTH = 2048;
/** Server bound: `mcpLocalConfigInputSchema`'s `z.array(...).min(1).max(50)`. */
const MCP_COMMAND_MAX_ARGS = 50;
/** Server bound: each command argument's `z.string().max(500)`. */
const MCP_COMMAND_ARG_MAX_LENGTH = 500;
/** Server bound: `MAX_MCP_ENV_OR_HEADERS` caps the env/headers record. */
const MCP_RECORD_MAX_ENTRIES = 50;
/** Server bound: the env/header key's `z.string().max(128)`. */
const MCP_RECORD_KEY_MAX_LENGTH = 128;
/** Server bound: the env/header value's `z.string().max(4096)`. */
const MCP_RECORD_VALUE_MAX_LENGTH = 4096;

export type McpFormError =
  | 'name-required'
  | 'name-invalid'
  | 'command-required'
  | 'command-too-long'
  | 'url-required'
  | 'url-invalid'
  | 'url-too-long'
  | 'timeout-invalid'
  | 'json-invalid'
  | 'record-too-large';

/**
 * Split a command line back into the argument array the server stores. A
 * double-quoted run keeps its spaces (and a backslash escapes the next
 * character inside it), so `tool "--label=foo bar"` round-trips to two
 * arguments instead of three. Anything unquoted splits on whitespace as before.
 */
export function commandParts(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let hasToken = false;
  let quoted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (quoted && char === '\\' && index + 1 < command.length) {
      index += 1;
      current += command[index];
      hasToken = true;
    } else if (char === '"') {
      quoted = !quoted;
      // A quoted empty run is a real empty argument, unlike a bare blank run.
      hasToken = true;
    } else if (!quoted && /\s/.test(char)) {
      if (hasToken) {
        parts.push(current);
      }
      current = '';
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) {
    parts.push(current);
  }
  return parts;
}

/** The escaped forms a quoted command argument carries, spelled without escaping. */
const ESCAPED_BACKSLASH = String.raw`\\`;
const ESCAPED_QUOTE = String.raw`\"`;

/**
 * Render a command array as one editable line. Only an argument that would
 * lose its boundary — one holding whitespace, a quote or a backslash, or an
 * empty argument — is quoted and escaped, so the common command reads as
 * plain text while `commandParts` recovers every argument exactly.
 */
export function formatCommand(parts: readonly string[]): string {
  return parts
    .map(part =>
      part.length === 0 || /[\s"\\]/.test(part)
        ? `"${part.replaceAll('\\', ESCAPED_BACKSLASH).replaceAll('"', ESCAPED_QUOTE)}"`
        : part
    )
    .join(' ');
}

function parseTimeout(raw: string): number | undefined | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MCP_TIMEOUT_MAX) {
    return null;
  }
  return value;
}

/**
 * Validate the form before a save. Returns the field at fault, or `null` when
 * valid. Mirrors the server's input schema so an invalid save never leaves the
 * device: the name pattern and length, a non-empty command for a local server
 * within the argument count/length bounds, a parseable URL within its length
 * bound and a non-empty JSON fragment for a remote one, an integer timeout, and
 * a `Record<string,string>` JSON fragment within the entry/key/value bounds
 * either way.
 */
export function validateMcpForm(state: McpFormState): McpFormError | null {
  const name = state.name.trim();
  if (name.length === 0) {
    return 'name-required';
  }
  if (name.length > MCP_NAME_MAX_LENGTH || !MCP_NAME_PATTERN.test(name)) {
    return 'name-invalid';
  }
  if (state.type === 'local') {
    const args = commandParts(state.command);
    if (args.length === 0) {
      return 'command-required';
    }
    if (
      args.length > MCP_COMMAND_MAX_ARGS ||
      args.some(argument => argument.length > MCP_COMMAND_ARG_MAX_LENGTH)
    ) {
      return 'command-too-long';
    }
  } else {
    const url = state.url.trim();
    if (url.length === 0) {
      return 'url-required';
    }
    if (!URL_PATTERN.test(url)) {
      return 'url-invalid';
    }
    if (url.length > MCP_URL_MAX_LENGTH) {
      return 'url-too-long';
    }
  }
  if (parseTimeout(state.timeout) === null) {
    return 'timeout-invalid';
  }
  const record = parseRecord(state.configJson);
  if (!record.ok) {
    return 'json-invalid';
  }
  if (record.value !== undefined) {
    const entries = Object.entries(record.value);
    if (
      entries.length > MCP_RECORD_MAX_ENTRIES ||
      entries.some(
        ([key, value]) =>
          key.length > MCP_RECORD_KEY_MAX_LENGTH || value.length > MCP_RECORD_VALUE_MAX_LENGTH
      )
    ) {
      return 'record-too-large';
    }
  }
  return null;
}

/** The payload the MCP mutations send; mirrors the server's server input. */
export type McpServerPayload =
  | {
      type: 'local';
      name: string;
      enabled: boolean;
      timeout?: number;
      config: { command: string[]; environment?: Record<string, string> };
    }
  | {
      type: 'remote';
      name: string;
      enabled: boolean;
      timeout?: number;
      config: { url: string; headers?: Record<string, string> };
    };

/**
 * Build the mutation payload from a validated form. Only call after
 * `validateMcpForm` returns `null`.
 */
export function buildMcpServerPayload(state: McpFormState): McpServerPayload {
  const name = state.name.trim();
  const timeout = parseTimeout(state.timeout);
  const record = parseRecord(state.configJson);
  const values = record.ok ? record.value : undefined;
  if (state.type === 'local') {
    return {
      type: 'local',
      name,
      enabled: state.enabled,
      ...(timeout == null ? {} : { timeout }),
      config: {
        command: commandParts(state.command),
        ...(values === undefined ? {} : { environment: values }),
      },
    };
  }
  return {
    type: 'remote',
    name,
    enabled: state.enabled,
    ...(timeout == null ? {} : { timeout }),
    config: {
      url: state.url.trim(),
      ...(values === undefined ? {} : { headers: values }),
    },
  };
}
