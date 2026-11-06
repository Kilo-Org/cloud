import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fetchKiloServer } from '../kilo-server-auth.js';
import type { KiloEventFeed, KiloEventFeedOptions } from './kilo-event-feed.js';
import {
  createKilo2Api,
  kilo2EventSchema,
  kilo2FormSchema,
  kilo2PermissionSchema,
} from './kilo2-api.js';
import {
  createKilo2Reads,
  kilo2LocationQuery,
  projectKilo2Permission,
  projectKilo2Question,
} from './kilo2-reads.js';
import type { HarnessActivity } from './harness-activity.js';
import { kilo2MessageActivity, kilo2PartId } from './kilo2-message-activity.js';
import type { Kilo2Message } from '../../../src/shared/kilo2-conversation.js';
import { logToFile } from '../utils.js';

const nativeErrorSchema = z.object({
  type: z.string(),
  message: z.string(),
  status: z.number().int().optional(),
});

/** Native error types that the failure classifier knows by an SDK error name. */
const NATIVE_ERROR_NAMES = new Map([
  ['provider.auth', 'ProviderAuthError'],
  ['provider.content-filter', 'ContentFilterError'],
]);

/**
 * Kilo v2 classifies a rate limit from a provider code or text as well, so the
 * error can arrive without an HTTP status.
 */
const NATIVE_ERROR_STATUSES = new Map([['provider.rate-limit', 429]]);

/**
 * The native execution error in the shape `classifyAssistantFailure` reads.
 * An HTTP status is the most specific signal, so it becomes an `APIError`.
 */
export function nativeTurnError(error: z.infer<typeof nativeErrorSchema>) {
  const status = error.status ?? NATIVE_ERROR_STATUSES.get(error.type);
  if (status !== undefined)
    return { name: 'APIError', data: { message: error.message, statusCode: status } };
  return {
    name: NATIVE_ERROR_NAMES.get(error.type) ?? 'UnknownError',
    data: { message: error.message },
  };
}

const MAX_FRAME_CHARS = 4 * 1024 * 1024;
const MAX_TRACKED_MESSAGES = 1024;

/** V2 uses SSE comments for heartbeats. Preserve them as wrapper liveness evidence. */
export async function* readKilo2Sse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) return;
      buffer = (buffer + decoder.decode(next.value, { stream: true })).replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.length > MAX_FRAME_CHARS)
          throw new Error('Kilo v2 event exceeded its bounded window');
        yield frame;
      }
      if (buffer.length > MAX_FRAME_CHARS)
        throw new Error('Kilo v2 event exceeded its bounded window');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createKilo2EventFeed(options: KiloEventFeedOptions): KiloEventFeed {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const api = createKilo2Api(options.source.server);
  const { session, messages } = createKilo2Reads(api, options.source.directory);
  const log = options.log ?? logToFile;
  // Each projection re-reads recent messages; forward only assistant messages that changed.
  // A digest keeps change detection from retaining every full native message.
  const projected = new Map<string, string>();
  const emittedPermissions = new Map<string, string>();
  function changed(sessionId: string, message: Kilo2Message) {
    const key = `${sessionId}/${message.id}`;
    const value = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    if (projected.get(key) === value) return false;
    projected.delete(key);
    projected.set(key, value);
    if (projected.size > MAX_TRACKED_MESSAGES) {
      const oldest = projected.keys().next().value;
      if (oldest !== undefined) projected.delete(oldest);
    }
    return true;
  }
  let opened = false;
  let frames: AsyncGenerator<string> | undefined;

  function emit(type: string, properties: Record<string, unknown>, directory?: string) {
    if (!signal.aborted)
      options.onEvent({
        type,
        properties,
        directory,
        nativeRuntimeId: options.source.nativeRuntimeId,
      });
  }
  function report(activity: HarnessActivity, directory?: string) {
    if (!signal.aborted)
      options.onHarnessActivity?.({
        activity,
        directory,
        nativeRuntimeId: options.source.nativeRuntimeId,
      });
  }
  async function translate(frame: string) {
    const data = frame
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data) {
      if (frame.startsWith(':')) emit('server.heartbeat', {});
      return;
    }
    const event = kilo2EventSchema.parse(JSON.parse(data));
    if (event.type === 'server.connected') {
      emit(event.type, {});
      return;
    }
    const directory = event.location?.directory;
    const id = event.data.sessionID;
    if (typeof id === 'string')
      emit('conversation.event', { sessionID: id, source: { version: 'v2' }, event }, directory);
    if (event.type === 'form.created') {
      const form = kilo2FormSchema.parse(event.data.form);
      emit('question.asked', projectKilo2Question(form), directory);
      return;
    }
    if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      emit(
        event.type === 'form.replied' ? 'question.replied' : 'question.rejected',
        { sessionID: id, requestID: event.data.id },
        directory
      );
      return;
    }
    if (event.type === 'permission.asked') {
      // Envelope IDs do not identify permission requests. V2's event schema
      // omits the request ID; the pending list owns that identity.
      const permissionDirectory = directory ?? options.source.directory;
      const pending = z.array(kilo2PermissionSchema).parse(
        await api.data(`/api/permission/request?${kilo2LocationQuery(permissionDirectory)}`, {
          signal,
        })
      );
      const pendingIds = new Set(pending.map(request => request.id));
      for (const [requestId, requestDirectory] of emittedPermissions)
        if (requestDirectory === permissionDirectory && !pendingIds.has(requestId))
          emittedPermissions.delete(requestId);
      for (const request of pending) {
        if (
          request.sessionID === id &&
          request.action === event.data.action &&
          !emittedPermissions.has(request.id)
        ) {
          emittedPermissions.set(request.id, permissionDirectory);
          emit('permission.asked', projectKilo2Permission(request), directory);
        }
      }
      return;
    }
    if (event.type === 'permission.replied') {
      emit(event.type, event.data, directory);
      return;
    }
    if (typeof id !== 'string') return;
    const textKind = event.type.startsWith('session.text.')
      ? 'text'
      : event.type.startsWith('session.reasoning.')
        ? 'reasoning'
        : undefined;
    if (textKind) {
      const text = z
        .object({
          assistantMessageID: z.string(),
          ordinal: z.number().int().nonnegative(),
          delta: z.string().optional(),
          text: z.string().optional(),
        })
        .parse(event.data);
      const partId = kilo2PartId(text.assistantMessageID, textKind, text.ordinal);
      if (event.type.endsWith('.delta'))
        report(
          {
            type: 'delta',
            sessionId: id,
            messageId: text.assistantMessageID,
            partId,
            text: text.delta ?? '',
          },
          directory
        );
      else
        report(
          {
            type: 'part',
            part: {
              sessionId: id,
              messageId: text.assistantMessageID,
              id: partId,
              kind: textKind,
              text: text.text ?? '',
            },
          },
          directory
        );
      return;
    }
    if (event.type.endsWith('.delta')) return;
    if (event.type === 'session.deleted') {
      emit(event.type, { info: { id } }, directory);
      return;
    }
    // Terminal and retry state does not depend on the native reads below; a failed read
    // must not leave the turn open.
    let nativeDirectory = directory;
    try {
      const info = await session(id, signal);
      nativeDirectory = info.location.directory;
      emit(
        'conversation.source',
        { sessionID: id, source: { version: 'v2', session: info } },
        nativeDirectory
      );
      if (event.type === 'session.created' || event.type === 'session.renamed') {
        emit(
          event.type === 'session.created' ? 'session.created' : 'session.updated',
          { info: { ...info, directory: nativeDirectory } },
          nativeDirectory
        );
      }
      if (event.type === 'session.execution.started') {
        emit('session.turn.open', { sessionID: id }, nativeDirectory);
        emit('session.status', { sessionID: id, status: { type: 'busy' } }, nativeDirectory);
      }
      // Read the native database. This preserves content ordinals, tool state,
      // and user-message identity without maintaining a second execution state machine.
      if (
        event.type === 'session.inbox.delivered' ||
        event.type.startsWith('session.step.') ||
        event.type.startsWith('session.tool.') ||
        event.type.startsWith('session.execution.')
      ) {
        // The prompt an assistant message answers is the user message before it.
        let parentID = '';
        for (const message of (await messages(id, signal)).messages) {
          const activity = kilo2MessageActivity(id, message);
          if (!activity) continue;
          const { parts, ...summary } = activity;
          const answers = parentID;
          if (summary.role === 'user') parentID = message.id;
          // A database read can overtake this event and include the next queued
          // prompt. Only its own delivery event may acknowledge a user message.
          if (
            summary.role === 'user' &&
            (event.type !== 'session.inbox.delivered' || message.id !== event.data.inboxID)
          )
            continue;
          // A step start reports only its assistant message and omits parts.
          // It neither records nor suppresses a later full read.
          if (event.type === 'session.step.started' && message.id !== event.data.assistantMessageID)
            continue;
          if (
            summary.role === 'assistant' &&
            event.type !== 'session.step.started' &&
            !changed(id, message)
          )
            continue;
          report({ type: 'message', message: summary }, nativeDirectory);
          emit(
            'conversation.message.updated',
            {
              sessionID: id,
              source: { version: 'v2', session: info },
              message,
              ...(summary.role === 'assistant' ? { parentID: answers } : {}),
            },
            nativeDirectory
          );
          if (event.type !== 'session.step.started')
            for (const part of parts) report({ type: 'part', part }, nativeDirectory);
        }
      }
    } finally {
      if (event.type === 'session.retry.scheduled') {
        const retry = z
          .object({ attempt: z.number(), at: z.number(), error: z.object({ message: z.string() }) })
          .parse(event.data);
        emit(
          'session.status',
          {
            sessionID: id,
            status: {
              type: 'retry',
              attempt: retry.attempt,
              next: retry.at,
              message: retry.error.message,
            },
          },
          nativeDirectory
        );
      }
      if (
        [
          'session.execution.succeeded',
          'session.execution.failed',
          'session.execution.interrupted',
        ].includes(event.type)
      ) {
        const reason = event.type.endsWith('.succeeded')
          ? 'completed'
          : event.type.endsWith('.failed')
            ? 'error'
            : 'interrupted';
        const error = nativeErrorSchema.safeParse(event.data.error);
        // The supervisor settles a close after the native status becomes idle.
        emit('session.status', { sessionID: id, status: { type: 'idle' } }, nativeDirectory);
        emit(
          'session.turn.close',
          {
            sessionID: id,
            reason,
            ...(error.success ? { error: nativeTurnError(error.data) } : {}),
          },
          nativeDirectory
        );
        emit('session.idle', { sessionID: id }, nativeDirectory);
      }
    }
  }
  async function consume() {
    try {
      if (frames)
        for await (const frame of frames) {
          try {
            await translate(frame);
          } catch (error) {
            if (signal.aborted) throw error;
            // SSE does not replay, so one bad frame or failed read must not end the feed.
            log(
              `kilo2 feed phase=frame_failed error=${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
    } catch {
      /* The runtime owns bounded reconnect and recovery. */
    }
    if (!signal.aborted) options.onFailure();
  }
  return {
    async open() {
      if (opened) throw new Error('Kilo v2 event feed is already open');
      const response = await fetchKiloServer(options.source.server, '/api/event', {
        signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!response.ok || !response.body) throw new Error('Kilo v2 event feed is unavailable');
      frames = readKilo2Sse(response.body, signal);
      const first = await frames.next();
      if (first.done) throw new Error('Kilo v2 event feed did not connect');
      await translate(first.value);
      opened = true;
      void consume().catch(() => undefined);
    },
    close() {
      lifetime.abort();
    },
  };
}
