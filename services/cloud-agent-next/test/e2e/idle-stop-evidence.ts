/**
 * Bounded reader and matcher for cloud-agent-next idle-stop diagnostics.
 *
 * This module scrapes one production-owned log contract:
 * `src/sandbox-control/diagnostics.ts` (`logControlDiagnostic` stamps
 * `logTag: 'sandbox_control'` and `diagnosticEvent`), and the emitting sites in
 * `src/persistence/SandboxControl.ts` that write the `physical_committed`,
 * `provider_stop`, and `deadline_fired` records. Keep `LOG_FIELD_KEYS` and the
 * event/field expectations below in sync with those emitters; a production
 * field rename surfaces here as a missing-evidence timeout, not a compile
 * error.
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
const IDLE_LOG_POLL_MS = 250;
const MAX_FRAMED_LOG_OBJECT_BYTES = 512 * 1024;
const MAX_PENDING_IDLE_DEADLINES = 64;

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
  'fromState',
  'toState',
  'cause',
  'stopCause',
  'result',
  'deadlineId',
  'deadlineAt',
  'time',
  'logTag',
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
  physicalCommittedAt: number;
  providerStopAt: number;
  deadlineAt?: number;
  observedAt: number;
  elapsedMs: number;
};

export type IdleStopEvidenceInput = {
  allocationId: string;
  /**
   * Durable logical sandbox id from `getSession` (`workspace.sandboxId`). Every
   * `sandbox_control` diagnostic stamps it as `sandboxId`. Prefer this over the
   * derived `physicalSandboxId` (the `ses-…` allocation name) because the
   * durable session exposes the logical id, not the allocation name.
   */
  sandboxId?: string;
  physicalSandboxId?: string;
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
  // diagnostic as `sandboxId`, including the `physical_committed` and
  // `provider_stop` records that also carry a derived `physicalSandboxId`
  // (the `ses-…` allocation name). Match it first so the reader needs only the
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

function idleDeadlineMatchesIdentity(
  record: LogRecord,
  input: IdleStopEvidenceInput,
  resolvedAllocationId: string | undefined,
  identity: { sandboxId?: string; wrapperInstanceId?: string }
): boolean {
  if (record.deadlineId !== 'idleStop' || typeof record.deadlineAt !== 'number') return false;
  return recordMatchesOwnedIdentity(record, input, resolvedAllocationId, identity);
}

function createIdleStopEvidenceMatcher(input: IdleStopEvidenceInput): {
  feed: (record: LogRecord) => IdleStopEvidence | null;
} {
  const cursorCapturedAt = input.cursorCapturedAt ?? Date.now();
  const expectedPhysicalSandboxId = input.physicalSandboxId ?? input.allocationId;
  let resolvedAllocationId = input.allocationId.length > 0 ? input.allocationId : undefined;
  const identity: { sandboxId?: string; wrapperInstanceId?: string } = {};
  const pendingDeadlines: LogRecord[] = [];
  let physicalCommittedAt: number | undefined;
  let providerStopAt: number | undefined;
  let deadlineAt: number | undefined;

  const maybeCapturePendingDeadline = (): void => {
    if (deadlineAt !== undefined) return;
    for (const pending of pendingDeadlines) {
      if (
        idleDeadlineMatchesIdentity(
          pending,
          {
            ...input,
            physicalSandboxId: expectedPhysicalSandboxId,
          },
          resolvedAllocationId,
          identity
        )
      ) {
        deadlineAt = pending.deadlineAt as number;
        return;
      }
    }
  };

  const feed = (record: LogRecord): IdleStopEvidence | null => {
    if (recordLogTag(record) !== 'sandbox_control') return null;
    const observedAt = recordTime(record, Date.now());
    const isDeadline = record.diagnosticEvent === 'deadline_fired';
    if (isDeadline && record.deadlineId === 'idleStop' && typeof record.deadlineAt === 'number') {
      if (idleDeadlineMatchesIdentity(record, input, resolvedAllocationId, identity)) {
        deadlineAt ??= record.deadlineAt;
      } else if (pendingDeadlines.length < MAX_PENDING_IDLE_DEADLINES) {
        pendingDeadlines.push(record);
      }
    }

    if (
      record.diagnosticEvent === 'physical_committed' &&
      recordMatchesOwnedIdentity(record, input, resolvedAllocationId, identity)
    ) {
      const recordAllocationId = identityValue(record, 'allocationId');
      if (recordAllocationId !== undefined) resolvedAllocationId = recordAllocationId;
      identity.sandboxId ??= identityValue(record, 'sandboxId');
      identity.wrapperInstanceId ??= identityValue(record, 'wrapperInstanceId');
      maybeCapturePendingDeadline();
      // Only the running -> stopping transition with an idle `cause` is the
      // initiation record. A stop_attempt with stopCause=idle is not evidence.
      if (
        record.fromState === 'running' &&
        record.toState === 'stopping' &&
        isIdleStopCause(record.cause)
      ) {
        physicalCommittedAt ??= observedAt;
      }
    }

    if (
      record.diagnosticEvent === 'provider_stop' &&
      record.result === 'terminal' &&
      recordMatchesOwnedIdentity(record, input, resolvedAllocationId, identity)
    ) {
      const recordAllocationId = identityValue(record, 'allocationId');
      if (recordAllocationId !== undefined) resolvedAllocationId = recordAllocationId;
      identity.sandboxId ??= identityValue(record, 'sandboxId');
      identity.wrapperInstanceId ??= identityValue(record, 'wrapperInstanceId');
      maybeCapturePendingDeadline();
      providerStopAt ??= observedAt;
    }

    if (physicalCommittedAt === undefined || providerStopAt === undefined) return null;
    const observed = Math.max(physicalCommittedAt, providerStopAt);
    return {
      physicalCommittedAt,
      providerStopAt,
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      observedAt: observed,
      elapsedMs:
        deadlineAt !== undefined
          ? Math.max(0, deadlineAt - cursorCapturedAt)
          : Math.max(0, observed - cursorCapturedAt),
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

export async function readIdleStopEvidence(input: {
  allocationId: string;
  sandboxId?: string;
  physicalSandboxId?: string;
  fromByte: number;
  budgetMs: number;
  cursorCapturedAt?: number;
}): Promise<IdleStopEvidence> {
  if (!Number.isInteger(input.fromByte) || input.fromByte < 0) {
    throw new Error(`invalid idle-stop log cursor: ${input.fromByte}`);
  }
  if (!Number.isFinite(input.budgetMs) || input.budgetMs <= 0) {
    throw new Error(`invalid idle-stop evidence budget: ${input.budgetMs}`);
  }
  const cursorCapturedAt = input.cursorCapturedAt ?? Date.now();
  const deadline = Date.now() + input.budgetMs;
  let cursor = input.fromByte;
  const matcher = createIdleStopEvidenceMatcher({
    allocationId: input.allocationId,
    ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
    ...(input.physicalSandboxId ? { physicalSandboxId: input.physicalSandboxId } : {}),
    cursorCapturedAt,
  });
  const framer = createLogRecordFramer();
  const decoder = new TextDecoder();

  while (Date.now() < deadline) {
    let chunk = '';
    let handle;
    try {
      handle = await open(CLOUD_AGENT_LOG_PATH, 'r');
      const size = (await handle.stat()).size;
      if (size < cursor) {
        throw new Error('cloud-agent-next log was truncated or rotated during idle-stop wait');
      }
      const length = Math.min(size - cursor, IDLE_LOG_READ_CHUNK_BYTES);
      if (length > 0) {
        const buffer = Buffer.alloc(length);
        const read = await handle.read(buffer, 0, length, cursor);
        cursor += read.bytesRead;
        chunk = decoder.decode(buffer.subarray(0, read.bytesRead), { stream: true });
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('truncated or rotated')) throw error;
      chunk = '';
    } finally {
      await handle?.close().catch(() => undefined);
    }

    for (const record of framer.push(chunk)) {
      const evidence = matcher.feed(record);
      if (evidence) return evidence;
    }
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(IDLE_LOG_POLL_MS, deadline - Date.now()))
    );
  }
  throw new Error(`idle-stop evidence not found within ${input.budgetMs}ms`);
}
