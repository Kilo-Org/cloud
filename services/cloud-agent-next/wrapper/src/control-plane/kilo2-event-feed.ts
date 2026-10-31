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
import { kilo2PartId } from './kilo2-messages.js';

const MAX_FRAME_CHARS = 4 * 1024 * 1024;

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
  let opened = false;
  let frames: AsyncGenerator<string> | undefined;

  function emit(type: string, properties: Record<string, unknown>, directory?: string) {
    if (!signal.aborted)
      options.onEvent({
        type,
        properties,
        ...(type.startsWith('message.') ? { audience: 'supervisor' as const } : {}),
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
      const pending = z
        .array(kilo2PermissionSchema)
        .parse(
          await api.data(
            `/api/permission/request?${kilo2LocationQuery(directory ?? options.source.directory)}`,
            { signal }
          )
        );
      for (const request of pending) {
        if (request.sessionID === id && request.action === event.data.action)
          emit('permission.asked', projectKilo2Permission(request), directory);
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
      const identity = {
        sessionID: id,
        messageID: text.assistantMessageID,
        id: kilo2PartId(text.assistantMessageID, textKind, text.ordinal),
      };
      if (event.type.endsWith('.delta'))
        emit(
          'message.part.delta',
          {
            sessionID: id,
            messageID: text.assistantMessageID,
            partID: identity.id,
            field: 'text',
            delta: text.delta ?? '',
          },
          directory
        );
      else
        emit(
          'message.part.updated',
          {
            part: {
              ...identity,
              type: textKind,
              text: text.text ?? '',
              ...(textKind === 'reasoning' ? { time: { start: event.created ?? Date.now() } } : {}),
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
    const info = await session(id, signal);
    const nativeDirectory = info.location.directory;
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
    // Project from the native database. This preserves content ordinals, tool state,
    // and user-message identity without maintaining a second execution state machine.
    if (
      event.type === 'session.inbox.delivered' ||
      event.type.startsWith('session.step.') ||
      event.type.startsWith('session.tool.') ||
      event.type.startsWith('session.execution.')
    ) {
      for (const message of await messages(id, nativeDirectory, signal)) {
        // A database read can overtake this event and include the next queued
        // prompt. Only its own delivery event may acknowledge a user message.
        if (
          message.info.role === 'user' &&
          (event.type !== 'session.inbox.delivered' || message.info.id !== event.data.inboxID)
        )
          continue;
        emit('message.updated', { info: message.info }, nativeDirectory);
        emit(
          'conversation.message.updated',
          {
            sessionID: id,
            source: { version: 'v2', session: info },
            message: message.info.kilo2,
            ...('parentID' in message.info ? { parentID: message.info.parentID } : {}),
          },
          nativeDirectory
        );
        if (event.type !== 'session.step.started')
          for (const part of message.parts) emit('message.part.updated', { part }, nativeDirectory);
      }
    }
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
      const error = z.object({ message: z.string() }).safeParse(event.data.error);
      // The supervisor settles a close after the native status becomes idle.
      emit('session.status', { sessionID: id, status: { type: 'idle' } }, nativeDirectory);
      emit(
        'session.turn.close',
        {
          sessionID: id,
          reason,
          ...(error.success
            ? { error: { name: 'UnknownError', data: { message: error.data.message } } }
            : {}),
        },
        nativeDirectory
      );
      emit('session.idle', { sessionID: id }, nativeDirectory);
    }
  }
  async function consume() {
    try {
      if (frames) for await (const frame of frames) await translate(frame);
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
      void consume();
    },
    close() {
      lifetime.abort();
    },
  };
}
