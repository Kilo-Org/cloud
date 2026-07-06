/**
 * CLI live transport - consumes a shared user web connection and translates
 * one remote CLI session into normalized transport events and commands.
 */
import { normalizeCliEvent, isChatEvent } from './normalizer';
import {
  cliConnectionDataSchema,
  heartbeatDataSchema,
  remoteModelCatalogV1Schema,
  sessionsListDataSchema,
} from './schemas';
import type { RemoteModelState } from './remote-model-catalog';
import type { TransportFactory, TransportSendInput, TransportSink } from './transport';
import type { KiloSessionId, SessionSnapshot } from './types';
import {
  UserWebCommandError,
  type UserWebCliEvent,
  type UserWebConnection,
} from './user-web-connection';

type CliLiveTransportConfig = {
  kiloSessionId: KiloSessionId;
  userWebConnection: UserWebConnection;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onError?: (message: string) => void;
  onRemoteModelStateChange?: (state: RemoteModelState) => void;
  onCapabilityChange?: () => void;
};

// How long after a reconnect to re-fetch the snapshot a second time. Covers
// the session store's persistence lag behind the live stream; bump if holes
// still appear after long backgrounding.
const RECONNECT_RESYNC_DELAY_MS = 5000;

function createCliLiveTransport(config: CliLiveTransportConfig): TransportFactory {
  return (sink: TransportSink) => {
    let generation = 0;
    let cleanup: (() => void) | null = null;
    let sessionStopped = false;
    let ownerConnectionId: string | null = null;
    let lastForwardedHeartbeatStatus: string | null = null;
    let catalogRequestGeneration = 0;
    let catalogRequestInFlight: { ownerConnectionId: string; generation: number } | null = null;
    let remoteModelState: RemoteModelState = {
      ownerConnectionId: null,
      protocol: 'unknown',
      refresh: 'idle',
    };

    function publishRemoteModelState(next: RemoteModelState): void {
      remoteModelState = next;
      config.onRemoteModelStateChange?.(next);
    }

    function setOwnerConnectionId(nextOwnerConnectionId: string | null): void {
      if (ownerConnectionId === nextOwnerConnectionId) return;

      ownerConnectionId = nextOwnerConnectionId;
      catalogRequestGeneration += 1;
      catalogRequestInFlight = null;
      publishRemoteModelState({
        ownerConnectionId: nextOwnerConnectionId,
        protocol: 'unknown',
        refresh: nextOwnerConnectionId ? 'loading' : 'idle',
      });
      config.onCapabilityChange?.();

      if (nextOwnerConnectionId) discoverModels(nextOwnerConnectionId);
    }

    function handleCatalogFailure(
      error: unknown,
      expectedOwnerConnectionId: string,
      expectedGeneration: number,
      expectedRequestGeneration: number
    ): void {
      if (
        expectedGeneration !== generation ||
        expectedRequestGeneration !== catalogRequestGeneration ||
        ownerConnectionId !== expectedOwnerConnectionId
      ) {
        return;
      }

      if (error instanceof UserWebCommandError && error.code === 'SESSION_OWNER_CHANGED') {
        setOwnerConnectionId(null);
        return;
      }

      if (error instanceof Error && error.message.includes('unknown command')) {
        publishRemoteModelState({
          ownerConnectionId: expectedOwnerConnectionId,
          protocol: 'legacy',
          refresh: 'idle',
        });
        return;
      }

      publishRemoteModelState({
        ownerConnectionId: expectedOwnerConnectionId,
        protocol: remoteModelState.protocol,
        ...(remoteModelState.catalog ? { catalog: remoteModelState.catalog } : {}),
        refresh: 'error',
        error: error instanceof Error ? error.message : 'Failed to discover remote models',
      });
    }

    function discoverModels(expectedOwnerConnectionId: string): void {
      if (catalogRequestInFlight?.ownerConnectionId === expectedOwnerConnectionId) return;

      catalogRequestGeneration += 1;
      const expectedRequestGeneration = catalogRequestGeneration;
      const expectedGeneration = generation;
      catalogRequestInFlight = {
        ownerConnectionId: expectedOwnerConnectionId,
        generation: expectedRequestGeneration,
      };
      publishRemoteModelState({
        ownerConnectionId: expectedOwnerConnectionId,
        protocol: remoteModelState.protocol,
        ...(remoteModelState.catalog ? { catalog: remoteModelState.catalog } : {}),
        refresh: 'loading',
      });

      void config.userWebConnection
        .sendCommand(
          config.kiloSessionId,
          'list_models',
          { protocolVersion: 1 },
          expectedOwnerConnectionId
        )
        .then(
          result => {
            if (
              expectedGeneration !== generation ||
              expectedRequestGeneration !== catalogRequestGeneration ||
              ownerConnectionId !== expectedOwnerConnectionId
            ) {
              return;
            }

            const parsed = remoteModelCatalogV1Schema.safeParse(result);
            if (!parsed.success) {
              handleCatalogFailure(
                new Error('Invalid remote model catalog'),
                expectedOwnerConnectionId,
                expectedGeneration,
                expectedRequestGeneration
              );
              return;
            }

            publishRemoteModelState({
              ownerConnectionId: expectedOwnerConnectionId,
              protocol: 'v1',
              catalog: parsed.data,
              refresh: 'idle',
            });
          },
          error =>
            handleCatalogFailure(
              error,
              expectedOwnerConnectionId,
              expectedGeneration,
              expectedRequestGeneration
            )
        )
        .finally(() => {
          if (catalogRequestInFlight?.generation === expectedRequestGeneration) {
            catalogRequestInFlight = null;
          }
        });
    }

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
      // The disconnected state is only cleared by a session.status event, so
      // the next post-reconnect heartbeat must always forward one — even when
      // the CLI comes back with the same status it had before the drop.
      lastForwardedHeartbeatStatus = null;
    }

    // Heartbeats carry the CLI's current per-session status. Forwarding it
    // re-derives activity after a reconnect: a terminal `session.status: idle`
    // fired while the socket was dead is never replayed, which otherwise
    // leaves the UI stuck on a busy indicator forever.
    function forwardHeartbeatStatus(status: string): void {
      if (status !== 'idle' && status !== 'busy') return;
      if (status === lastForwardedHeartbeatStatus) return;
      lastForwardedHeartbeatStatus = status;
      sink.onServiceEvent({
        type: 'session.status',
        sessionId: config.kiloSessionId,
        status: { type: status },
      });
    }

    function handleSystemMessage(event: string, data: unknown): void {
      if (event === 'cli.disconnected') {
        const parsed = cliConnectionDataSchema.safeParse(data);
        if (parsed.success && ownerConnectionId === parsed.data.connectionId) {
          setOwnerConnectionId(null);
          stopForDisconnectedSession();
        }
        return;
      }

      if (event === 'sessions.list') {
        const parsed = sessionsListDataSchema.safeParse(data);
        if (!parsed.success) return;

        const session = parsed.data.sessions.find(item => item.id === config.kiloSessionId);
        if (session) {
          setOwnerConnectionId(session.connectionId);
          sessionStopped = false;
          forwardHeartbeatStatus(session.status);
          return;
        }

        setOwnerConnectionId(null);
        stopForDisconnectedSession();
        return;
      }

      if (event === 'sessions.heartbeat') {
        const parsed = heartbeatDataSchema.safeParse(data);
        if (!parsed.success) return;

        const session = parsed.data.sessions.find(item => item.id === config.kiloSessionId);
        if (session) {
          setOwnerConnectionId(parsed.data.connectionId);
          sessionStopped = false;
          forwardHeartbeatStatus(session.status);
          return;
        }

        if (ownerConnectionId === parsed.data.connectionId) {
          setOwnerConnectionId(null);
          stopForDisconnectedSession();
        }
      }
    }

    async function sendCommand(command: string, data: unknown): Promise<unknown> {
      const expectedOwnerConnectionId = ownerConnectionId;
      if (!expectedOwnerConnectionId) throw new Error('Remote session has no connected owner');

      try {
        return await config.userWebConnection.sendCommand(
          config.kiloSessionId,
          command,
          data,
          expectedOwnerConnectionId
        );
      } catch (error) {
        if (error instanceof UserWebCommandError && error.code === 'SESSION_OWNER_CHANGED') {
          setOwnerConnectionId(null);
        }
        throw error;
      }
    }

    function getRemoteModelFields(input: TransportSendInput):
      | { kind: 'none' }
      | {
          kind: 'structured';
          model: { providerID: string; modelID: string };
          variant?: string;
        }
      | { kind: 'legacy'; model: string; variant?: string } {
      const override = input.remoteModelOverride;
      if (!override) return { kind: 'none' };

      if (remoteModelState.protocol === 'v1' && override.source === 'cli-catalog') {
        const provider = remoteModelState.catalog?.providers.find(
          item => item.id === override.selection.model.providerID
        );
        const model = provider?.models.find(item => item.id === override.selection.model.modelID);
        if (!model) {
          throw new Error('Selected remote model is not available in the current CLI catalog');
        }

        const variant = override.selection.variant;
        if (variant && !model.variants.includes(variant)) {
          throw new Error(
            'Selected remote model variant is not available in the current CLI catalog'
          );
        }
        return {
          kind: 'structured',
          model: override.selection.model,
          ...(variant ? { variant } : {}),
        };
      }

      if (
        remoteModelState.protocol === 'legacy' &&
        override.source === 'legacy-gateway' &&
        override.selection.model.providerID === 'kilo'
      ) {
        return {
          kind: 'legacy',
          model: override.selection.model.modelID,
          ...(override.selection.variant ? { variant: override.selection.variant } : {}),
        };
      }

      throw new Error(
        'Selected remote model override is incompatible with the connected CLI model protocol'
      );
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
        lastForwardedHeartbeatStatus = null;
        catalogRequestGeneration += 1;
        catalogRequestInFlight = null;
        publishRemoteModelState({
          ownerConnectionId: null,
          protocol: 'unknown',
          refresh: 'idle',
        });
        config.onCapabilityChange?.();
        let resyncTimer: ReturnType<typeof setTimeout> | null = null;

        let bufferedCliEvents: UserWebCliEvent[] | null = [];
        let bufferedEventsFromSupersededSnapshot: UserWebCliEvent[] = [];
        let snapshotReplayGeneration = 0;

        const drainBufferedCliEvents = (): void => {
          const events = bufferedCliEvents;
          bufferedCliEvents = null;
          for (const msg of events ?? []) {
            handleEventMessage(msg.sessionId, msg.parentSessionId, msg.event, msg.data);
          }
          sink.onReplayComplete?.();
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
          const shouldBufferForSnapshot =
            normalized &&
            (isChatEvent(normalized) ||
              normalized.type === 'session.created' ||
              normalized.type === 'session.updated');
          if (shouldBufferForSnapshot && bufferedCliEvents !== null) {
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
          // The snapshot store lags the live stream, and the CLI only forwards
          // events "from now" after a resubscribe — parts finalized while the
          // socket was dead are in neither. One delayed re-sync picks them up
          // once persistence catches up.
          if (resyncTimer) clearTimeout(resyncTimer);
          resyncTimer = setTimeout(() => {
            resyncTimer = null;
            replayCurrentSnapshot(false);
          }, RECONNECT_RESYNC_DELAY_MS);
          if (ownerConnectionId) discoverModels(ownerConnectionId);
        });
        const releaseSubscription = config.userWebConnection.subscribeToCliSession(
          config.kiloSessionId
        );
        let released = false;
        cleanup = () => {
          if (released) return;
          released = true;
          if (resyncTimer) clearTimeout(resyncTimer);
          offCli();
          offSystem();
          offReconnect();
          releaseSubscription();
        };
      },

      canSend: () => ownerConnectionId !== null,
      retryRemoteModels: () => {
        if (ownerConnectionId) discoverModels(ownerConnectionId);
      },
      send: async (input: TransportSendInput) => {
        if (input.payload.type === 'command') {
          return Promise.reject(
            new Error('Slash commands are not supported on the CLI live transport yet')
          );
        }
        const payload = input.payload;
        const remoteModel = getRemoteModelFields(input);
        return sendCommand('send_message', {
          sessionID: config.kiloSessionId,
          parts: [{ type: 'text', text: payload.prompt }],
          ...(payload.mode ? { agent: payload.mode } : {}),
          ...(remoteModel.kind === 'none'
            ? {}
            : {
                model: remoteModel.model,
                ...(remoteModel.variant ? { variant: remoteModel.variant } : {}),
              }),
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
        setOwnerConnectionId(null);
        releaseConnection();
      },

      destroy() {
        generation += 1;
        setOwnerConnectionId(null);
        releaseConnection();
      },
    };
  };
}

export { createCliLiveTransport };
export type { CliLiveTransportConfig };
