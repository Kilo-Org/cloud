/**
 * Adapter between the wrapper and the @kilocode/sdk client.
 *
 * Provides a stable `WrapperKiloClient` interface that all wrapper modules use.
 * The raw SDK client is not exposed on the returned interface — all access
 * goes through named methods.
 */

import type { KiloClient as SDKClient } from '@kilocode/sdk';
import {
  createKiloClient as createV2Client,
  type PermissionRequest,
  type PermissionRuleset,
  type QuestionRequest,
  type SessionCommandResponse,
  type SessionPromptResponse,
  type SessionMessagesResponse2,
  type SnapshotFileDiff,
  type SuggestionRequest,
  type Todo,
} from '@kilocode/sdk/v2';
import { z } from 'zod';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logToFile } from './utils.js';
import { kiloClientConfig, kiloServerHeaders, type KiloServer } from './kilo-server-auth.js';
import {
  boundSlashCommandCatalog,
  toSlashCommandInfo,
  type BoundedSlashCommandCatalog,
  type SlashCommandInfo,
} from '../../src/shared/slash-commands.js';
import { KILO_CLI_VERSION } from '../../src/shared/kilo-cli-version.js';
import { sessionChildSchema } from './control/session-child-schema.js';
import type { ControlPlaneSessionCredentialsPayload } from '../../src/shared/control-plane-protocol.js';

const sessionStatusesSchema = z.record(
  z.string().min(1),
  z.object({ type: z.string().min(1) }).passthrough()
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A stable JSON rendering, so two equal metadata values compare equal whatever
 * their key order. Undefined object members are dropped, as `JSON.stringify`
 * drops them, and an undefined value renders as `null`.
 *
 * This decides whether a durable copy must be rewritten, never whether to send
 * an update: an update is decided by whether the record carries a value at all.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`;
  if (isRecord(value)) {
    const members = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isKiloEvent(value: unknown): value is KiloEvent {
  return isRecord(value) && typeof value.type === 'string';
}

function isSyntheticKiloEvent(event: KiloEvent): boolean {
  return event.type === 'server.connected' || event.type === 'server.heartbeat';
}

/**
 * Codes raised by fetch when the server process cannot be reached — Node/undici
 * errno strings plus Bun's fetch codes, which have no errno equivalent.
 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
]);

/** Transport-failure texts from fetch implementations that set no code. */
const UNREACHABLE_ERROR_PATTERN = /econnrefused|econnreset|fetch failed|unable to connect/i;

/** Bound on `cause` traversal, in case a chain is cyclic. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True when a WrapperKiloClient call failed because the kilo server process
 * itself is gone (crashed, OOM-killed) rather than because it returned an
 * application-level error. Distinguishing the two matters: app-level errors
 * (bad session id, invalid model) must not trigger a runtime restart, but a
 * dead server should — see MEMORY_CGROUPS_PLAN.md (W5).
 *
 * Wrapper errors carry the original SDK failure as `cause`: an Error instance
 * when the transport failed, or the parsed response body (not an Error) when a
 * live server answered with an application error. Codes are checked at every
 * level of the chain, but the message pattern applies only to a leaf Error:
 * composed wrapper messages embed application text, and a live server relaying
 * an upstream failure may legitimately say "fetch failed" in its error body.
 */
export function isKiloServerUnreachableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true;
    if (current.cause === undefined) return UNREACHABLE_ERROR_PATTERN.test(current.message);
    current = current.cause;
  }
  return false;
}

async function* globalFeedPayloads(
  stream: AsyncIterable<unknown>,
  workspacePath: string
): AsyncGenerator<KiloEvent> {
  for await (const envelope of stream) {
    if (!isRecord(envelope)) continue;
    const payload = envelope.payload;
    if (!isKiloEvent(payload)) continue;

    const directory = envelope.directory;
    if (isSyntheticKiloEvent(payload) || directory === workspacePath) {
      yield payload;
    }
  }
}

function providerIdFromRecord(provider: Record<string, unknown>): string | undefined {
  const id = provider.id ?? provider.providerID ?? provider.providerId;
  return typeof id === 'string' ? id : undefined;
}

function modelIdFromRecord(model: Record<string, unknown>): string | undefined {
  const id = model.id ?? model.modelID ?? model.modelId;
  return typeof id === 'string' ? id : undefined;
}

function modelKeysFromModels(models: unknown): string[] {
  if (isRecord(models)) return Object.keys(models);
  if (!Array.isArray(models)) return [];
  return models.flatMap(model => {
    if (typeof model === 'string') return [model];
    if (isRecord(model)) {
      const modelID = modelIdFromRecord(model);
      return modelID ? [modelID] : [];
    }
    return [];
  });
}

function modelKeysFromProvider(provider: unknown): string[] {
  if (!isRecord(provider)) return [];
  return modelKeysFromModels(provider.models);
}

function findProviderEntries(data: unknown, providerID: string): unknown[] {
  if (Array.isArray(data)) {
    return data.filter(
      provider => isRecord(provider) && providerIdFromRecord(provider) === providerID
    );
  }

  if (!isRecord(data)) return [];

  const providers = data.providers;
  if (Array.isArray(providers)) {
    const matchingProviders = providers.filter(
      entry => isRecord(entry) && providerIdFromRecord(entry) === providerID
    );
    if (matchingProviders.length > 0) return matchingProviders;
  }

  const directProvider = data[providerID];
  if (directProvider !== undefined) return [directProvider];

  return providerIdFromRecord(data) === providerID ? [data] : [];
}

function exactDedupedModelKeys(data: unknown, providerID: string): string[] {
  return [...new Set(findProviderEntries(data, providerID).flatMap(modelKeysFromProvider))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function formatSdkError(result: { response?: Response }): string {
  return result.response ? `HTTP ${result.response.status}` : 'request error';
}

function requireSdkData<T>(
  result: { data?: T; error?: unknown; response?: Response },
  operation: string
): T {
  if (result.error !== undefined) {
    throw new Error(`${operation} failed: ${formatSdkError(result)}`, {
      cause: result.error,
    });
  }

  if (result.data === undefined || result.data === null || result.response?.status === 204) {
    throw new Error(`${operation} returned no data`);
  }

  return result.data;
}

/**
 * The rules a session record owes could not be settled.
 *
 * `retryable` states the commit invariant of a retry. A retryable failure is
 * raised only while the durable marker still holds the obligation, or before
 * anything was committed, so a retried step reads the same durable state and
 * can succeed. A permanent failure means that state cannot be interpreted, so
 * a retry repeats the same failure.
 */
export abstract class SessionRulesetError extends Error {
  readonly sessionId: string;
  abstract readonly retryable: boolean;

  protected constructor(sessionId: string, message: string, cause: unknown) {
    super(message, { cause });
    this.sessionId = sessionId;
  }
}

/**
 * The durable state says the ruleset is owed and the wrapper cannot apply it.
 * The record is in place without its rules, and the marker or the record bytes
 * cannot be interpreted, so retrying the session step repeats the same failure.
 *
 * The message names the cause after the session id, which is what makes a
 * permanent failure diagnosable. Every value a cause can hold is generated by
 * this wrapper — a marker path, a parse failure, an SDK result message — so it
 * carries no token, header or record payload, and only the wrapper log sees it:
 * prepare.ts maps this class to a fixed `kilo_import_failed` frame and never
 * forwards the text.
 */
export class SessionRulesetNotAppliedError extends SessionRulesetError {
  readonly retryable = false;

  constructor(sessionId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(sessionId, `Session ruleset not applied for ${sessionId}: ${detail}`, cause);
    this.name = 'SessionRulesetNotAppliedError';
  }
}

/**
 * The wrapper could not establish whether the session owes a ruleset, and it
 * wrote nothing. The marker or the record read can answer on the next attempt,
 * so a retried step re-reads the same durable state and can succeed.
 */
export class SessionRulesetUnverifiedError extends SessionRulesetError {
  readonly retryable = true;

  constructor(sessionId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      sessionId,
      `Session owed ruleset could not be established for ${sessionId}: ${detail}`,
      cause
    );
    this.name = 'SessionRulesetUnverifiedError';
  }
}

/**
 * The step's own abort reason, or `undefined` when the caller did not abort.
 *
 * An aborted step keeps the classification and retry budget of its signal: the
 * route reports a timeout, not a ruleset failure that nothing will retry. A
 * signal aborted without a reason still gets one that names the step and the
 * session, because the durable marker is intact either way.
 */
function abortedReason(
  signal: AbortSignal | undefined,
  sessionId: string,
  what: string
): Error | undefined {
  if (!signal?.aborted) return undefined;
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${what} for ${sessionId} aborted`);
}

/**
 * True when a ruleset failure is permanent for the session step. A failure that
 * is not a `SessionRulesetError` is not permanent: it follows the retry policy
 * of every other failure.
 */
export const isPermanentRulesetFailure = (error: unknown): boolean =>
  error instanceof SessionRulesetError && !error.retryable;

/**
 * The native session update appends rules instead of replacing them, so a
 * ruleset a record already holds must not be sent again.
 *
 * `action` stays a plain string because a record or marker may carry an action
 * VALUE this build does not know, and refusing it would throw away the whole
 * ruleset instead of the one rule. The keys stay strict: the pinned server
 * strips unknown rule keys itself, so accepting them here would only widen what
 * this wrapper treats as a grant.
 */
const permissionRuleSchema = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: z.string(),
});

// Parses a ruleset that arrives as JSON (a remembered marker) or as an
// unvalidated session-read field; a ruleset becomes permission grants, so it is
// never applied unparsed.
const permissionRulesetSchema = z.array(permissionRuleSchema);

/**
 * The ruleset `value` holds, or `undefined` when it is not a ruleset.
 *
 * The schema keeps `action` a plain string, because an action this build does
 * not know must drop nothing: the record's rules still parse, so they can still
 * be compared and applied. That leaves the parsed value wider than the SDK's
 * `'allow' | 'deny' | 'ask'`, so the result is narrowed once here, after
 * validation, instead of widening the schema.
 */
function parseRuleset(value: unknown): PermissionRuleset | undefined {
  const parsed = permissionRulesetSchema.safeParse(value);
  return parsed.success ? (parsed.data as PermissionRuleset) : undefined;
}

// The marker shape: both obligations optional, at least one present. A value
// that is neither this object nor a bare ruleset array names an obligation the
// wrapper cannot interpret, so it fails permanently instead of reading as
// nothing owed.
const sessionMetadataSchema = z.record(z.string(), z.unknown());
const sessionObligationsSchema = z
  .object({ permission: z.unknown(), metadata: sessionMetadataSchema })
  .partial();

/**
 * What a session record still owes the wrapper after the native import commits
 * it. The import replaces the row and its body can carry neither a ruleset nor
 * metadata, so both are recorded before the import and applied right after it.
 * When an apply fails the record stays in place without that part; the next
 * prepare must settle it before the route is reused, not skip the call because
 * the record is already there.
 *
 * One file per session carries both obligations, so a failure to restore one
 * never takes the other down with it, and a single remove clears what is done.
 * `metadata` is the record's own value forwarded as read; only the record
 * decides its shape, which the update endpoint types as an object map.
 */
export type SessionObligations = {
  permission?: PermissionRuleset;
  metadata?: Record<string, unknown>;
};

/**
 * The file that records what a committed record still owes.
 *
 * The record lives in the sandbox, so the marker must outlive this process: a
 * wrapper restart inside a surviving allocation would otherwise lose it.
 *
 * The path is derived from `$HOME` alone and returns `undefined` without a
 * usable one. A shared fallback such as the OS temp directory would put the
 * marker where another process can plant one, and a marker becomes permission
 * grants, so an unnameable marker fails retryably instead of being guessed.
 */
function sessionObligationsPath(sessionId: string): string | undefined {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) return undefined;
  return path.join(home, '.kilo-control', 'rulesets', `${encodeURIComponent(sessionId)}.json`);
}

function missingHome(sessionId: string): SessionRulesetUnverifiedError {
  return new SessionRulesetUnverifiedError(
    sessionId,
    new Error('the wrapper has no home directory for its control state')
  );
}

export async function rememberSessionObligations(
  sessionId: string,
  obligations: SessionObligations
): Promise<void> {
  const file = sessionObligationsPath(sessionId);
  if (file === undefined) throw missingHome(sessionId);
  const directory = path.dirname(file);
  // Write beside the target and rename, so a kill mid-write cannot leave a
  // truncated marker that reads as "nothing owed".
  const temporary = path.join(directory, `${encodeURIComponent(sessionId)}.${process.pid}.tmp`);
  try {
    // The file is 0600 and its directory 0700, so another local user cannot
    // plant or read a marker and the rules it carries cannot be widened behind
    // the wrapper's back. This is defence in depth in a single-tenant sandbox
    // only while the wrapper and the agent share one uid: the agent runs as the
    // same user with `bash` and `external_directory` allowed, so it can still
    // write here. A real boundary needs wrapper state outside every location
    // the agent can write, which is a sandbox-level change, not this module's.
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    // mkdir does not tighten a directory that already exists, so one an earlier
    // run left readable or writable by another user stays plantable. Only a
    // directory that grants group or other access is tightened, so a
    // deliberately restricted one is left as its owner set it. A chmod failure
    // is ignored because the write below then fails on its own: a directory
    // this process may not tighten is one it may not write to either.
    const existing = await fsp.stat(directory);
    if ((existing.mode & 0o077) !== 0) await fsp.chmod(directory, 0o700).catch(() => undefined);
    await fsp.writeFile(temporary, JSON.stringify(obligations), { mode: 0o600 });
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    // The marker goes down before the import, so a write that fails leaves no
    // committed record, and a retried step can store the marker and import.
    throw new SessionRulesetUnverifiedError(sessionId, error);
  }
}

export async function forgetSessionObligations(sessionId: string): Promise<void> {
  const file = sessionObligationsPath(sessionId);
  // Without a home directory there is no marker this wrapper could have
  // written, and a path derived from a shared directory must never be removed.
  if (file === undefined) return;
  await fsp.rm(file, { force: true });
}

/**
 * The obligations the marker records, or `undefined` when it records none.
 *
 * The store began as a bare ruleset array, so that shape still reads as a
 * permission-only obligation: a marker written by an earlier build must be
 * settled rather than read as malformed.
 */
export async function readSessionObligations(
  sessionId: string
): Promise<SessionObligations | undefined> {
  const file = sessionObligationsPath(sessionId);
  if (file === undefined) throw missingHome(sessionId);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A marker that exists but cannot be read may be readable on the retry, so
    // the step fails retryably and writes nothing.
    throw new SessionRulesetUnverifiedError(sessionId, error);
  }
  // The bytes are there, so a retry reads the same bytes: a marker that is not
  // JSON, or is JSON that names no interpretable obligation, fails permanently
  // instead of reading as nothing owed, because that would drop an obligation
  // the record never received. The message names the marker path and the parse
  // failure, which is what makes the permanent class diagnosable.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionRulesetNotAppliedError(
      sessionId,
      new Error(`marker ${file} is not a ruleset: ${detail}`)
    );
  }
  const legacy = parseRuleset(parsed);
  if (legacy !== undefined) return { permission: legacy };
  const shape = sessionObligationsSchema.safeParse(parsed);
  if (!shape.success) {
    throw new SessionRulesetNotAppliedError(
      sessionId,
      new Error(`marker ${file} is not a ruleset: ${shape.error.message}`)
    );
  }
  const permission =
    shape.data.permission === undefined ? undefined : parseRuleset(shape.data.permission);
  if (shape.data.permission !== undefined && permission === undefined) {
    throw new SessionRulesetNotAppliedError(
      sessionId,
      new Error(`marker ${file} is not a ruleset: its permission is not a ruleset`)
    );
  }
  const obligations: SessionObligations = {
    ...(permission === undefined ? {} : { permission }),
    ...(shape.data.metadata === undefined ? {} : { metadata: shape.data.metadata }),
  };
  if (obligations.permission === undefined && obligations.metadata === undefined) {
    throw new SessionRulesetNotAppliedError(
      sessionId,
      new Error(`marker ${file} is not a ruleset: it names no obligation`)
    );
  }
  return obligations;
}

/**
 * The parts of a session read that decide which record the read describes.
 * `permission` is parsed separately, because a record that carries permission
 * data which is not a ruleset is still this route's record: failing the whole
 * parse would read it as absent and the caller would prepare without the rules.
 */
const storedSessionSchema = z.object({ directory: z.string() }).passthrough();

const carriedSlugSchema = z.string().min(1);
const carriedShareSchema = z.object({ url: z.string().min(1) }).transform(value => value.url);

/**
 * The two fields a re-point copies from the unvalidated session read besides
 * the ones it forwards whole: the `slug` the import body takes as a string, and
 * the `share` whose URL names that slug. A value of the wrong shape reads as
 * absent, as the directory does, instead of failing the session step.
 */
function carriedSlug(value: unknown): string | undefined {
  const parsed = carriedSlugSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function carriedShareUrl(value: unknown): string | undefined {
  const parsed = carriedShareSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** True when every rule of `permission` is already present in `stored`. */
function rulesetCovers(
  stored: ReadonlyArray<{ permission: string; pattern: string; action: string }>,
  permission: PermissionRuleset
): boolean {
  return permission.every(rule =>
    stored.some(
      entry =>
        entry.permission === rule.permission &&
        entry.pattern === rule.pattern &&
        entry.action === rule.action
    )
  );
}

/**
 * What a session read says about a ruleset the caller wants to apply. The
 * record's own state decides: a `foreign` record is not this route's session,
 * so an update scoped to this directory does not reach it and it holds none of
 * the rules. `invalid` is a record this route owns whose `permission` is
 * present but is not a ruleset: the rules can be neither compared nor applied,
 * so the caller must fail.
 */
type StoredRuleset = 'holds' | 'invalid' | 'missing';

/**
 * What a session read says about this route's record. A `foreign` record is one
 * that answers 404, names another directory, or is not a session at all: it is
 * not this route's session, and the import re-points or creates it separately.
 * It still carries its own metadata when the read produced one, because the
 * import that re-points it clears that column and this may be the last read
 * that can see the value. `invalid` is a record this route owns whose
 * `permission` is present but is not a ruleset. `permission` is the record's
 * own ruleset, which is the authoritative state of the session: this module is
 * its only writer through the native API.
 */
type StoredRecord =
  | { foreign: true; metadata: Record<string, unknown> | undefined }
  | 'invalid'
  | { permission: PermissionRuleset | undefined; metadata: Record<string, unknown> | undefined };

function isForeignRecord(stored: StoredRecord): stored is Extract<StoredRecord, { foreign: true }> {
  return typeof stored === 'object' && 'foreign' in stored;
}

/** What `stored` says about the ruleset `owed` the caller wants to apply. */
function permissionState(stored: StoredRecord, owed: PermissionRuleset): StoredRuleset {
  if (isForeignRecord(stored)) return 'missing';
  if (stored === 'invalid') return 'invalid';
  if (stored.permission === undefined) return 'missing';
  return rulesetCovers(stored.permission, owed) ? 'holds' : 'missing';
}

/**
 * A record that names the route directory but carries a permission that is not
 * a ruleset cannot have its rules applied, so every path that would prepare
 * from it fails instead of preparing without the rules.
 */
function invalidRecordRuleset(sessionId: string): SessionRulesetNotAppliedError {
  return new SessionRulesetNotAppliedError(
    sessionId,
    new Error(`Session record for ${sessionId} carries a permission that is not a ruleset`)
  );
}

/**
 * A record that does not exist, and a read that answers 404, both read as
 * `foreign`: the caller is free to update, and the update reports the real
 * failure itself. A read that cannot answer fails retryably instead, because
 * reporting it as "the record does not hold these rules" would send a second
 * copy of an unmatched ruleset: the native update appends rules, so a duplicate
 * grant stays.
 *
 * A caller abort keeps its own classification, as it does in the create path:
 * the marker is intact, so the route must keep its retry budget instead of a
 * permanent ruleset failure. The abort is checked in the failure path, before
 * the retryable wrap, so an aborted step reports its own reason even when the
 * read it interrupted failed for a reason of its own.
 */
async function readStoredRecord(
  sessionId: string,
  directory: string,
  read: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
  signal: AbortSignal | undefined
): Promise<StoredRecord> {
  try {
    const current = await read();
    if (current.response?.status === 404) return { foreign: true, metadata: undefined };
    // The read is unvalidated JSON, so the parts the decision uses are parsed.
    const record = storedSessionSchema.safeParse(
      requireSdkData(current, `Session get for ${sessionId}`)
    );
    // Metadata of the wrong shape reads as absent, as the slug and share do: it
    // carries no authorization decision, so a value the update endpoint cannot
    // take must not fail a route, and the record's own copy is left alone.
    const metadata = sessionMetadataSchema.safeParse(
      record.success ? record.data.metadata : undefined
    );
    // A record under another directory is not this route's session: its rules
    // belong to that directory, and the import re-points it separately. Its
    // metadata is carried all the same, because the import that re-points it
    // clears the column, so a value read here is the last copy of what the
    // record held.
    if (!record.success || !(await sameDirectory(record.data.directory, directory))) {
      return { foreign: true, metadata: metadata.success ? metadata.data : undefined };
    }
    const stored = record.data.permission;
    // The record names this directory, so a permission that is not a ruleset is
    // a record the caller cannot settle: neither "foreign" nor "missing" may be
    // reported, because both would let the route prepare without the rules.
    const permission = stored === undefined ? undefined : parseRuleset(stored);
    if (permission === undefined && stored !== undefined) return 'invalid';
    return { permission, metadata: metadata.success ? metadata.data : undefined };
  } catch (error) {
    const aborted = abortedReason(signal, sessionId, 'Session ruleset read');
    if (aborted !== undefined) throw aborted;
    // The caller sends no update, so a retry reads the record again instead of
    // appending a second copy of the rules.
    throw new SessionRulesetUnverifiedError(sessionId, error);
  }
}

export type DrainSessionErrorKind =
  | 'transient'
  | 'definitive'
  | 'anomalous'
  | 'unclassified'
  | 'quiet_drain';

/**
 * A classified drain failure. Transport-level retry policy reads `kind`; the
 * caller never parses an HTTP status out of the message.
 */
export class DrainSessionError extends Error {
  readonly kind: DrainSessionErrorKind;
  readonly status?: number;

  constructor(
    kind: DrainSessionErrorKind,
    message: string,
    options?: { status?: number; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DrainSessionError';
    this.kind = kind;
    if (options?.status !== undefined) this.status = options.status;
  }
}

export type KiloServerHandle = {
  url: string;
  close: () => void;
};

/**
 * Permission response type.
 */
export type PermissionResponse = 'always' | 'once' | 'reject';

export type NetworkWait = {
  id: string;
  sessionID: string;
  message: string;
  restored: boolean;
};

export type WrapperPty = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
};

export type WrapperPtySize = {
  cols: number;
  rows: number;
};

/**
 * Whether two directory strings name the same place. The native server stores
 * realpath-canonical paths, so a route reached through a symlink or a trailing
 * slash would otherwise never match its own record. A path that no longer
 * resolves falls back to the resolved form of the string itself.
 */
export async function sameDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> => {
    try {
      return await fsp.realpath(value);
    } catch {
      return path.resolve(value);
    }
  };
  const [a, b] = await Promise.all([canonical(left), canonical(right)]);
  return a === b;
}

export type KiloSessionMetadata = { id: string; directory: string; parentID?: string };
export const KILO_ACTIVITY_MESSAGE_LIMIT = 32;
export const KILO_ACTIVITY_DISCOVERY_LIMIT = 1_000;

/**
 * Shape of an event yielded by `subscribeEvents().stream`. The wrapper unwraps
 * the SDK global event envelope before handing events to `connection.ts`, which
 * only reads `type` and `properties`.
 */
export type KiloEvent = {
  type?: string;
  properties?: Record<string, unknown>;
};

type PromptOptions = {
  sessionId: string;
  messageId: string;
  parts?: Array<
    { type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }
  >;
  prompt?: string;
  /** Server-owned context sent as a synthetic text part before the prompt. */
  context?: string;
  variant?: string;
  agent?: string;
  model?: { providerID?: string; modelID: string };
  system?: string;
  tools?: Record<string, boolean>;
  directory?: string;
  signal?: AbortSignal;
};

/**
 * The wrapper's unified kilo client interface.
 * All wrapper modules depend on this type rather than the raw SDK client.
 */
export type WrapperKiloClient = {
  updateCloudAgentMcp: (
    grant: NonNullable<ControlPlaneSessionCredentialsPayload['cloudAgentMcp']>,
    signal?: AbortSignal
  ) => Promise<void>;
  createSession: (opts?: { title?: string }) => Promise<{ id: string }>;
  getSession: (sessionId: string) => Promise<{ id: string }>;
  getSessionDetails: (
    sessionId: string,
    directory: string,
    signal?: AbortSignal
  ) => Promise<KiloSessionMetadata>;
  /** Process-wide metadata discovery; no default directory filter. Fails on truncation. */
  listSessionMetadata: (signal: AbortSignal) => Promise<KiloSessionMetadata[]>;
  /** Bounded recent window; callers must not interpret a partial window as all execution. */
  getRecentSessionMessages: (
    sessionId: string,
    directory: string,
    signal: AbortSignal
  ) => Promise<SessionMessagesResponse2>;
  getSessionMessage: (
    sessionId: string,
    directory: string,
    messageId: string,
    signal: AbortSignal
  ) => Promise<SessionMessagesResponse2[number]>;
  getSuggestions: (directory: string, signal: AbortSignal) => Promise<SuggestionRequest[]>;
  /** Metadata only; never return tool input or output to diagnostics. */
  probeMessagePart?: (
    sessionId: string,
    directory: string,
    messageId: string,
    partId: string,
    signal: AbortSignal
  ) => Promise<{ status: string; outputBytes?: number } | null>;
  ensureSession: (sessionId: string, directory: string, signal?: AbortSignal) => Promise<void>;
  /** Applies a ruleset a committed record still owes, if any. */
  settleOutstandingRuleset: (
    sessionId: string,
    directory: string,
    signal?: AbortSignal
  ) => Promise<void>;
  sendPrompt: (opts: PromptOptions) => Promise<SessionPromptResponse>;
  sendPromptAsync: (opts: PromptOptions) => Promise<void>;
  abortSession: (opts: {
    sessionId: string;
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  /** Direct child sessions forked from one session, for release tree cleanup. */
  children: (opts: {
    sessionId: string;
    directory: string;
    signal?: AbortSignal;
  }) => Promise<Array<{ id: string; directory: string }>>;
  /**
   * Abort a session during release cleanup. A 404 is success: the session is
   * already gone, so there is nothing left to abort.
   */
  abortSessionForCleanup: (opts: {
    sessionId: string;
    directory: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  /** Stops and forgets every background process owned by one session. */
  stopSessionProcesses: (opts: {
    sessionId: string;
    directory: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  drainSession: (opts: {
    sessionId: string;
    directory?: string;
    token?: string;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  summarizeSession: (opts: {
    sessionId: string;
    model: { providerID?: string; modelID: string };
    auto?: boolean;
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  sendCommand: (opts: {
    sessionId: string;
    command: string;
    args?: string;
    messageId?: string;
    agent?: string;
    model?: { providerID?: string; modelID: string };
    variant?: string;
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<SessionCommandResponse>;
  /**
   * Fetch the full slash command catalog from kilo, trimmed to wire shape and
   * bounded to the shared limits. The bound status is returned beside the
   * commands so the client can be told when rows were dropped.
   */
  listCommands: () => Promise<BoundedSlashCommandCatalog>;
  answerPermission: (
    permissionId: string,
    response: PermissionResponse,
    message?: string,
    interactive?: boolean,
    directory?: string,
    signal?: AbortSignal
  ) => Promise<boolean>;
  answerQuestion: (
    questionId: string,
    answers: string[][],
    directory?: string,
    signal?: AbortSignal
  ) => Promise<boolean>;
  rejectQuestion: (
    questionId: string,
    directory?: string,
    signal?: AbortSignal
  ) => Promise<boolean>;
  getSessionStatuses: (
    directory?: string,
    signal?: AbortSignal
  ) => Promise<Record<string, { type: string; [key: string]: unknown }>>;
  getQuestions: (directory?: string, signal?: AbortSignal) => Promise<QuestionRequest[]>;
  getPermissions: (directory?: string, signal?: AbortSignal) => Promise<PermissionRequest[]>;
  getSessionTodos: (sessionID: string, directory?: string, signal?: AbortSignal) => Promise<Todo[]>;
  getSessionDiff: (
    sessionID: string,
    directory?: string,
    signal?: AbortSignal
  ) => Promise<SnapshotFileDiff[]>;
  getNetworkWaits: () => Promise<NetworkWait[]>;
  resumeNetworkWait: (requestID: string) => Promise<boolean>;
  listEffectiveModels: (providerID: string) => Promise<string[]>;
  generateCommitMessage: (opts: {
    path: string;
    signal?: AbortSignal;
  }) => Promise<{ message: string }>;
  createPty: (opts: {
    cwd: string;
    title: string;
    env: Record<string, string>;
  }) => Promise<WrapperPty>;
  resizePty: (ptyId: string, size: WrapperPtySize, directory?: string) => Promise<WrapperPty>;
  deletePty: (ptyId: string, directory?: string) => Promise<boolean>;
  connectPty: (ptyId: string, directory: string) => WebSocket;

  /**
   * Subscribe to kilo events. The stream yields typed events until the abort
   * signal fires or the server closes the stream. Used by connection.ts.
   */
  subscribeEvents: (opts: { signal?: AbortSignal }) => Promise<{
    stream?: AsyncIterable<KiloEvent>;
  }>;
  /** The in-process server URL — for diagnostics */
  readonly serverUrl: string;
  /** The server and its credential; raw requests and sockets must use both. */
  readonly server: KiloServer;
};

export function createWrapperKiloClient(
  sdkClient: SDKClient,
  server: KiloServer,
  workspacePath: string
): WrapperKiloClient {
  const serverUrl = server.url;
  logToFile(`creating wrapper kilo client for ${serverUrl}`);
  const v2Client = createV2Client(kiloClientConfig(server, workspacePath));
  const globalClient = createV2Client(kiloClientConfig(server));

  function promptParameters(opts: PromptOptions) {
    const rawParts =
      opts.parts ?? (opts.prompt ? [{ type: 'text' as const, text: opts.prompt }] : []);
    const parts = [
      ...(opts.context
        ? [{ type: 'text' as const, text: opts.context, synthetic: true as const }]
        : []),
      ...rawParts,
    ];
    return {
      sessionID: opts.sessionId,
      directory: opts.directory ?? workspacePath,
      messageID: opts.messageId,
      parts: parts.map(part =>
        part.type === 'file'
          ? {
              type: 'file' as const,
              mime: part.mime,
              url: part.url,
              ...(part.filename ? { filename: part.filename } : {}),
            }
          : {
              type: 'text' as const,
              text: part.text,
              ...('synthetic' in part ? { synthetic: true as const } : {}),
            }
      ),
      ...(opts.variant ? { variant: opts.variant } : {}),
      ...(opts.model
        ? { model: { providerID: opts.model.providerID ?? 'kilo', modelID: opts.model.modelID } }
        : {}),
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
    };
  }

  /**
   * Rewrites the marker to what the record still owes. The file goes when
   * nothing remains, so a finished session leaves no obligation behind.
   *
   * A rewrite that fails is not a failure: an obligation that was applied is
   * not owed again, and one that was not keeps its marker. The next prepare
   * re-reads that marker and finds the applied state, so it repeats nothing.
   */
  async function writeObligations(sessionId: string, remaining: SessionObligations): Promise<void> {
    try {
      if (remaining.permission === undefined && remaining.metadata === undefined) {
        await forgetSessionObligations(sessionId);
        return;
      }
      await rememberSessionObligations(sessionId, remaining);
    } catch {
      // Ignored: the marker still names the obligation, and the next prepare
      // settles it against the record rather than trusting the marker alone.
    }
  }

  /**
   * Puts back the metadata the native import dropped, and reports whether the
   * record now holds it.
   *
   * The import body cannot carry metadata: the key is accepted and dropped
   * silently, which leaves the column NULL. Metadata holds the session goal the
   * UI shows, so it is restored from the pre-import read. The update replaces
   * the object wholesale, so the whole value goes back. Metadata carries no
   * authorization decision, so a failed restore is logged and reported as owed
   * rather than failing a route whose record the import already committed.
   */
  async function restoreMetadata(
    sessionId: string,
    directory: string,
    metadata: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    try {
      const restoreTimeout = AbortSignal.timeout(8_000);
      const restored = await v2Client.session.update(
        { sessionID: sessionId, directory, metadata },
        { signal: signal ? AbortSignal.any([signal, restoreTimeout]) : restoreTimeout }
      );
      requireSdkData(restored, `Session metadata restore for ${sessionId}`);
      return true;
    } catch (error) {
      // The record is committed and this route may proceed without it. The
      // restored value is user-visible, so the loss is recorded for diagnosis;
      // the detail is the SDK result message, which carries no token, header or
      // record payload. The obligation stays in the marker, so the next prepare
      // tries again instead of losing the value for good.
      const detail = error instanceof Error ? error.message : String(error);
      logToFile(`session ${sessionId}: metadata restore did not complete: ${detail}`);
      return false;
    }
  }

  /**
   * Restores the metadata obligation and reports what the marker must keep:
   * `{ metadata }` when the restore failed, `{}` when the record already
   * carries a value or the restore succeeded.
   *
   * The record's own value wins, the same rule the permission side follows: the
   * record is the state of the session and the marker is only a durable copy.
   * The update replaces the whole value and the server normalizes what it
   * stores, so the copy the marker holds can never byte-match a record whose
   * goal was normalized, and it can be older than a goal the native CLI or web
   * surface wrote in the meantime. Writing it back would revert the user's own
   * goal, so the wrapper supplies a value only where the import left the record
   * empty. Metadata carries no authorization decision, so a value that cannot be
   * restored is owed again rather than failing the route.
   */
  async function settleMetadata(
    sessionId: string,
    directory: string,
    current: Record<string, unknown> | undefined,
    obligations: SessionObligations,
    signal: AbortSignal | undefined
  ): Promise<SessionObligations> {
    const owed = obligations.metadata;
    if (owed === undefined || current !== undefined) return {};
    return (await restoreMetadata(sessionId, directory, owed, signal)) ? {} : { metadata: owed };
  }

  return {
    serverUrl,
    server,
    updateCloudAgentMcp: async (grant, signal) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        try {
          const result = await v2Client.mcp.add(
            {
              directory: workspacePath,
              name: 'kilo-cloud-agent',
              config: {
                type: 'remote',
                url: grant.url,
                oauth: false,
                headers: { Authorization: `Bearer ${grant.token}` },
              },
            },
            { signal }
          );
          if (!result.error && result.data?.['kilo-cloud-agent']?.status === 'connected') return;
        } catch {
          signal?.throwIfAborted();
        }
      }
      throw new Error('Cloud Agent MCP credential refresh failed');
    },

    subscribeEvents: async opts => {
      const result = await v2Client.global.event({ signal: opts.signal });
      return {
        stream: result.stream ? globalFeedPayloads(result.stream, workspacePath) : undefined,
      };
    },

    createSession: async opts => {
      const result = await sdkClient.session.create({
        body: { title: opts?.title },
        query: { directory: workspacePath },
      });
      const data = requireSdkData(result, 'Session create');
      return { id: data.id };
    },

    getSession: async sessionId => {
      const result = await sdkClient.session.get({
        path: { id: sessionId },
        query: { directory: workspacePath },
      });
      const data = requireSdkData(result, `Session get for ${sessionId}`);
      return { id: data.id };
    },

    getSessionDetails: async (sessionId, directory, signal) => {
      const result = await v2Client.session.get({ sessionID: sessionId, directory }, { signal });
      const data = requireSdkData(result, 'Session cleanup lookup');
      if (data.id !== sessionId || data.directory !== directory) {
        throw new Error('Session cleanup lookup returned an invalid session');
      }
      return {
        id: data.id,
        directory: data.directory,
        ...(data.parentID ? { parentID: data.parentID } : {}),
      };
    },

    listSessionMetadata: async signal => {
      // The timestamp-only pagination cursor can skip equal-timestamp rows. Require
      // a complete bounded page rather than silently missing an execution directory.
      const result = await globalClient.experimental.session.list(
        { limit: KILO_ACTIVITY_DISCOVERY_LIMIT, archived: true },
        { signal }
      );
      const sessions = requireSdkData(result, 'Activity session discovery');
      if (result.response?.headers.has('x-next-cursor')) {
        throw new Error('Activity session discovery exceeded its bounded complete window');
      }
      return sessions.map(({ id, directory, parentID }) => ({
        id,
        directory,
        ...(parentID ? { parentID } : {}),
      }));
    },

    getRecentSessionMessages: async (sessionId, directory, signal) => {
      const result = await v2Client.session.messages(
        { sessionID: sessionId, directory, limit: KILO_ACTIVITY_MESSAGE_LIMIT },
        { signal }
      );
      return requireSdkData(result, 'Activity session messages');
    },

    getSessionMessage: async (sessionId, directory, messageId, signal) => {
      const result = await v2Client.session.message(
        { sessionID: sessionId, directory, messageID: messageId },
        { signal }
      );
      return requireSdkData(result, 'Activity session message');
    },

    getSuggestions: async (directory, signal) => {
      const result = await v2Client.suggestion.list({ directory }, { signal });
      return requireSdkData(result, 'Activity suggestions');
    },

    probeMessagePart: async (sessionId, directory, messageId, partId, signal) => {
      const result = await v2Client.session.message(
        { sessionID: sessionId, messageID: messageId, directory },
        { signal }
      );
      if (result.response?.status === 404) return null;
      const message = requireSdkData(result, 'Session message probe');
      const part = message.parts.find(item => item.id === partId);
      if (part?.type !== 'tool') return null;
      return {
        status: part.state.status,
        ...(part.state.status === 'completed'
          ? { outputBytes: Buffer.byteLength(part.state.output, 'utf8') }
          : {}),
      };
    },

    ensureSession: async (sessionId, directory, signal) => {
      // The caller records the obligation before the import commits the row, so
      // a transient failure on this second call is retried here: the enclosing
      // step retry would find the record in place and return early.
      const applyRuleset = async (
        permission: PermissionRuleset,
        keep: SessionObligations
      ): Promise<void> => {
        const attemptOnce = async () => {
          const restoreTimeout = AbortSignal.timeout(8_000);
          const restored = await v2Client.session.update(
            { sessionID: sessionId, directory, permission },
            { signal: signal ? AbortSignal.any([signal, restoreTimeout]) : restoreTimeout }
          );
          requireSdkData(restored, `Session permission restore for ${sessionId}`);
        };
        // A marker that cannot be rewritten is retried by the next prepare,
        // whose check finds the stored rules and does not duplicate them.
        const settleMarker = () => writeObligations(sessionId, keep);
        const settled = async () => {
          const readTimeout = AbortSignal.timeout(8_000);
          const stored = await readStoredRecord(
            sessionId,
            directory,
            () =>
              v2Client.session.get(
                { sessionID: sessionId, directory },
                { signal: signal ? AbortSignal.any([signal, readTimeout]) : readTimeout }
              ),
            signal
          );
          return permissionState(stored, permission);
        };
        const state = await settled();
        if (state === 'holds') {
          await settleMarker();
          return;
        }
        // A record this route owns whose permission is not a ruleset cannot have
        // the rules compared or applied, so the route fails instead of updating
        // it and leaving the marker cleared.
        if (state === 'invalid') throw invalidRecordRuleset(sessionId);
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await attemptOnce();
            await settleMarker();
            return;
          } catch (error) {
            lastError = error;
            if (signal?.aborted) break;
            // A failed attempt may still have applied the update, so check the
            // record before repeating it and never store the ruleset twice.
            const recheck = await settled();
            if (recheck === 'holds') {
              await settleMarker();
              return;
            }
            // A record that now reads as carrying a permission which is not a
            // ruleset must not be updated again: the marker stays and the route
            // fails the same way the create path does.
            if (recheck === 'invalid') throw invalidRecordRuleset(sessionId);
            if (attempt < 3) {
              const { promise, resolve } = Promise.withResolvers<void>();
              setTimeout(resolve, 50 * attempt);
              await promise;
            }
          }
        }
        // The record is already in place, so a step retry would reuse it and
        // skip this call. The outstanding entry makes the next prepare apply
        // the ruleset instead of accepting the record as complete.
        //
        // The step budget aborted this signal, so the route keeps that
        // classification and its retry budget instead of reporting a permanent
        // ruleset failure. The marker stays, so the next prepare applies it.
        const aborted = abortedReason(signal, sessionId, 'Session ruleset apply');
        if (aborted !== undefined) throw aborted;
        throw new SessionRulesetNotAppliedError(sessionId, lastError);
      };
      const lookupTimeout = AbortSignal.timeout(5_000);
      const lookupSignal = signal ? AbortSignal.any([signal, lookupTimeout]) : lookupTimeout;
      const existing = await v2Client.session.get(
        { sessionID: sessionId, directory },
        { signal: lookupSignal }
      );
      // A record outside this directory is not this route's session. The
      // native import re-points a record it already holds only when the caller
      // sets `force`, so the mismatch case sets it and the absent case does not.
      const record =
        existing.response?.status === 404
          ? undefined
          : requireSdkData(existing, `Session get for ${sessionId}`);
      // The record read is unvalidated JSON, so the ruleset it names is parsed
      // before anything compares or applies it.
      const recordRuleset =
        record?.permission === undefined ? undefined : parseRuleset(record.permission);
      if (record) {
        if (record.id !== sessionId) {
          throw new Error(`Session get for ${sessionId} returned an invalid session`);
        }
        if (
          typeof record.directory === 'string' &&
          (await sameDirectory(record.directory, directory))
        ) {
          // A record that still owes an obligation is not complete: settle it
          // before the route is reused instead of returning as if it were.
          const obligations = await readSessionObligations(sessionId);
          if (obligations === undefined) return;
          // A record that carries permission data which is not a ruleset cannot
          // have its rules applied, so the route fails instead of preparing
          // without them.
          if (record.permission !== undefined && recordRuleset === undefined) {
            throw invalidRecordRuleset(sessionId);
          }
          // The record's own permission is the authenticated state of the
          // session, because this module is its only writer through the native
          // API; the marker is a durable copy taken because the import clears
          // the row, so a marker rule the record does not carry is not applied.
          const owed = recordRuleset ?? obligations.permission;
          // The metadata is already back when the record carries it, so only a
          // record without it receives the owed value. A record whose metadata
          // is not the shape the update endpoint takes reads as absent, so the
          // owed value is sent rather than compared against bytes that cannot
          // answer.
          const currentMetadata = sessionMetadataSchema.safeParse(record.metadata);
          const remaining = await settleMetadata(
            sessionId,
            directory,
            currentMetadata.success ? currentMetadata.data : undefined,
            obligations,
            signal
          );
          if (owed !== undefined) await applyRuleset(owed, remaining);
          else await writeObligations(sessionId, remaining);
          return;
        }
      }
      const currentProject = await v2Client.project.current(
        { directory },
        { signal: lookupSignal }
      );
      const project = requireSdkData(currentProject, `Current project for session ${sessionId}`);
      if (typeof project.id !== 'string' || project.id.length === 0) {
        throw new Error(`Current project for session ${sessionId} returned an invalid project`);
      }
      const now = Date.now();
      const importTimeout = AbortSignal.timeout(8_000);
      // A record that carries permission data which is not a ruleset cannot have
      // its rules applied, so the route fails instead of preparing without them.
      if (record?.permission !== undefined && recordRuleset === undefined) {
        throw invalidRecordRuleset(sessionId);
      }
      // The record's own permission is the authenticated state of the session,
      // because this module is its only writer through the native API; the
      // marker is a durable copy taken because the import clears the row, so a
      // marker rule the record does not carry is not applied.
      const remembered = await readSessionObligations(sessionId);
      const owed = recordRuleset ?? remembered?.permission;
      // The import drops the metadata column, so only a record that carries one
      // of the shape the update endpoint takes has a metadata obligation.
      const carriedMetadata = sessionMetadataSchema.safeParse(record?.metadata);
      const recordMetadata = carriedMetadata.success ? carriedMetadata.data : undefined;
      // A metadata obligation the marker already holds is still owed when the
      // record this route re-points carries none: it was read from this
      // session's own record before an earlier import dropped the column, and
      // this route is the only one that can put it back.
      const metadataObligation = recordMetadata ?? remembered?.metadata;
      // A marker that holds a rule this record does not carry is superseded, and
      // it must not outlive the import: the import clears the record's
      // permission, so after it commits the marker is the only rules a prepare
      // can read, and a settle would turn the superseded rule into a grant the
      // record never held. It is rewritten to the owed set before the import,
      // and a rewrite that fails fails the route retryably with the record
      // still untouched, so the retried prepare narrows the same marker again.
      //
      // A marker whose metadata is not the record's own is stale for the same
      // reason and is rewritten in the same write: the import clears the
      // column, so a later settle restores whatever the marker holds, and a copy
      // older than the record would put a superseded goal back.
      const superseded =
        (recordRuleset !== undefined &&
          remembered?.permission !== undefined &&
          !rulesetCovers(recordRuleset, remembered.permission)) ||
        (recordMetadata !== undefined &&
          remembered?.metadata !== undefined &&
          stableJson(recordMetadata) !== stableJson(remembered.metadata));
      if (superseded) {
        try {
          // `owed` rather than `recordRuleset`: the two are the same value when
          // the record carries one, and when it does not the marker's permission
          // is the obligation a later settle must still apply, so it stays.
          await rememberSessionObligations(sessionId, {
            ...(owed === undefined ? {} : { permission: owed }),
            ...(metadataObligation === undefined ? {} : { metadata: metadataObligation }),
          });
        } catch (error) {
          throw new SessionRulesetUnverifiedError(sessionId, error);
        }
      }
      // The obligation is already durable when the marker covers what the record
      // carries, so it is not rewritten: a directory that refuses the write must
      // not fail a route whose obligations are already recorded. A marker that
      // already names a metadata value is durable whatever its bytes, because
      // `superseded` above rewrites it whenever the record carries a different
      // one, so reaching here means the marker is the newest copy available.
      const durable =
        (owed === undefined ||
          (remembered?.permission !== undefined && rulesetCovers(remembered.permission, owed))) &&
        (metadataObligation === undefined || remembered?.metadata !== undefined);
      if (!superseded && (owed !== undefined || metadataObligation !== undefined) && !durable) {
        // The import replaces the record and drops both values, so the
        // obligation must be stored before the import commits the row.
        await rememberSessionObligations(sessionId, {
          ...(owed === undefined ? {} : { permission: owed }),
          ...(metadataObligation === undefined ? {} : { metadata: metadataObligation }),
        });
      }
      // The record read is unvalidated JSON. The record's slug names the share
      // URL it carries, so a re-point carries that slug instead of renaming the
      // record and leaving the share URL naming the old one.
      const shareURL = carriedShareUrl(record?.share);
      const imported = await v2Client.kilocode.sessionImport.session(
        {
          query_directory: directory,
          body_directory: directory,
          id: sessionId,
          projectID: project.id,
          // A re-pointed record keeps the fields it already carries.
          slug: carriedSlug(record?.slug) ?? sessionId.slice(0, 24),
          title: record?.title ?? 'New session - ' + new Date(now).toISOString(),
          version: KILO_CLI_VERSION,
          ...(record ? { force: true } : {}),
          ...(record?.workspaceID === undefined ? {} : { workspaceID: record.workspaceID }),
          ...(record?.parentID === undefined ? {} : { parentID: record.parentID }),
          ...(shareURL === undefined ? {} : { shareURL }),
          ...(record?.summary === undefined ? {} : { summary: record.summary }),
          ...(record?.revert === undefined ? {} : { revert: record.revert }),
          timeCreated: record?.time?.created ?? now,
          timeUpdated: record?.time?.updated ?? now,
          ...(record?.time?.compacting === undefined
            ? {}
            : { timeCompacting: record.time.compacting }),
          ...(record?.time?.archived === undefined ? {} : { timeArchived: record.time.archived }),
        },
        { signal: signal ? AbortSignal.any([signal, importTimeout]) : importTimeout }
      );
      const data = requireSdkData(imported, `Session import for ${sessionId}`);
      if (!data.ok || data.id !== sessionId) {
        throw new Error(`Session import for ${sessionId} returned an invalid session`);
      }
      // The import body types `permission` as a string map, while a record
      // carries a ruleset, so the ruleset is applied through the update
      // endpoint that accepts it. The read is unvalidated JSON, so check the
      // shape before applying it. The import has already committed the record,
      // so a transient failure here must not leave a route that prepares
      // without the record's rules; retry within this call, because the step
      // retry above would find the record in place and return before reaching
      // this point again.
      //
      // The metadata goes back first. A ruleset that cannot be applied throws,
      // and the next prepare settles the marker without calling this function
      // again, so a restore placed after it would never run. This one swallows
      // its own failure, so moving it first changes no error precedence.
      //
      // A failed restore keeps its obligation in the marker: the import has
      // already committed the record and this route proceeds without it, but
      // the next prepare retries the value instead of losing it for good.
      const remaining = await settleMetadata(
        sessionId,
        directory,
        undefined,
        { metadata: metadataObligation },
        signal
      );
      if (owed !== undefined) await applyRuleset(owed, remaining);
      else await writeObligations(sessionId, remaining);
    },

    settleOutstandingRuleset: async (sessionId, directory, signal) => {
      const obligations = await readSessionObligations(sessionId);
      if (obligations === undefined) return;
      const readTimeout = AbortSignal.timeout(8_000);
      const read = () =>
        v2Client.session.get(
          { sessionID: sessionId, directory },
          { signal: signal ? AbortSignal.any([signal, readTimeout]) : readTimeout }
        );
      // The record is read once for both obligations: the settle needs to know
      // which directory the record names and which permission it carries before
      // choosing what to compare.
      const stored = await readStoredRecord(sessionId, directory, read, signal);
      // A record under another directory belongs to that directory until the
      // import re-points it, and an absent record has nothing to apply to, so
      // the marker keeps every obligation for the create path in both cases.
      //
      // The metadata such a record still carries is copied into the marker
      // first, because the import the restore runs clears the column: this read
      // is the last that can see the record's own goal, and the settle after the
      // restore has nothing else to put back. That holds whether or not the
      // marker already owes a metadata value: a marker owing only a ruleset
      // would otherwise lose the record's goal entirely once the import commits.
      // Only the metadata is rewritten: the permission obligation stays for the
      // create path exactly as it is, and a marker write that fails is swallowed
      // as everywhere else here, so it never fails the route.
      if (isForeignRecord(stored)) {
        if (
          stored.metadata !== undefined &&
          stableJson(stored.metadata) !== stableJson(obligations.metadata)
        ) {
          await writeObligations(sessionId, { ...obligations, metadata: stored.metadata });
        }
        return;
      }
      // A record that names this directory but carries a permission which is not
      // a ruleset cannot have the rules applied, so the route fails the way the
      // create path does. The record is left unchanged, so the marker stays and
      // the next prepare fails the same way instead of preparing without them.
      if (stored === 'invalid') throw invalidRecordRuleset(sessionId);
      // The metadata obligation is retried on every prepare, because a lost
      // restore is not observable anywhere else. The wrapper writes only where
      // the import left the record empty, because a record that carries a value
      // may carry a newer one. A failure keeps the obligation and does not fail
      // the route: metadata carries no authorization decision.
      const remaining = await settleMetadata(
        sessionId,
        directory,
        stored.metadata,
        obligations,
        signal
      );
      // The record's own permission is the authenticated state of the session,
      // because this module is its only writer through the native API; the
      // marker is a durable copy taken because the import clears the row, so a
      // marker rule the record does not carry is not applied. Reading the record
      // before choosing what to compare is what stops a marker kept after a
      // failed apply from ever widening the grants.
      const owed = stored.permission ?? obligations.permission;
      if (owed === undefined) {
        await writeObligations(sessionId, remaining);
        return;
      }
      // A record that already holds the rules is not updated again, because the
      // update appends them; the permission obligation is dropped instead. A
      // marker that cannot be rewritten is retried by the next prepare, which
      // then finds the stored rules and does not duplicate them.
      //
      // A failed apply here fails retryably, because the marker is intact and
      // the retried step reads the same marker and can apply it again; the
      // record is left without the rules, so the create path's permanent class
      // does not apply.
      if (permissionState(stored, owed) !== 'holds') {
        try {
          const restoreTimeout = AbortSignal.timeout(8_000);
          const restored = await v2Client.session.update(
            { sessionID: sessionId, directory, permission: owed },
            { signal: signal ? AbortSignal.any([signal, restoreTimeout]) : restoreTimeout }
          );
          requireSdkData(restored, `Session permission restore for ${sessionId}`);
        } catch (error) {
          // The step budget aborted this signal, so the route keeps that
          // classification and its retry budget instead of a ruleset failure
          // nothing will retry. The marker stays, so the next prepare applies it.
          const aborted = abortedReason(signal, sessionId, 'Session ruleset apply');
          if (aborted !== undefined) throw aborted;
          throw new SessionRulesetUnverifiedError(sessionId, error);
        }
      }
      await writeObligations(sessionId, remaining);
    },

    sendPrompt: async opts => {
      const result = await v2Client.session.prompt(promptParameters(opts), { signal: opts.signal });
      return requireSdkData(result, `Prompt for session ${opts.sessionId}`);
    },

    sendPromptAsync: async opts => {
      const result = await v2Client.session.promptAsync(promptParameters(opts), {
        signal: opts.signal,
      });
      if (result.error !== undefined) {
        throw new Error(
          `Async prompt for session ${opts.sessionId} failed: ${formatSdkError(result)}`,
          { cause: result.error }
        );
      }
    },

    abortSession: async opts => {
      const result = await v2Client.session.abort(
        { sessionID: opts.sessionId, directory: opts.directory ?? workspacePath, scope: 'tree' },
        { signal: opts.signal }
      );
      const operation = `Session abort for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (typeof data !== 'boolean') {
        throw new Error(`${operation} returned no boolean result`);
      }
      return data;
    },

    children: async opts => {
      const result = await v2Client.session.children(
        { sessionID: opts.sessionId, directory: opts.directory },
        { signal: opts.signal }
      );
      const data = requireSdkData(result, `Session children for ${opts.sessionId}`);
      return z.array(sessionChildSchema).parse(data);
    },

    abortSessionForCleanup: async opts => {
      const result = await v2Client.session.abort(
        { sessionID: opts.sessionId, directory: opts.directory },
        { signal: opts.signal }
      );
      // A missing session is already aborted; do not retry a 404.
      if (result.response?.status === 404) return;
      const operation = `Cleanup abort for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (data !== true) {
        throw new Error(`${operation} returned no boolean result`);
      }
    },

    stopSessionProcesses: async opts => {
      const result = await v2Client.backgroundProcess.stopSession(
        { sessionID: opts.sessionId, directory: opts.directory },
        { signal: opts.signal }
      );
      const operation = `Stop session processes for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (data !== true) {
        throw new Error(`${operation} returned no boolean result`);
      }
    },

    drainSession: async opts => {
      let result: Awaited<ReturnType<typeof v2Client.kilocode.drainSession>>;
      try {
        result = await v2Client.kilocode.drainSession(
          {
            sessionID: opts.sessionId,
            directory: opts.directory ?? workspacePath,
            token: opts.token ?? crypto.randomUUID(),
          },
          { signal: opts.signal, throwOnError: false }
        );
      } catch (error) {
        if (opts.signal?.aborted) {
          if (error instanceof Error) throw error;
          throw new DOMException('Aborted', 'AbortError');
        }
        throw new DrainSessionError('unclassified', 'protocol error', { cause: error });
      }
      const status: number | undefined = result.response?.status;
      if (opts.signal?.aborted) {
        if (result.error instanceof Error) throw result.error;
        throw new DOMException('Aborted', 'AbortError');
      }
      if (result.error !== undefined) {
        if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
          throw new DrainSessionError('transient', `HTTP ${status}`, {
            status,
            cause: result.error,
          });
        }
        if (status !== undefined && status >= 400 && status < 500) {
          throw new DrainSessionError('definitive', `HTTP ${status}`, {
            status,
            cause: result.error,
          });
        }
        if (result.response === undefined) {
          throw new DrainSessionError('transient', 'request error', { cause: result.error });
        }
        throw new DrainSessionError('unclassified', 'protocol error', { cause: result.error });
      }
      if (status === 204 || typeof result.data !== 'boolean') {
        throw new DrainSessionError('anomalous', 'returned no boolean result');
      }
      if (result.data === false) {
        throw new DrainSessionError('anomalous', 'Session drain returned false');
      }
      return result.data;
    },

    summarizeSession: async opts => {
      const result = await v2Client.session.summarize(
        {
          sessionID: opts.sessionId,
          directory: opts.directory ?? workspacePath,
          providerID: opts.model.providerID ?? 'kilo',
          modelID: opts.model.modelID,
          ...(opts.auto !== undefined ? { auto: opts.auto } : {}),
        },
        { signal: opts.signal }
      );
      const operation = `Session summarize for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (typeof data !== 'boolean') {
        throw new Error(`${operation} returned no boolean result`);
      }
      return data;
    },

    sendCommand: async opts => {
      const result = await v2Client.session.command(
        {
          sessionID: opts.sessionId,
          directory: opts.directory ?? workspacePath,
          command: opts.command,
          arguments: opts.args ?? '',
          ...(opts.messageId !== undefined ? { messageID: opts.messageId } : {}),
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.model
            ? { model: `${opts.model.providerID ?? 'kilo'}/${opts.model.modelID}` }
            : {}),
          ...(opts.variant ? { variant: opts.variant } : {}),
        },
        { signal: opts.signal }
      );
      return requireSdkData(result, `Command for session ${opts.sessionId}`);
    },

    listCommands: async () => {
      const result = await sdkClient.command.list({ query: { directory: workspacePath } });
      const raw = requireSdkData(result, 'Command list');
      const commands: SlashCommandInfo[] = [];
      for (const item of raw) {
        const trimmed = toSlashCommandInfo(item);
        // Skill-sourced rows stay in the catalog: the mobile composer lists
        // and invokes them like any other command. The CLI reports a skill
        // only when it is available to this session, so keeping every reported
        // row never un-hides an unavailable skill.
        if (trimmed) commands.push(trimmed);
      }
      // Bound the catalog the same way the remote catalog is bounded. The
      // bound drops non-skill rows first and never truncates a skill row; a
      // full catalog carries its status to the client rather than hiding
      // skills silently.
      const bounded = boundSlashCommandCatalog(commands);
      if (bounded.dropped > 0 || bounded.overLimit) {
        logToFile(
          bounded.overLimit
            ? `slash command catalog over limit: kept all ${bounded.commands.length} rows (skill rows are never truncated), dropped ${bounded.dropped}`
            : `slash command catalog full: dropped ${bounded.dropped} non-skill rows, kept ${bounded.commands.length}`
        );
      }
      return bounded;
    },

    answerPermission: async (
      permissionId,
      response,
      message,
      interactive,
      directory = workspacePath,
      signal
    ) => {
      const result = await v2Client.permission.reply(
        { requestID: permissionId, directory, reply: response, message, interactive },
        { signal }
      );
      return requireSdkData(result, `Permission reply ${permissionId}`);
    },

    answerQuestion: async (questionId, answers, directory = workspacePath, signal) => {
      const result = await v2Client.question.reply(
        { requestID: questionId, answers, directory },
        { signal }
      );
      return requireSdkData(result, `Question reply ${questionId}`);
    },

    rejectQuestion: async (questionId, directory = workspacePath, signal) => {
      const result = await v2Client.question.reject(
        { requestID: questionId, directory },
        { signal }
      );
      return requireSdkData(result, `Question reject ${questionId}`);
    },

    getSessionStatuses: async (directory = workspacePath, signal) => {
      const result = await v2Client.session.status({ directory }, { signal });
      const parsed = sessionStatusesSchema.safeParse(requireSdkData(result, 'Session status'));
      if (!parsed.success) throw new Error('Session status returned an invalid map');
      return parsed.data;
    },

    getQuestions: async (directory = workspacePath, signal) => {
      const result = await v2Client.question.list({ directory }, { signal });
      return requireSdkData(result, 'Question list');
    },

    getPermissions: async (directory = workspacePath, signal) => {
      const result = await v2Client.permission.list({ directory }, { signal });
      return requireSdkData(result, 'Permission list');
    },

    getSessionTodos: async (sessionID, directory = workspacePath, signal) => {
      const result = await v2Client.session.todo({ sessionID, directory }, { signal });
      return requireSdkData(result, `Session todo ${sessionID}`);
    },

    getSessionDiff: async (sessionID, directory = workspacePath, signal) => {
      const result = await v2Client.session.diff({ sessionID, directory }, { signal });
      return requireSdkData(result, `Session diff ${sessionID}`);
    },

    getNetworkWaits: async () => {
      const result = await v2Client.network.list({ directory: workspacePath });
      return requireSdkData(result, 'Network list');
    },

    resumeNetworkWait: async requestID => {
      const result = await v2Client.network.reply({ requestID, directory: workspacePath });
      return requireSdkData(result, `Network reply ${requestID}`);
    },

    listEffectiveModels: async providerID => {
      const result = await v2Client.config.providers({
        directory: workspacePath,
        workspace: workspacePath,
      });
      const data = requireSdkData<unknown>(result, 'Config providers');
      return exactDedupedModelKeys(data, providerID);
    },

    generateCommitMessage: async opts => {
      const result = await v2Client.commitMessage.generate(
        { path: opts.path, directory: workspacePath },
        { signal: opts.signal }
      );
      return requireSdkData(result, 'Commit message generation');
    },

    createPty: async opts => {
      const result = await v2Client.pty.create({
        directory: opts.cwd,
        cwd: opts.cwd,
        title: opts.title,
        env: opts.env,
      });
      return requireSdkData(result, 'PTY create');
    },

    resizePty: async (ptyId, size, directory = workspacePath) => {
      const result = await v2Client.pty.update({
        ptyID: ptyId,
        directory,
        size,
      });
      return requireSdkData(result, `PTY update for ${ptyId}`);
    },

    deletePty: async (ptyId, directory = workspacePath) => {
      const result = await v2Client.pty.remove({
        ptyID: ptyId,
        directory,
      });
      return requireSdkData(result, `PTY delete for ${ptyId}`);
    },
    connectPty: (ptyId, directory) => {
      const url = new URL(`/pty/${encodeURIComponent(ptyId)}/connect`, server.url);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.search = '';
      url.hash = '';
      url.searchParams.set('directory', directory);
      const Socket = WebSocket as typeof WebSocket & {
        new (url: string, options: { headers: Record<string, string> }): WebSocket;
      };
      return new Socket(url.toString(), { headers: kiloServerHeaders(server) });
    },
  };
}
