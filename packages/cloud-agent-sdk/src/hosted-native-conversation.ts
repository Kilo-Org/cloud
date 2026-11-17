import { z } from 'zod';
import { readNativeConversation } from './native-conversation-source';
import type { NativeSessionState, NativeSyncClient } from './native-sync';
import { normalizeCliEvent, type ChatEvent, type ServiceEvent } from './normalizer';
import { replayStoredMessages } from './snapshot-page';
import type { TransportSink } from './transport';
import type { SessionSnapshot } from './types';
import type { SessionStatus } from './schemas';

export async function readHostedNativePage(
  client: NativeSyncClient,
  sessionID: string,
  organizationId?: string
) {
  const snapshot = await client.getSnapshot(sessionID, organizationId);
  const conversation = readNativeConversation({
    session: snapshot.session,
    snapshot: { position: snapshot.position, revision: snapshot.revision },
    messages: snapshot.messages,
    assetURLs: snapshot.assetURLs,
    connection: 'disconnected',
    runnerConnected: false,
    events: [],
    pending: { permissions: [], questions: [], unreadablePermissions: [] },
    commands: {},
  });
  if (!conversation.session || conversation.incompleteMessageIDs.length > 0)
    throw new Error(conversation.error ?? 'Native session metadata is unavailable');
  const last = snapshot.messages.at(-1)?.message;
  return {
    info: { id: conversation.session.id },
    messages: conversation.messages,
    nextCursor: null,
    omittedItemCount: 0,
    executionError: last?.type === 'idle' ? last.error?.message : undefined,
  };
}

const remoteStateSchema = z.object({
  incarnation: z.string().min(1),
  runID: z.string().min(1).nullable(),
  running: z.boolean(),
});
type Pending = { questions: unknown[]; permissions: unknown[] };

function nativePending(state: NativeSessionState): Pending {
  return {
    questions: state.pending.questions.map(form => ({
      id: form.id,
      questions: form.fields.map(field => ({
        header: field.title ?? form.title ?? '',
        question: field.description ?? field.title ?? form.title ?? '',
        options: (field.options ?? []).map(option => ({
          label: option.label ?? option.value,
          description: '',
        })),
        multiple: field.type === 'multiselect',
        custom: field.custom ?? !field.options?.length,
      })),
    })),
    permissions: state.pending.permissions.map(request => ({
      id: request.id,
      permission:
        request.action === 'shell'
          ? 'bash'
          : request.action === 'subagent'
            ? 'task'
            : request.action,
      patterns: request.resources,
      metadata: request['metadata'] ?? {},
      always: request['save'] ?? [],
    })),
  };
}

export function createHostedNativeConversation(sink: TransportSink, sessionID: string) {
  let previous: SessionSnapshot['messages'] = [];
  let revision = 0;
  let native: NativeSessionState | undefined;
  let cloud: Pending = { questions: [], permissions: [] };
  let cloudSessionStatus: SessionStatus = { type: 'idle' };
  let cloudMessageId: string | null | undefined;
  let currentRequests = new Map<string, ServiceEvent>();

  function interactions() {
    const frame = native?.events.find(event => event.type === 'remote.state');
    const remote =
      native?.connection === 'connected' &&
      native.runnerConnected &&
      frame !== undefined &&
      native.liveAfterSeq !== undefined &&
      frame.seq > native.liveAfterSeq
        ? remoteStateSchema.safeParse(frame?.body)
        : undefined;
    const controlled =
      remote?.success === true && remote.data.running && remote.data.runID !== null;
    const pending = controlled && native ? nativePending(native) : cloud;
    const next = new Map<string, ServiceEvent>();
    for (const [collection, type] of [
      ['questions', 'question.asked'],
      ['permissions', 'permission.asked'],
    ] as const) {
      for (const item of pending[collection]) {
        const event = normalizeCliEvent(type, item);
        if (event && 'requestId' in event) next.set(`${collection}:${event.requestId}`, event);
      }
    }
    if (controlled && native) {
      for (const item of native.pending.unreadablePermissions)
        next.set(`permissions:${item.requestId}`, {
          type: 'permission.unreadable',
          requestId: item.requestId,
        });
    }
    sink.onServiceEvent({
      type: 'session.status',
      sessionId: sessionID,
      status: remote?.success
        ? { type: remote.data.running ? 'busy' : 'idle' }
        : cloudSessionStatus,
    });
    for (const [key, event] of currentRequests) {
      if (next.has(key) || !('requestId' in event)) continue;
      sink.onServiceEvent({
        type: key.startsWith('questions:') ? 'question.replied' : 'permission.replied',
        requestId: event.requestId,
      });
    }
    for (const [key, event] of next) {
      if (JSON.stringify(currentRequests.get(key)) !== JSON.stringify(event))
        sink.onServiceEvent(event);
    }
    currentRequests = next;
  }

  return {
    updateCloud(event: ServiceEvent) {
      if (event.type === 'connected') {
        if (event.pendingInteractions) cloud = event.pendingInteractions;
        cloudSessionStatus = event.sessionStatus ?? cloudSessionStatus;
        cloudMessageId = event.activeMessageId;
        currentRequests.clear();
      } else if (event.type === 'cloud.interactions') cloud = event.pendingInteractions;
      else if (event.type === 'cloud.message.sent') {
        cloudMessageId = event.messageId;
        cloudSessionStatus = { type: 'busy' };
      } else if (
        (event.type === 'cloud.message.completed' ||
          event.type === 'cloud.message.failed' ||
          event.type === 'cloud.message.canceled') &&
        event.messageId === cloudMessageId
      ) {
        cloudMessageId = null;
        cloudSessionStatus = { type: 'idle' };
      }
      interactions();
    },
    updateNative(state: NativeSessionState) {
      native = state;
      const conversation = readNativeConversation(state);
      if (conversation.session) {
        sink.onServiceEvent({ type: 'session.updated', info: { id: conversation.session.id } });
        // Projection order is independent of native replay and Cloud infrastructure cursors.
        const version = { sourceId: `native:${sessionID}`, cursor: ++revision };
        const next = new Map(conversation.messages.map(message => [message.info.id, message]));
        for (const message of previous) {
          const replacement = next.get(message.info.id);
          if (!replacement) {
            if (!conversation.incompleteMessageIDs.includes(message.info.id))
              sink.onChatEvent({
                type: 'message.removed',
                sessionId: sessionID,
                messageId: message.info.id,
                version,
              });
            continue;
          }
          const parts = new Set(replacement.parts.map(part => part.id));
          for (const part of message.parts)
            if (!parts.has(part.id))
              sink.onChatEvent({
                type: 'message.part.removed',
                sessionId: sessionID,
                messageId: message.info.id,
                partId: part.id,
                version,
              });
        }
        replayStoredMessages(
          conversation.messages,
          (event: ChatEvent) => sink.onChatEvent(event),
          version
        );
        previous = [
          ...conversation.messages,
          ...previous.filter(
            message =>
              !next.has(message.info.id) &&
              conversation.incompleteMessageIDs.includes(message.info.id)
          ),
        ];
      }
      interactions();
      return conversation;
    },
  };
}
