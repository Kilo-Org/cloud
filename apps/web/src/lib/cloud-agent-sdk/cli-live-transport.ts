/**
 * CLI live transport - consumes a shared user web connection and translates
 * one remote CLI session into normalized transport events and commands.
 */
import { normalizeCliEvent, isChatEvent } from './normalizer';
import { parseRemoteCommandCatalog, type RemoteCommandState } from './remote-command-catalog';
import { parseCreateSessionResponse } from './create-session';
import { parseExitCliResponse } from './exit-cli';
import {
  cliConnectionDataSchema,
  heartbeatDataSchema,
  remoteModelCatalogV1Schema,
  sessionsListDataSchema,
} from './schemas';
import type { SlashCommandInfo } from './schemas';
import type { RemoteModelState } from './remote-model-catalog';
import type { TransportFactory, TransportSendInput, TransportSink } from './transport';
import type {
  KiloSessionId,
  SessionSnapshot,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
} from './types';
import {
  UserWebCommandError,
  type UserWebCliEvent,
  type UserWebConnection,
} from './user-web-connection';

type CliLiveTransportConfig = {
  kiloSessionId: KiloSessionId;
  userWebConnection: UserWebConnection;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  /**
   * Page-aware root snapshot fetch. When provided, every `replayCurrentSnapshot`
   * (initial bounded read AND reconnect immediate + delayed resync) uses it
   * so the transport never overwrites older messages already loaded via
   * `loadOlderMessages`. The initial read additionally fires
   * `onInitialPageLoaded` so the manager can record the cursor.
   */
  fetchSnapshotPage?: (
    kiloSessionId: KiloSessionId,
    options: { cursor?: string }
  ) => Promise<SessionSnapshotPageOutcome | null>;
  /**
   * Called after a successful initial bounded page read. Reconnect and
   * delayed-resync replays do NOT call this so the user's already-advanced
   * older-messages cursor is never reset to the latest 50.
   */
  onInitialPageLoaded?: (page: SessionSnapshotPage) => void;
  onError?: (message: string) => void;
  onRemoteModelStateChange?: (state: RemoteModelState) => void;
  onRemoteCommandStateChange?: (state: RemoteCommandState) => void;
  onCapabilityChange?: () => void;
};

// How long after a reconnect to re-fetch the snapshot a second time. Covers
// the session store's persistence lag behind the live stream; bump if holes
// still appear after long backgrounding.
const RECONNECT_RESYNC_DELAY_MS = 5000;
const REMOTE_CLI_EXIT_UNAVAILABLE = 'Remote CLI exit is unavailable for the current session';

/**
 * Deep-copy a list of validated remote slash commands.
 *
 * Creates a new outer array, new command objects, and new hints arrays
 * so each emitted snapshot (event, internal cache, state callback) is
 * independent. Optional string/boolean fields are spread verbatim; the
 * schema has already validated them. Avoids `JSON.parse(JSON.stringify(...))`
 * because the shape is known and bounded.
 */
export function deepCopyCommands(commands: SlashCommandInfo[]): SlashCommandInfo[] {
  return commands.map(command => ({
    ...command,
    hints: command.hints.slice(),
  }));
}

function createCliLiveTransport(config: CliLiveTransportConfig): TransportFactory {
  return (sink: TransportSink) => {
    let generation = 0;
    let cleanup: (() => void) | null = null;
    let sessionStopped = false;
    let ownerConnectionId: string | null = null;
    let lastForwardedHeartbeatStatus: string | null = null;
    let catalogRequestGeneration = 0;
    let catalogRequestInFlight: { ownerConnectionId: string; generation: number } | null = null;
    // Command catalog discovery runs on its own generation so it stays
    // independent of model discovery: a model refresh that completes or
    // fails must not drop an in-flight command catalog request.
    let commandCatalogRequestGeneration = 0;
    let commandCatalogRequestInFlight: {
      ownerConnectionId: string;
      generation: number;
    } | null = null;
    let remoteModelState: RemoteModelState = {
      ownerConnectionId: null,
      protocol: 'unknown',
      refresh: 'idle',
    };
    let remoteCommandState: RemoteCommandState = {
      ownerConnectionId: null,
      refresh: 'idle',
      commands: [],
    };
    // Last successfully parsed remote command catalog, deep-copied on
    // every publish so later mutation of consumer-held arrays, command
    // objects, or nested hints cannot corrupt prior state history.
    let lastValidCommands: SlashCommandInfo[] = [];
    function publishRemoteModelState(next: RemoteModelState): void {
      remoteModelState = next;
      config.onRemoteModelStateChange?.(next);
    }

    function publishRemoteCommandState(next: RemoteCommandState): void {
      remoteCommandState = { ...next, commands: deepCopyCommands(next.commands) };
      config.onRemoteCommandStateChange?.(next);
    }

    function canExitCli(): boolean {
      return (
        remoteCommandState.ownerConnectionId !== null &&
        remoteCommandState.commands.some(
          command =>
            command.name === 'exit' &&
            command.description === 'Exit the CLI' &&
            command.hints.length === 0 &&
            command.agent === undefined &&
            command.model === undefined &&
            command.source === undefined &&
            command.subtask === undefined
        )
      );
    }

    function publishCommands(commands: SlashCommandInfo[]): void {
      // Deep copy the array, every command object, and every hints array
      // so the event payload, the internal cache, and every subsequent
      // state callback each hold an independent snapshot.
      const snapshotted = deepCopyCommands(commands);
      lastValidCommands = snapshotted;
      sink.onServiceEvent({ type: 'commands.available', commands: deepCopyCommands(snapshotted) });
    }

    function snapshotCommands(): SlashCommandInfo[] {
      return deepCopyCommands(lastValidCommands);
    }

    function setOwnerConnectionId(nextOwnerConnectionId: string | null): void {
      if (ownerConnectionId === nextOwnerConnectionId) return;

      const previousOwnerConnectionId = ownerConnectionId;
      ownerConnectionId = nextOwnerConnectionId;
      catalogRequestGeneration += 1;
      catalogRequestInFlight = null;
      commandCatalogRequestGeneration += 1;
      commandCatalogRequestInFlight = null;
      publishRemoteModelState({
        ownerConnectionId: nextOwnerConnectionId,
        protocol: 'unknown',
        refresh: nextOwnerConnectionId ? 'loading' : 'idle',
      });
      // Owner replacement clears the command cache; emit an empty catalog
      // event and the matching idle state so consumers can re-render.
      if (previousOwnerConnectionId) {
        publishCommands([]);
        publishRemoteCommandState({
          ownerConnectionId: nextOwnerConnectionId,
          refresh: 'idle',
          commands: snapshotCommands(),
        });
      } else {
        publishRemoteCommandState({
          ownerConnectionId: nextOwnerConnectionId,
          refresh: 'idle',
          commands: snapshotCommands(),
        });
      }
      config.onCapabilityChange?.();

      if (nextOwnerConnectionId) {
        discoverModels(nextOwnerConnectionId);
        discoverCommands(nextOwnerConnectionId);
      }
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

    function handleCommandCatalogFailure(
      error: unknown,
      expectedOwnerConnectionId: string,
      expectedGeneration: number,
      expectedRequestGeneration: number,
      clearCatalog: boolean
    ): void {
      if (
        expectedGeneration !== generation ||
        expectedRequestGeneration !== commandCatalogRequestGeneration ||
        ownerConnectionId !== expectedOwnerConnectionId
      ) {
        return;
      }

      if (error instanceof UserWebCommandError && error.code === 'SESSION_OWNER_CHANGED') {
        setOwnerConnectionId(null);
        return;
      }

      // Exact relay `CLI_UPGRADE_REQUIRED` is non-fatal: clear the catalog
      // and surface actionable copy through the command state so the chat
      // composer can prompt the user to upgrade. Never populate the global
      // session error atom for this.
      if (error instanceof UserWebCommandError && error.code === 'CLI_UPGRADE_REQUIRED') {
        publishCommands([]);
        publishRemoteCommandState({
          ownerConnectionId: expectedOwnerConnectionId,
          refresh: 'upgrade-required',
          commands: snapshotCommands(),
          message: error.message,
        });
        return;
      }

      // Legacy CLI without `list_commands` support: treat as "no commands
      // available" rather than a failure so the composer can hide suggestions.
      if (error instanceof Error && error.message.includes('unknown command')) {
        publishCommands([]);
        publishRemoteCommandState({
          ownerConnectionId: expectedOwnerConnectionId,
          refresh: 'idle',
          commands: snapshotCommands(),
        });
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to discover remote commands';
      if (clearCatalog) {
        publishCommands([]);
        publishRemoteCommandState({
          ownerConnectionId: expectedOwnerConnectionId,
          refresh: 'error',
          commands: snapshotCommands(),
          message,
        });
        return;
      }
      // Transient failure on a same-owner refresh: keep the previously
      // published catalog and report the error through state without
      // populating the fatal session error atom.
      publishRemoteCommandState({
        ownerConnectionId: expectedOwnerConnectionId,
        refresh: 'error',
        commands: snapshotCommands(),
        message,
      });
    }

    function discoverCommands(expectedOwnerConnectionId: string): void {
      if (commandCatalogRequestInFlight?.ownerConnectionId === expectedOwnerConnectionId) return;

      commandCatalogRequestGeneration += 1;
      const expectedRequestGeneration = commandCatalogRequestGeneration;
      const expectedGeneration = generation;
      commandCatalogRequestInFlight = {
        ownerConnectionId: expectedOwnerConnectionId,
        generation: expectedRequestGeneration,
      };
      publishRemoteCommandState({
        ownerConnectionId: expectedOwnerConnectionId,
        refresh: 'loading',
        commands: snapshotCommands(),
      });

      void config.userWebConnection
        .sendCommand(
          config.kiloSessionId,
          'list_commands',
          { protocolVersion: 1 },
          expectedOwnerConnectionId
        )
        .then(
          result => {
            if (
              expectedGeneration !== generation ||
              expectedRequestGeneration !== commandCatalogRequestGeneration ||
              ownerConnectionId !== expectedOwnerConnectionId
            ) {
              return;
            }

            const parsed = parseRemoteCommandCatalog(result);
            if (!parsed.ok) {
              handleCommandCatalogFailure(
                new Error('Invalid remote command catalog'),
                expectedOwnerConnectionId,
                expectedGeneration,
                expectedRequestGeneration,
                true
              );
              return;
            }

            publishCommands(parsed.commands);
            publishRemoteCommandState({
              ownerConnectionId: expectedOwnerConnectionId,
              refresh: 'idle',
              commands: snapshotCommands(),
            });
          },
          error =>
            handleCommandCatalogFailure(
              error,
              expectedOwnerConnectionId,
              expectedGeneration,
              expectedRequestGeneration,
              // A relay `CATALOG_TOO_LARGE` reports the response is over
              // the 512 KiB size cap; clear the prior catalog so the
              // composer can present a clean state.
              error instanceof UserWebCommandError && error.code === 'CATALOG_TOO_LARGE'
            )
        )
        .finally(() => {
          if (commandCatalogRequestInFlight?.generation === expectedRequestGeneration) {
            commandCatalogRequestInFlight = null;
          }
        });
    }

    function replayPage(page: SessionSnapshotPage): void {
      sink.onServiceEvent({ type: 'session.created', info: page.info });

      for (const msg of page.messages) {
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
        commandCatalogRequestGeneration += 1;
        commandCatalogRequestInFlight = null;
        publishRemoteModelState({
          ownerConnectionId: null,
          protocol: 'unknown',
          refresh: 'idle',
        });
        publishRemoteCommandState({
          ownerConnectionId: null,
          refresh: 'idle',
          commands: snapshotCommands(),
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
          // The very first call (from `connect()`) is the initial bounded
          // read and fires `onInitialPageLoaded`; reconnect and delayed
          // resync calls deliberately do not, so the manager's already-
          // advanced older-messages cursor is never reset on reconnect.
          const isInitial = reportError;
          if (bufferedCliEvents !== null) {
            bufferedEventsFromSupersededSnapshot.push(...bufferedCliEvents);
          }
          bufferedCliEvents = [];

          if (!config.fetchSnapshot && !config.fetchSnapshotPage) {
            bufferedCliEvents = [
              ...bufferedEventsFromSupersededSnapshot,
              ...(bufferedCliEvents ?? []),
            ];
            bufferedEventsFromSupersededSnapshot = [];
            drainBufferedCliEvents();
            return;
          }

          const onPage = (page: SessionSnapshotPage): void => {
            if (
              expectedGeneration !== generation ||
              expectedSnapshotReplayGeneration !== snapshotReplayGeneration
            ) {
              return;
            }
            if (isInitial) {
              config.onInitialPageLoaded?.(page);
            }
            bufferedEventsFromSupersededSnapshot = [];
            replayPage(page);
            drainBufferedCliEvents();
          };
          const onError = (error: unknown): void => {
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
          };

          if (config.fetchSnapshotPage) {
            void config.fetchSnapshotPage(config.kiloSessionId, {}).then(page => {
              if (page && page.kind === 'success') {
                onPage(page);
              } else {
                onError(
                  new Error(
                    page === null
                      ? 'Session not found'
                      : page.kind === 'retryable_failure'
                        ? 'Session history temporarily unavailable'
                        : page.kind === 'too_large'
                          ? 'Session history too large to load'
                          : 'Session history is unavailable'
                  )
                );
              }
            }, onError);
            return;
          }

          if (config.fetchSnapshot) {
            void config.fetchSnapshot(config.kiloSessionId).then(snapshot => {
              onPage({
                info: snapshot.info,
                messages: snapshot.messages,
                nextCursor: null,
                omittedItemCount: 0,
              });
            }, onError);
          }
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
          if (ownerConnectionId) {
            discoverModels(ownerConnectionId);
            discoverCommands(ownerConnectionId);
          }
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
      retryRemoteCommands: () => {
        // Mirrors `retryRemoteModels`: only acts when an owner is known.
        // `discoverCommands` itself deduplicates in-flight requests per
        // owner, so duplicate retry calls collapse safely.
        if (ownerConnectionId) discoverCommands(ownerConnectionId);
      },
      createSession: async () => {
        // `create_session` is session-scoped: it must include the current Kilo
        // sessionId so the CLI can select the workspace, and it must be fenced
        // to the owner we currently trust. Reuse `sendCommand` so the owner is
        // snapshotted before the await and SESSION_OWNER_CHANGED is handled.
        // Never auto-retry — a transient network failure is a hard reject so
        // the caller can surface a retryable error.
        const result = await sendCommand('create_session', { protocolVersion: 1 });
        const parsed = parseCreateSessionResponse(result);
        if (!parsed.ok) {
          throw new Error('Invalid create_session response');
        }
        return parsed.kiloSessionId;
      },
      exitCli: async () => {
        if (remoteCommandState.refresh === 'upgrade-required') {
          throw new Error(
            remoteCommandState.message ??
              'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.'
          );
        }
        if (!canExitCli()) {
          throw new Error(REMOTE_CLI_EXIT_UNAVAILABLE);
        }

        const result = await sendCommand('exit_cli', { protocolVersion: 1 });
        if (!parseExitCliResponse(result).ok) {
          throw new Error('Invalid exit_cli response');
        }
      },
      send: async (input: TransportSendInput) => {
        if (input.payload.type === 'command') {
          const remoteModel = getRemoteModelFields(input);
          return sendCommand('send_command', {
            protocolVersion: 1,
            command: input.payload.command,
            arguments: input.payload.arguments,
            ...(input.messageId ? { messageID: input.messageId } : {}),
            ...(remoteModel.kind === 'none'
              ? {}
              : {
                  // `send_command` requires a structured model: never emit a
                  // bare string. Legacy CLI overrides arrive as a bare
                  // model string; map them to the kilo provider and strip
                  // any `kilo/` prefix so the wire modelID matches what
                  // `dispatchedKilocodeModelId` would emit for the
                  // equivalent prompt wire.
                  model:
                    remoteModel.kind === 'structured'
                      ? remoteModel.model
                      : {
                          providerID: 'kilo',
                          modelID: remoteModel.model.replace(/^kilo\//, ''),
                        },
                  ...(remoteModel.variant ? { variant: remoteModel.variant } : {}),
                }),
          });
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
