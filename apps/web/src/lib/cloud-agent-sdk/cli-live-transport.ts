/**
 * CLI live transport - consumes a shared user web connection and translates
 * one remote CLI session into normalized transport events and commands.
 */
import { normalizeCliEvent, isChatEvent } from './normalizer';
import { cliConnectionDataSchema, heartbeatDataSchema, sessionsListDataSchema } from './schemas';
import type { TransportFactory, TransportSendPayload, TransportSink } from './transport';
import type { KiloSessionId, SessionSnapshot } from './types';
import type { UserWebCliEvent, UserWebConnection } from './user-web-connection';

type CliLiveTransportConfig = {
  kiloSessionId: KiloSessionId;
  userWebConnection: UserWebConnection;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onError?: (message: string) => void;
};

function createCliLiveTransport(config: CliLiveTransportConfig): TransportFactory {
  return (sink: TransportSink) => {
    let generation = 0;
    let cleanup: (() => void) | null = null;
    let sessionStopped = false;
    let ownerConnectionId: string | null = null;

    function replaySnapshot(snapshot: SessionSnapshot): void {
      sink.onServiceEvent({ type: 'session.created', info: snapshot.info });

      for (const msg of snapshot.messages) {
        sink.onChatEvent({ type: 'message.updated', info: msg.info });

        for (const part of msg.parts) {
          sink.onChatEvent({ type: 'message.part.updated', part });
        }
      }
    }

    function handleEventMessage(
      sessionId: string,
      parentSessionId: string | undefined,
      event: string,
      data: unknown
    ): void {
      if (sessionId !== config.kiloSessionId && parentSessionId !== config.kiloSessionId) return;

      const normalized = normalizeCliEvent(event, data);
      if (!normalized) return;

      if (isChatEvent(normalized)) {
        sink.onChatEvent(normalized);
      } else {
        sink.onServiceEvent(normalized);
      }
    }

    function stopForDisconnectedSession(): void {
      if (sessionStopped) return;
      sink.onServiceEvent({ type: 'stopped', reason: 'disconnected' });
      sessionStopped = true;
    }

    function handleSystemMessage(event: string, data: unknown): void {
      if (event === 'cli.disconnected') {
        const parsed = cliConnectionDataSchema.safeParse(data);
        if (parsed.success && ownerConnectionId === parsed.data.connectionId) {
          stopForDisconnectedSession();
        }
        return;
      }

      if (event === 'sessions.list') {
        const parsed = sessionsListDataSchema.safeParse(data);
        if (!parsed.success) return;

        const session = parsed.data.sessions.find(item => item.id === config.kiloSessionId);
        if (session) {
          ownerConnectionId = session.connectionId;
          sessionStopped = false;
          return;
        }

        stopForDisconnectedSession();
        return;
      }

      if (event === 'sessions.heartbeat') {
        const parsed = heartbeatDataSchema.safeParse(data);
        if (!parsed.success) return;

        const session = parsed.data.sessions.find(item => item.id === config.kiloSessionId);
        if (session) {
          ownerConnectionId = parsed.data.connectionId;
          sessionStopped = false;
          return;
        }

        if (ownerConnectionId === parsed.data.connectionId) {
          stopForDisconnectedSession();
        }
      }
    }

    function sendCommand(command: string, data: unknown): Promise<unknown> {
      return config.userWebConnection.sendCommand(config.kiloSessionId, command, data);
    }

    function releaseConnection(): void {
      cleanup?.();
      cleanup = null;
    }

    return {
      connect() {
        generation += 1;
        const expectedGeneration = generation;
        releaseConnection();
        sessionStopped = false;
        ownerConnectionId = null;

        let bufferedCliEvents: UserWebCliEvent[] | null = [];
        let bufferedEventsFromSupersededSnapshot: UserWebCliEvent[] = [];
        let snapshotReplayGeneration = 0;

        const drainBufferedCliEvents = (): void => {
          const events = bufferedCliEvents;
          bufferedCliEvents = null;
          for (const msg of events ?? []) {
            handleEventMessage(msg.sessionId, msg.parentSessionId, msg.event, msg.data);
          }
        };

        const replayCurrentSnapshot = (reportError: boolean): void => {
          snapshotReplayGeneration += 1;
          const expectedSnapshotReplayGeneration = snapshotReplayGeneration;
          if (bufferedCliEvents !== null) {
            bufferedEventsFromSupersededSnapshot.push(...bufferedCliEvents);
          }
          bufferedCliEvents = [];

          if (!config.fetchSnapshot) {
            bufferedCliEvents = [
              ...bufferedEventsFromSupersededSnapshot,
              ...(bufferedCliEvents ?? []),
            ];
            bufferedEventsFromSupersededSnapshot = [];
            drainBufferedCliEvents();
            return;
          }

          void config.fetchSnapshot(config.kiloSessionId).then(
            snapshot => {
              if (
                expectedGeneration !== generation ||
                expectedSnapshotReplayGeneration !== snapshotReplayGeneration
              ) {
                return;
              }
              bufferedEventsFromSupersededSnapshot = [];
              replaySnapshot(snapshot);
              drainBufferedCliEvents();
            },
            (error: unknown) => {
              if (
                expectedGeneration !== generation ||
                expectedSnapshotReplayGeneration !== snapshotReplayGeneration
              ) {
                return;
              }
              if (reportError) {
                const message = error instanceof Error ? error.message : 'Failed to fetch snapshot';
                config.onError?.(message);
              }
              bufferedCliEvents = [
                ...bufferedEventsFromSupersededSnapshot,
                ...(bufferedCliEvents ?? []),
              ];
              bufferedEventsFromSupersededSnapshot = [];
              drainBufferedCliEvents();
            }
          );
        };

        replayCurrentSnapshot(true);
        const offCli = config.userWebConnection.onCliEvent(config.kiloSessionId, msg => {
          const normalized = normalizeCliEvent(msg.event, msg.data);
          if (normalized && isChatEvent(normalized) && bufferedCliEvents !== null) {
            bufferedCliEvents.push(msg);
            return;
          }
          handleEventMessage(msg.sessionId, msg.parentSessionId, msg.event, msg.data);
        });
        const offSystem = config.userWebConnection.onSystemEvent(msg => {
          handleSystemMessage(msg.event, msg.data);
        });
        const offReconnect = config.userWebConnection.onReconnect(() => {
          replayCurrentSnapshot(false);
        });
        const releaseSubscription = config.userWebConnection.subscribeToCliSession(
          config.kiloSessionId
        );
        let released = false;
        cleanup = () => {
          if (released) return;
          released = true;
          offCli();
          offSystem();
          offReconnect();
          releaseSubscription();
        };
      },

      send: (input: { payload: TransportSendPayload }) => {
        if (input.payload.type === 'command') {
          return Promise.reject(
            new Error('Slash commands are not supported on the CLI live transport yet')
          );
        }
        const payload = input.payload;
        return sendCommand('send_message', {
          sessionID: config.kiloSessionId,
          parts: [{ type: 'text', text: payload.prompt }],
          ...(payload.mode ? { agent: payload.mode } : {}),
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.variant ? { variant: payload.variant } : {}),
        });
      },
      interrupt: () => sendCommand('interrupt', {}),
      answer: payload =>
        sendCommand('question_reply', {
          requestID: payload.requestId,
          answers: payload.answers,
        }),
      reject: payload =>
        sendCommand('question_reject', {
          requestID: payload.requestId,
        }),
      respondToPermission: payload =>
        sendCommand('permission_respond', {
          requestID: payload.requestId,
          reply: payload.response,
        }),
      acceptSuggestion: payload =>
        sendCommand('suggestion_accept', {
          requestID: payload.requestId,
          index: payload.index,
        }),
      dismissSuggestion: payload =>
        sendCommand('suggestion_dismiss', {
          requestID: payload.requestId,
        }),

      disconnect() {
        generation += 1;
        releaseConnection();
      },

      destroy() {
        generation += 1;
        releaseConnection();
      },
    };
  };
}

export { createCliLiveTransport };
export type { CliLiveTransportConfig };
