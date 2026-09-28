/**
 * Framing, matcher and bounded tail readers for cloud-agent-next
 * `sandbox_control` diagnostics.
 *
 * This module scrapes two production-owned log contracts:
 * `src/persistence/SandboxControl.ts` writes the `allocation_transition` line per
 * committed allocation/health transition, and the provider adapters
 * (`cloudflare-provider.ts`, `vercel-provider.ts`) write `native_stop`. Keep
 * `LOG_FIELD_KEYS` and the event/field expectations below in sync with those
 * emitters; a production field rename surfaces here as a missing-evidence
 * timeout, not a compile error.
 *
 * Only the local Docker profile uses the tail readers: they read the local
 * `dev/logs/cloud-agent-next.log` file and return framed records for
 * identity-correlated evidence. The deployed profile never calls them.
 */

import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogRecord = Record<string, unknown>;

export const CLOUD_AGENT_LOG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'dev/logs/cloud-agent-next.log'
);
const IDLE_LOG_READ_CHUNK_BYTES = 256 * 1024;
const MAX_FRAMED_LOG_OBJECT_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseLogValue(value: string): string | number | boolean | undefined {
  const trimmed = value.trim().replace(/,$/, '');
  if (!trimmed) return undefined;
  if (trimmed === 'undefined' || trimmed === 'null') return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const body = trimmed.slice(1, -1);
    return body.replace(/\\([\\'"\nrt])/g, (_match, escaped: string) => {
      if (escaped === 'n') return '\n';
      if (escaped === 'r') return '\r';
      if (escaped === 't') return '\t';
      return escaped;
    });
  }
  return trimmed;
}

const LOG_FIELD_KEYS = [
  'diagnosticEvent',
  'allocationId',
  'allocationName',
  'physicalSandboxId',
  'sandboxId',
  'wrapperInstanceId',
  'connectionId',
  // Control-socket recycle correlation (`socket_request_sent`, `socket_closed`,
  // `handshake_committed`, `wrapper_ready`) and the attach-window oracle
  // (`socket_response`): the dispatched operation, the closed socket's handshake
  // state, and the request the response answers.
  'operation',
  'handshakeComplete',
  'requestId',
  // Accepted-reconciliation identity emitted by the accepted-alarm diagnostic
  // (`SandboxSession` accepted-message watchdog): the emitting `sessionId`,
  // `messageId`, and `expectedWrapperInstanceId`.
  'messageId',
  'sessionId',
  'expectedWrapperInstanceId',
  // Canonical allocation-transition fields (`allocation_transition`).
  'aggregate',
  'from',
  'to',
  'event',
  'deadline',
  'at',
  'incarnation',
  'reason',
  // Provider correlation fields on the adapter's `native_stop` record.
  'provider',
  'providerSessionId',
  'result',
  'deadlineAt',
  'latenessMs',
  'time',
  'logTag',
  // Heartbeat-lapse snapshot fields emitted by `heartbeatLogFields`. Wrangler's
  // local logger can pretty-print these records, so the fallback parser must
  // know each key.
  'lastReceivedHeartbeatAt',
  'lastAcceptedHeartbeatAt',
  'armedAt',
  'armedExpiryAt',
  'heartbeatArmedBasis',
  'lastDecision',
  'observationConnectionId',
  'observationWrapperInstanceId',
  // Heartbeat payload summary fields (used to capture the question-idle pin).
  'reportedState',
  'pendingMessages',
  'reportedSessions',
  'activeKiloSessions',
  'inputWaitingRoutes',
  // Per-session heartbeat payload fields emitted by `heartbeatSessionFields`.
  'decision',
  'kiloSessionId',
  'sessionState',
  'sessionWaitingOn',
  'sessionReport',
] as const;

function parseLogRecord(text: string): LogRecord | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Wrangler's local logger pretty-prints JavaScript object literals. Do
    // not evaluate that text: extract only the bounded scalar fields needed by
    // this diagnostic after the object has already been framed.
    const fields: LogRecord = {};
    for (const key of LOG_FIELD_KEYS) {
      const match = trimmed.match(
        new RegExp(`\\b${key}\\s*[:=]\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,}]+)`)
      );
      const value = match?.[1] === undefined ? undefined : parseLogValue(match[1]);
      if (value !== undefined) fields[key] = value;
    }
    return Object.keys(fields).length > 0 ? fields : null;
  }
}

type LogRecordFramer = {
  push: (chunk: string) => LogRecord[];
  finish: () => LogRecord[];
};

/**
 * Frame complete logger objects from a byte-decoded stream. Wrangler's local
 * records are pretty-printed over many physical lines, while other logger
 * versions emit one JSON object per line. Braces inside quoted strings are
 * ignored, so a prefix such as `[wrangler:info]` is harmless and no arbitrary
 * text is evaluated.
 */
export function createLogRecordFramer(): LogRecordFramer {
  let object = '';
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let discardUntilLineEnd = false;

  const reset = (): void => {
    object = '';
    depth = 0;
    quote = undefined;
    escaped = false;
  };

  const push = (chunk: string): LogRecord[] => {
    const records: LogRecord[] = [];
    for (const character of chunk) {
      if (discardUntilLineEnd) {
        if (character === '\n') discardUntilLineEnd = false;
        continue;
      }
      if (depth === 0) {
        if (character !== '{') continue;
        object = character;
        depth = 1;
        quote = undefined;
        escaped = false;
        continue;
      }

      object += character;
      if (object.length > MAX_FRAMED_LOG_OBJECT_BYTES) {
        reset();
        discardUntilLineEnd = true;
        continue;
      }
      if (quote !== undefined) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const record = parseLogRecord(object);
          if (record) records.push(record);
          reset();
        }
      }
    }
    return records;
  };

  return {
    push,
    finish: () => {
      // A complete object is emitted by push as soon as its closing brace is
      // seen. Incomplete text is intentionally discarded at EOF.
      return [];
    },
  };
}

/** Parse complete records from arbitrary chunk boundaries (used by unit tests). */
export function parseFramedLogRecords(chunks: Iterable<string>): LogRecord[] {
  const framer = createLogRecordFramer();
  const records: LogRecord[] = [];
  for (const chunk of chunks) records.push(...framer.push(chunk));
  records.push(...framer.finish());
  return records;
}

function recordLogTag(record: LogRecord): unknown {
  if (record.logTag !== undefined) return record.logTag;
  const tags = record.tags;
  return isRecord(tags) ? tags.logTag : undefined;
}

function isIdleStopCause(value: unknown): boolean {
  return typeof value === 'string' && /^(?:idle|idle[_-]stop)$/i.test(value);
}

function recordTime(record: LogRecord, fallback: number): number {
  if (typeof record.time === 'number' && Number.isFinite(record.time)) return record.time;
  if (typeof record.time === 'string') {
    const parsed = Date.parse(record.time);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function physicalSandboxMatches(record: LogRecord, physicalSandboxId: string): boolean {
  if (typeof record.physicalSandboxId !== 'string') return false;
  return (
    record.physicalSandboxId === physicalSandboxId ||
    physicalSandboxId.endsWith(`-${record.physicalSandboxId}`) ||
    record.physicalSandboxId.endsWith(`-${physicalSandboxId}`)
  );
}

export type IdleStopEvidence = {
  stopInitiatedAt: number;
  providerStopAt: number;
  observedAt: number;
  elapsedMs: number;
};

export type IdleStopEvidenceInput = {
  allocationId: string;
  /**
   * Durable logical sandbox id from `getSession` (`workspace.sandboxId`). Every
   * `sandbox_control` diagnostic stamps it as `sandboxId`. Prefer this over the
   * derived allocation name because the durable session exposes the logical id.
   */
  sandboxId?: string;
  physicalSandboxId?: string;
  /** Provider allocation name (`ses-<hash>`), correlated against `native_stop`. */
  allocationName?: string;
  /** Provider kind (`cloudflare`/`vercel`), correlated against `native_stop`. */
  provider?: string;
  /** Vercel provider session id, correlated when the owned ref exposes one. */
  providerSessionId?: string;
  cursorCapturedAt?: number;
};

function identityValue(record: LogRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordMatchesOwnedIdentity(
  record: LogRecord,
  input: IdleStopEvidenceInput,
  resolvedAllocationId: string | undefined,
  identity: { sandboxId?: string; wrapperInstanceId?: string }
): boolean {
  // The durable logical sandbox id is stamped on every `sandbox_control`
  // diagnostic as `sandboxId`. Match it first so the reader needs only the
  // durable id, not the derived allocation name or the Docker family name.
  if (input.sandboxId !== undefined && record.sandboxId === input.sandboxId) return true;
  const expectedPhysicalSandboxId = input.physicalSandboxId ?? input.allocationId;
  const recordPhysicalSandboxId = identityValue(record, 'physicalSandboxId');
  if (recordPhysicalSandboxId !== undefined) {
    return (
      (input.physicalSandboxId !== undefined &&
        physicalSandboxMatches(record, expectedPhysicalSandboxId)) ||
      (input.physicalSandboxId === undefined && record.allocationId === resolvedAllocationId)
    );
  }
  if (resolvedAllocationId !== undefined && record.allocationId === resolvedAllocationId) {
    return true;
  }
  if (
    identity.wrapperInstanceId !== undefined &&
    record.wrapperInstanceId === identity.wrapperInstanceId
  ) {
    return true;
  }
  return identity.sandboxId !== undefined && record.sandboxId === identity.sandboxId;
}

/** The owned idle-stop initiation: `allocated.* -> stopping.destroying` on an idle reason. */
function isIdleStopInitiation(record: LogRecord): boolean {
  return (
    record.diagnosticEvent === 'allocation_transition' &&
    record.aggregate === 'allocation' &&
    typeof record.from === 'string' &&
    record.from.startsWith('allocated.') &&
    record.to === 'stopping.destroying' &&
    isIdleStopCause(record.reason)
  );
}

/**
 * The provider's own terminal stop for the owned allocation. `native_stop`
 * carries no durable sandbox id, so the allocation name and provider must both
 * match; an absent allocation name fails closed.
 */
function nativeStopMatchesOwnedAllocation(
  record: LogRecord,
  input: IdleStopEvidenceInput
): boolean {
  if (input.allocationName === undefined) return false;
  if (record.diagnosticEvent !== 'native_stop' || record.result !== 'terminal') return false;
  if (record.allocationName !== input.allocationName) return false;
  if (record.provider !== input.provider) return false;
  if (
    input.providerSessionId !== undefined &&
    record.providerSessionId !== input.providerSessionId
  ) {
    return false;
  }
  return true;
}

function createIdleStopEvidenceMatcher(input: IdleStopEvidenceInput): {
  feed: (record: LogRecord) => IdleStopEvidence | null;
} {
  const cursorCapturedAt = input.cursorCapturedAt ?? Date.now();
  let resolvedAllocationId = input.allocationId.length > 0 ? input.allocationId : undefined;
  const identity: { sandboxId?: string; wrapperInstanceId?: string } = {};
  let stopInitiatedAt: number | undefined;
  let providerStopAt: number | undefined;

  const feed = (record: LogRecord): IdleStopEvidence | null => {
    if (recordLogTag(record) !== 'sandbox_control') return null;
    const observedAt = recordTime(record, Date.now());

    if (
      isIdleStopInitiation(record) &&
      recordMatchesOwnedIdentity(record, input, resolvedAllocationId, identity)
    ) {
      const recordAllocationId = identityValue(record, 'allocationId');
      if (recordAllocationId !== undefined) resolvedAllocationId = recordAllocationId;
      identity.sandboxId ??= identityValue(record, 'sandboxId');
      identity.wrapperInstanceId ??= identityValue(record, 'wrapperInstanceId');
      stopInitiatedAt ??= observedAt;
    }

    if (nativeStopMatchesOwnedAllocation(record, input)) {
      providerStopAt ??= observedAt;
    }

    if (stopInitiatedAt === undefined || providerStopAt === undefined) return null;
    const observed = Math.max(stopInitiatedAt, providerStopAt);
    return {
      stopInitiatedAt,
      providerStopAt,
      observedAt: observed,
      elapsedMs: Math.max(0, observed - cursorCapturedAt),
    };
  };

  return { feed };
}

/** Match bounded idle-stop evidence without reading the local log. */
export function matchIdleStopEvidence(
  records: Iterable<LogRecord>,
  input: IdleStopEvidenceInput
): IdleStopEvidence | null {
  const matcher = createIdleStopEvidenceMatcher(input);
  for (const record of records) {
    const evidence = matcher.feed(record);
    if (evidence) return evidence;
  }
  return null;
}

/**
 * Byte offset at the current end of the local cloud-agent-next log, to be used
 * as the `fromByte` cursor for a later bounded read. Capturing it before a fault
 * keeps evidence matching to records written after the fault.
 */
export async function captureLogCursor(): Promise<{ fromByte: number; capturedAt: number }> {
  try {
    const handle = await open(CLOUD_AGENT_LOG_PATH, 'r');
    try {
      const size = (await handle.stat()).size;
      return { fromByte: size, capturedAt: Date.now() };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return { fromByte: 0, capturedAt: Date.now() };
  }
}

async function readLogChunkFrom(
  cursor: number,
  decoder: TextDecoder
): Promise<{ chunk: string; next: number; size: number; truncated: boolean }> {
  let handle;
  try {
    handle = await open(CLOUD_AGENT_LOG_PATH, 'r');
    const size = (await handle.stat()).size;
    if (size < cursor) return { chunk: '', next: cursor, size, truncated: true };
    if (size === cursor) return { chunk: '', next: cursor, size, truncated: false };
    const length = Math.min(size - cursor, IDLE_LOG_READ_CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, cursor);
    return {
      chunk: decoder.decode(buffer.subarray(0, read.bytesRead), { stream: true }),
      next: cursor + read.bytesRead,
      size,
      truncated: false,
    };
  } catch {
    return { chunk: '', next: cursor, size: cursor, truncated: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Read every complete framed record from `fromByte` to the current end of the
 * cloud-agent-next log and return those matching `match`. This is a bounded
 * snapshot, not a wait: it does not poll for later writes. A truncated or
 * rotated log yields the matches seen so far (usually none).
 */
export async function readWorkerLogSnapshot(input: {
  fromByte: number;
  match: (record: LogRecord) => boolean;
  limit?: number;
}): Promise<LogRecord[]> {
  if (!Number.isInteger(input.fromByte) || input.fromByte < 0) {
    throw new Error(`invalid worker-log cursor: ${input.fromByte}`);
  }
  const limit = input.limit ?? 4096;
  const framer = createLogRecordFramer();
  const decoder = new TextDecoder();
  const matches: LogRecord[] = [];
  let cursor = input.fromByte;
  for (;;) {
    const { chunk, next, size, truncated } = await readLogChunkFrom(cursor, decoder);
    if (truncated) return matches;
    for (const record of framer.push(chunk)) {
      if (input.match(record)) {
        matches.push(record);
        if (matches.length >= limit) return matches;
      }
    }
    if (next <= cursor || next >= size) break;
    cursor = next;
  }
  return matches;
}
