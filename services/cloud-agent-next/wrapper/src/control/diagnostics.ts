import {
  CONTROL_LOG_MAX_BATCH_BYTES,
  CONTROL_LOG_MAX_BATCH_RECORDS,
  CONTROL_LOG_MAX_BUFFER_RECORDS,
  controlUploadFailureStartsEpisode,
  createControlDiagnosticRecord,
  type ControlDiagnosticReporter,
  type ControlDiagnosticProjector,
  type ControlDiagnosticRecord,
  type ControlLogBatch,
  type ControlLogUploadResult,
  type ControlUploadFailureSample,
} from '../../../src/shared/control-diagnostics.js';
import {
  createSandboxTransferClient,
  sandboxTransferPath,
  type SandboxTransferClient,
} from './sandbox-transfer-client.js';

export type ControlDiagnostics = {
  onDiagnostic: ControlDiagnosticReporter;
  setSnapshot(callback: () => void): void;
  start(): void;
  flush(): Promise<void>;
  finalize(timeoutMs?: number): Promise<void>;
};

type Options = {
  uploadUrl?: string;
  uploadGrant?: string;
  client?: SandboxTransferClient;
  logPathPrefix?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  intervalMs?: number;
  uploadTimeoutMs?: number;
  projector?: ControlDiagnosticProjector;
};

type PendingBatch = { id: string; body: string; sequence: number; attempts: number };

const TERMINAL_SOCKET_PHASES = new Set([
  'hello_rejected',
  'reconnect_exhausted',
  'explicitly_closed',
]);

function isTerminalRecord(record: ControlDiagnosticRecord): boolean {
  const { event, fields } = record;
  if (event === 'wrapper.lifecycle')
    return (
      fields.phase === 'stopping' || fields.phase === 'start_failed' || fields.phase === 'failed'
    );
  if (event === 'session.task') {
    return (
      fields.phase === 'finished' ||
      fields.phase === 'failed' ||
      fields.phase === 'deadline_expired'
    );
  }
  if (event === 'session.execution' && fields.phase === 'deadline_expired') return true;
  if (event === 'control.socket')
    return fields.phase !== undefined && TERMINAL_SOCKET_PHASES.has(fields.phase);
  return (
    event === 'session.execution' &&
    (fields.status !== undefined ||
      fields.phase === 'execution_failed' ||
      fields.phase === 'outcome_sending' ||
      fields.phase === 'outcome_sent' ||
      fields.phase === 'outcome_failed' ||
      fields.phase === 'abort_completed' ||
      fields.phase === 'abort_failed')
  );
}

function retentionPriority(record: ControlDiagnosticRecord): number {
  if (
    record.event === 'control.heartbeat' ||
    (record.event === 'wrapper.lifecycle' && record.fields.phase === 'starting')
  )
    return 2;
  return isTerminalRecord(record) || record.event === 'control.upload' ? 1 : 0;
}

export function createControlDiagnostics(options: Options): ControlDiagnostics {
  const records: ControlDiagnosticRecord[] = [];
  const now = options.now ?? Date.now;
  const client =
    options.client ??
    (options.uploadUrl && options.uploadGrant
      ? createSandboxTransferClient({
          baseUrl: options.uploadUrl,
          grant: options.uploadGrant,
          fetch: options.fetch,
          attempts: 1,
          timeoutMs: options.uploadTimeoutMs ?? 3000,
        })
      : undefined);
  const logPathPrefix = options.logPathPrefix ?? (options.client ? 'logs' : '');
  let droppedRecords = 0;
  let droppedTerminalRecords = 0;
  let uploadFailures = 0;
  let lastUploadFailure: ControlDiagnosticRecord | undefined;
  let lastUploadFailureSample: ControlUploadFailureSample | undefined;
  let sequence = 0;
  let pending: PendingBatch | undefined;
  let active: Promise<void> | undefined;
  let finalizing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let accepting = true;
  let snapshot: (() => void) | undefined;
  const stop = new AbortController();

  function accountDrop(record?: ControlDiagnosticRecord): void {
    droppedRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedRecords + 1);
    if (record && isTerminalRecord(record)) {
      droppedTerminalRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedTerminalRecords + 1);
    }
  }

  function bufferRecord(record: ControlDiagnosticRecord): void {
    if (records.length >= CONTROL_LOG_MAX_BUFFER_RECORDS) {
      const priority = retentionPriority(record);
      const latestHeartbeat = records.findLastIndex(queued => queued.event === 'control.heartbeat');
      const queuedPriority = (queued: ControlDiagnosticRecord, index: number): number => {
        if (
          queued.event === 'control.heartbeat' &&
          (record.event === 'control.heartbeat' || index !== latestHeartbeat)
        )
          return 0;
        return retentionPriority(queued);
      };
      let replace =
        priority > 0
          ? records.findIndex((queued, index) => queuedPriority(queued, index) === 0)
          : -1;
      if (replace === -1 && priority > 0) {
        replace = records.findIndex((queued, index) => queuedPriority(queued, index) === 1);
      }
      if (replace === -1) {
        accountDrop(record);
        return;
      }
      accountDrop(records.splice(replace, 1)[0]);
    }
    records.push(record);
  }

  const onDiagnostic: ControlDiagnosticReporter = (event, fields) => {
    try {
      // Native stderr is projected before the upload gate closes, so a lifecycle
      // line after a 401/403 still appears. `control.upload` is exempt: the
      // archive owner projects it under its own latch, and the diagnostic
      // uploader does so in `reportUploadResult`, so projecting it here would
      // duplicate the line.
      if (event !== 'control.upload') options.projector?.(event, fields);
      if (!accepting) return;
      const record = createControlDiagnosticRecord(event, fields, now());
      if (!record) {
        accountDrop();
        return;
      }
      bufferRecord(record);
      if (timer && !pending && records.length >= CONTROL_LOG_MAX_BATCH_RECORDS) void flush();
    } catch {
      return;
    }
  };

  function reportUploadResult(
    batch: PendingBatch,
    category: ControlLogUploadResult,
    statusCode?: number
  ): void {
    try {
      const accepted = category === 'accepted';
      if (!accepted) uploadFailures = Math.min(Number.MAX_SAFE_INTEGER, uploadFailures + 1);
      const safeStatusCode =
        statusCode !== undefined && statusCode >= 100 && statusCode <= 599 ? statusCode : undefined;
      const record = createControlDiagnosticRecord(
        'control.upload',
        {
          phase: accepted ? 'completed' : 'failed',
          category,
          statusCode: safeStatusCode,
          sequence: batch.sequence,
          attempt: batch.attempts,
          failureCount: uploadFailures,
        },
        now()
      );
      if (!record) return;
      if (!accepted) {
        lastUploadFailure = record;
        const sample: ControlUploadFailureSample = {
          category,
          ...(safeStatusCode === undefined ? {} : { statusCode: safeStatusCode }),
        };
        if (
          options.projector?.enabled &&
          controlUploadFailureStartsEpisode(lastUploadFailureSample, sample)
        ) {
          options.projector('control.upload', {
            phase: 'failed',
            category,
            statusCode: safeStatusCode,
            sequence: batch.sequence,
            attempt: batch.attempts,
            failureCount: uploadFailures,
          });
        }
        lastUploadFailureSample = sample;
      } else {
        if (lastUploadFailure) bufferRecord(lastUploadFailure);
        lastUploadFailure = undefined;
        lastUploadFailureSample = undefined;
        uploadFailures = 0;
      }
      // The Sandbox SDK and Vercel control-plane wrapper share this module and
      // keep the per-attempt console line; only the native gate switches it to
      // the projector.
      if (!options.projector?.enabled) console.error(JSON.stringify(record));
    } catch {
      return;
    }
  }

  function nextBatch(): PendingBatch | undefined {
    if (pending) return pending;
    if (records.length === 0) return undefined;
    const batch: ControlLogBatch = {
      version: 1,
      sequence,
      droppedRecords,
      droppedTerminalRecords,
      records: [],
    };
    let bytes = 256;
    while (
      batch.records.length < records.length &&
      batch.records.length < CONTROL_LOG_MAX_BATCH_RECORDS
    ) {
      const record = records[batch.records.length];
      const recordBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
      if (bytes + recordBytes > CONTROL_LOG_MAX_BATCH_BYTES) break;
      bytes += recordBytes;
      batch.records.push(record);
    }
    pending = { id: crypto.randomUUID(), body: JSON.stringify(batch), sequence, attempts: 0 };
    records.splice(0, batch.records.length);
    sequence++;
    droppedRecords = 0;
    droppedTerminalRecords = 0;
    return pending;
  }

  async function performFlush(): Promise<void> {
    const batch = nextBatch();
    if (!batch || !client || stopped) return;
    const timeout = new AbortController();
    const signal = AbortSignal.any([timeout.signal, stop.signal]);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let result: ControlLogUploadResult = 'network_failure';
    let statusCode: number | undefined;
    batch.attempts = Math.min(Number.MAX_SAFE_INTEGER, batch.attempts + 1);
    try {
      timeoutId = setTimeout(() => timeout.abort(), options.uploadTimeoutMs ?? 3000);
      const transfer = await client.put(sandboxTransferPath(logPathPrefix, batch.id), {
        body: batch.body,
        contentType: 'application/json',
        signal,
      });
      statusCode = transfer.statusCode;
      if (transfer.status === 'ok' && transfer.statusCode === 204) {
        result = 'accepted';
        if (pending === batch) pending = undefined;
      } else if (transfer.status === 'ok' || transfer.status === 'rejected') {
        result = 'http_rejection';
        if (transfer.statusCode === 401 || transfer.statusCode === 403) {
          stopped = true;
          accepting = false;
          if (timer) clearInterval(timer);
          pending = undefined;
          records.length = 0;
        }
      } else {
        result = stop.signal.aborted
          ? 'cancelled'
          : timeout.signal.aborted
            ? 'timeout'
            : 'network_failure';
      }
    } catch {
      result = stop.signal.aborted
        ? 'cancelled'
        : timeout.signal.aborted
          ? 'timeout'
          : 'network_failure';
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeout.abort();
      reportUploadResult(batch, result, statusCode);
    }
  }

  function runSnapshot(): void {
    try {
      snapshot?.();
    } catch {
      // Diagnostics must never throw into the caller.
    }
  }

  function flush(): Promise<void> {
    if (active) return active;
    if (stopped || !client) return Promise.resolve();
    active = performFlush()
      .catch(() => undefined)
      .finally(() => {
        active = undefined;
      });
    return active;
  }

  function start(): void {
    if (timer || stopped || !client) return;
    runSnapshot();
    void flush();
    timer = setInterval(() => {
      runSnapshot();
      void flush();
    }, options.intervalMs ?? 5000);
    timer.unref();
  }

  function finalize(timeoutMs = 4000): Promise<void> {
    if (finalizing) return finalizing;
    runSnapshot();
    accepting = false;
    if (timer) clearInterval(timer);
    finalizing = (async () => {
      const deadline = setTimeout(() => {
        stopped = true;
        stop.abort();
      }, timeoutMs);
      try {
        await active;
        while (!stopped && client !== undefined && (pending || records.length)) {
          await flush();
          if (pending) break;
        }
      } finally {
        clearTimeout(deadline);
        stopped = true;
        stop.abort();
      }
    })().catch(() => undefined);
    return finalizing;
  }

  return {
    onDiagnostic,
    setSnapshot(callback) {
      snapshot = callback;
    },
    start,
    flush,
    finalize,
  };
}
