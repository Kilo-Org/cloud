import { withTimeout } from '@kilocode/worker-utils';
import type {
  NativeSnapshot,
  NativeSnapshotCursor,
  SandboxSessionV2,
} from '../control-plane/session/session-do.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';
import type { StreamEvent } from '../websocket/types.js';
import {
  canRetainNativeEvent,
  createNativeSnapshotReconciler,
  isDeliverableNativeEvent,
  isMaterializedNativeEvent,
  NATIVE_DELIVERY_LIMITS,
  NATIVE_FACADE_FENCE_EVENT,
  toNativePublicEvent,
  type NativePublicEvent,
  type NativeSnapshotAuthority,
} from './native-event-source.js';
import { publicCloudAgentDirectory } from './public-sdk-projection.js';
import { openSessionStreamSocket, type SessionStreamSocket } from './session-stream-socket.js';

/**
 * Native `/event` live tail. It reads the session DO's hibernatable `/stream`
 * socket directly instead of an in-memory push, so a session DO eviction does
 * not break continuity: the durable event log is the only cursor. The tail
 * writes the fenced snapshot first, then the live frames. A real upstream
 * transport gap cannot be resumed from the cursor, so it reports
 * `continuity_unproven` and closes rather than guessing (plan amendment 1).
 */

export type NativeTailResnapshotReason =
  | 'continuity_unproven'
  | 'snapshot_too_large'
  | 'snapshot_unavailable';

export type NativeTailSink = {
  /** Backpressure-aware write; resolves once the frame is enqueued. */
  send(event: NativePublicEvent): Promise<void>;
  /** Emit one final frame when a reason is given, then close the response. */
  finish(resnapshotReason?: NativeTailResnapshotReason): void;
};

export type NativeTailPage =
  | {
      kind: 'page';
      fence: number | null;
      events: StreamEvent[];
      /** The Session DO's authoritative status and interactions for this page. */
      authority?: NativeSnapshotAuthority;
      nextPage?: () => Promise<NativeTailPage>;
    }
  | { kind: 'resnapshot'; reason: 'snapshot_too_large' | 'snapshot_unavailable' }
  | { kind: 'stopped' };

export type NativeEventTail = {
  run(sink: NativeTailSink): Promise<void>;
  close(): void;
};

export type NativeTailOpenResult =
  | { kind: 'stopped' }
  | { kind: 'unavailable'; code: string; message: string }
  | { kind: 'open'; tail: NativeEventTail };

export type NativeTailSeams = {
  openSocket?: typeof openSessionStreamSocket;
  readPage?: (continuation?: NativeSnapshotCursor) => Promise<NativeTailPage>;
  resolveRoot?: (params: {
    kiloUserId: string;
    kiloSessionId: string;
  }) => Promise<{ cloudAgentSessionId: string } | null>;
};

type BufferedFrame = {
  eventId: number;
  materialized: boolean;
  event: NativePublicEvent;
  bytes: number;
};

const OPEN_DEADLINE_MS = 5_000;
const IDENTITY_RESOLVE_DEADLINE_MS = 2_000;

function isErrorEnvelope(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'error'
  );
}

function defaultReadPage(
  env: Env,
  userId: string,
  cloudAgentSessionId: string,
  kiloSessionId: string
): (continuation?: NativeSnapshotCursor) => Promise<NativeTailPage> {
  const stub = getSandboxSessionStub(env, userId, cloudAgentSessionId);
  const read = async (continuation?: NativeSnapshotCursor): Promise<NativeTailPage> => {
    const snapshot: NativeSnapshot = await withDORetry<
      DurableObjectStub<SandboxSessionV2>,
      NativeSnapshot
    >(
      () => stub,
      current => current.nativeSnapshot({ kiloSessionId, continuation }),
      'nativeSnapshot'
    );
    if (snapshot.stopped === true) return { kind: 'stopped' };
    if (snapshot.oversized) return { kind: 'resnapshot', reason: 'snapshot_too_large' };
    return {
      kind: 'page',
      fence: snapshot.fence,
      events: snapshot.events,
      authority: {
        sessionStatus: snapshot.sessionStatus,
        questions: snapshot.questions,
        permissions: snapshot.permissions,
      },
      ...(snapshot.continuation === undefined
        ? {}
        : { nextPage: () => read(snapshot.continuation) }),
    };
  };
  return read;
}

/**
 * Opens the `/stream?replay=false` socket before the snapshot so live frames
 * during paging are buffered, then reads the first snapshot page. A 404 or an
 * identity mismatch is the stopped signal the facade maps to a 503 before SSE.
 */
export async function openNativeEventTail(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  /** `false` opens a live-only tail: no snapshot pages and no fence. */
  history?: boolean;
  seams?: NativeTailSeams;
}): Promise<NativeTailOpenResult> {
  const { env, userId, cloudAgentSessionId, kiloSessionId } = params;
  const history = params.history ?? true;
  const seams = params.seams ?? {};
  const openSocket = seams.openSocket ?? openSessionStreamSocket;
  const readPage =
    seams.readPage ?? defaultReadPage(env, userId, cloudAgentSessionId, kiloSessionId);
  const resolveRoot =
    seams.resolveRoot ??
    (input => env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession(input));

  let done = false;
  let socket: SessionStreamSocket | null = null;
  let sink: NativeTailSink | null = null;
  let fenceReady = false;
  let cursor: number | null = null;
  const queue: BufferedFrame[] = [];
  let queuedBytes = 0;
  let burstRunning = false;
  let opening = true;
  let endBeforeRun = false;

  const directory = publicCloudAgentDirectory(kiloSessionId);
  const encoder = new TextEncoder();

  const teardown = (): void => {
    done = true;
    socket?.close();
    socket = null;
    queue.length = 0;
    queuedBytes = 0;
  };

  const fail = (reason: NativeTailResnapshotReason): void => {
    if (done) return;
    teardown();
    sink?.finish(reason);
  };

  const admit = (frame: BufferedFrame): boolean => {
    if (!canRetainNativeEvent(queue.length, queuedBytes, frame.bytes)) {
      fail('continuity_unproven');
      return false;
    }
    queue.push(frame);
    queuedBytes += frame.bytes;
    return true;
  };

  const revalidateIdentity = async (): Promise<boolean> => {
    const deadlineAt = Date.now() + IDENTITY_RESOLVE_DEADLINE_MS;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return false;
      const resolve = resolveRoot({ kiloUserId: userId, kiloSessionId });
      // A timed-out resolve may settle later; absorb it so it never rejects unhandled.
      resolve.catch(() => undefined);
      try {
        const root = await withTimeout(resolve, remaining, 'Native identity resolve timed out');
        return root?.cloudAgentSessionId === cloudAgentSessionId;
      } catch {
        // A transient resolve failure is retried to the probe bound.
      }
    }
    return false;
  };

  const runBursts = async (): Promise<void> => {
    burstRunning = true;
    try {
      await delay(NATIVE_DELIVERY_LIMITS.coalesceMs);
      while (!done && queue.length > 0) {
        const batch = queue.splice(0);
        queuedBytes = 0;
        if (batch.length === 0) break;
        if (!(await revalidateIdentity())) {
          fail('continuity_unproven');
          return;
        }
        for (const frame of batch) {
          if (done || sink === null) return;
          if (
            frame.eventId > 0 &&
            cursor !== null &&
            frame.eventId <= cursor &&
            !frame.materialized
          )
            continue;
          await sink.send(frame.event);
          if (frame.eventId > 0)
            cursor = cursor === null ? frame.eventId : Math.max(cursor, frame.eventId);
        }
      }
    } catch {
      fail('continuity_unproven');
    } finally {
      burstRunning = false;
    }
    if (!done && queue.length > 0) void runBursts();
  };

  const onMessage = (payload: unknown): void => {
    if (done) return;
    if (isErrorEnvelope(payload)) {
      fail('continuity_unproven');
      return;
    }
    const event = payload as StreamEvent;
    if (!isDeliverableNativeEvent(event, true)) return;
    const native = toNativePublicEvent(event, kiloSessionId);
    if (native === null) return;
    const bytes = encoder.encode(JSON.stringify(native)).byteLength;
    if (
      !admit({
        eventId: event.eventId,
        materialized: isMaterializedNativeEvent(event),
        event: native,
        bytes,
      })
    )
      return;
    if (fenceReady && !burstRunning) void runBursts();
  };

  const opened = await openSocket({
    stub: getSandboxSessionStub(env, userId, cloudAgentSessionId),
    search: `?replay=false&kiloSessionId=${encodeURIComponent(kiloSessionId)}`,
    operationName: 'nativeEventTail',
    onMessage,
    onEnd: () => {
      if (done) return;
      if (opening) {
        endBeforeRun = true;
        return;
      }
      fail('continuity_unproven');
    },
  });
  if (opened.kind === 'stopped') return { kind: 'stopped' };
  if (opened.kind === 'unavailable')
    return {
      kind: 'unavailable',
      code: 'KILO_SESSION_READ_RETRYABLE',
      message: 'Native event stream is unavailable',
    };
  socket = opened.socket;

  let firstPage: NativeTailPage | null = null;
  if (history) {
    const attempt = readPage(undefined);
    // A timed-out page read may settle later; absorb it so it never rejects unhandled.
    attempt.catch(() => undefined);
    try {
      firstPage = await withTimeout(attempt, OPEN_DEADLINE_MS, 'Native snapshot open timed out');
    } catch {
      socket?.close();
      socket = null;
      return {
        kind: 'unavailable',
        code: 'KILO_SESSION_READ_RETRYABLE',
        message: 'Native event stream is unavailable',
      };
    }
    if (firstPage.kind === 'stopped') {
      socket?.close();
      socket = null;
      return { kind: 'stopped' };
    }
  }
  opening = false;

  const run = async (activeSink: NativeTailSink): Promise<void> => {
    sink = activeSink;
    if (done || endBeforeRun) {
      activeSink.finish('continuity_unproven');
      teardown();
      return;
    }
    const reconciler = createNativeSnapshotReconciler(kiloSessionId);
    let authority: NativeSnapshotAuthority = {};
    const mergeAuthority = (next: NativeSnapshotAuthority | undefined): void => {
      if (next === undefined) return;
      authority = {
        ...authority,
        ...(next.sessionStatus === undefined ? {} : { sessionStatus: next.sessionStatus }),
        ...(next.questions === undefined ? {} : { questions: next.questions }),
        ...(next.permissions === undefined ? {} : { permissions: next.permissions }),
      };
    };
    try {
      if (firstPage !== null) {
        let page: NativeTailPage = firstPage;
        for (;;) {
          if (done) return;
          if (page.kind === 'stopped') {
            teardown();
            activeSink.finish('continuity_unproven');
            return;
          }
          if (page.kind === 'resnapshot') {
            teardown();
            activeSink.finish(page.reason);
            return;
          }
          mergeAuthority(page.authority);
          for (const event of page.events) {
            if (done) return;
            if (!isDeliverableNativeEvent(event)) continue;
            const native = toNativePublicEvent(event, kiloSessionId);
            if (native === null) continue;
            reconciler.observe(native);
            await activeSink.send(native);
          }
          if (page.nextPage === undefined) {
            cursor = page.fence;
            break;
          }
          page = await page.nextPage();
        }
        // Corrections precede the fence, so newer buffered live frames still win.
        for (const correction of reconciler.corrections(authority)) {
          if (done) return;
          await activeSink.send(correction);
        }
        await activeSink.send({
          type: NATIVE_FACADE_FENCE_EVENT,
          properties: {
            sessionID: kiloSessionId,
            directory,
            ...(cursor === null ? {} : { fence: cursor }),
            snapshotComplete: true,
          },
        });
      }
      fenceReady = true;
      if (done) return;
      if (queue.length > 0 && !burstRunning) void runBursts();
    } catch {
      fail('snapshot_unavailable');
    }
  };

  return {
    kind: 'open',
    tail: {
      run,
      close() {
        teardown();
      },
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
