/* eslint-disable import/max-dependencies, max-lines, typescript-eslint/consistent-type-definitions -- One coordinator owns the settings watch, pairing watcher, transports, registry, and status; splitting it would spread a single state machine across modules. AGENTS.md prefers type over interface. */
import { z } from 'zod';
import { storage as extensionStorage } from '#imports';
import {
  LOCAL_AGENTS_WATCHDOG_ALARM,
  STOP_ALL_LOCAL_AGENTS_COMMAND,
  localAgentCommandResponseSchema,
  localAgentPanelCommandSchema,
} from './commands';
import type { LocalAgentPanelCommand } from './commands';
import { createLocalAgentConnection } from './connection';
import type { LocalAgentConnection, LocalAgentEndpoint } from './connection';
import type { LocalAgentConnectionState } from './connection-state';
import { createLocalAgentDispatcher, createUnavailableBrowserTools } from './dispatcher';
import type { LocalAgentBrowserTools } from './dispatcher';
import { loadLocalAgentEndpoints, saveLocalAgentEndpoint } from './endpoints';
import { createLocalAgentHello } from './environment';
import type { LocalAgentApiAvailability } from './environment';
import type {
  LocalAgentExtensionHello,
  LocalAgentIncomingEnvelope,
  LocalAgentTransport,
} from './envelope';
import {
  LOCAL_AGENT_ERROR_CODES,
  LocalAgentRpcError,
  buildErrorMessage,
  buildNotification,
  buildResultMessage,
} from './jsonrpc';
import type { JsonRpcMessage } from './jsonrpc';
import { createLoopbackDial } from './loopback-transport';
import type { LoopbackSocketConnect } from './loopback-transport';
import { createNativeDial } from './native-transport';
import type { NativeMessagingRuntime } from './native-transport';
import { parsePairingUrl } from './pairing';
import type { LocalAgentPairingEndpoint } from './pairing';
import { createLocalAgentControllerRegistry } from './registry';
import { LOCAL_AGENT_SETTINGS_STORAGE_KEY, loadLocalAgentSettings } from './settings';
import { createSerialTaskQueue } from './storage';
import type { LocalAgentStorageArea, LocalAgentStorageWatch } from './storage';
import { saveLocalAgentStatus } from './status';
import type { LocalAgentEndpointStatus } from './status';
import { localAgentTimers } from './timers';
import type { LocalAgentTimers } from './transport-types';
import { connectLoopbackSocket } from './websocket';

/*
 * The local-agents host: one coordinator that owns the settings watch, the
 * endpoint connections, the pairing tab watcher, the watchdog alarm, and the
 * controller registry (SPEC "Extension architecture" + "Transport").
 *
 * The browser runtime that executes tools is not part of this slice; the
 * dispatcher is injected with a placeholder that answers `browser_unavailable`.
 */

const WATCHDOG_PERIOD_MINUTES = 0.5;
const NATIVE_ENDPOINT_ID = 'native';

export type LocalAgentAlarmsApi = {
  create(name: string, info: { periodInMinutes: number }): void;
  clear(name: string): Promise<boolean> | void;
  onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
};

export type LocalAgentTabsApi = {
  onUpdated: {
    addListener(
      listener: (tabId: number, changeInfo: { url?: string }, tab: { url?: string }) => void
    ): void;
  };
  remove(tabId: number): Promise<void> | void;
};

export type LocalAgentRuntimeApi = NativeMessagingRuntime & {
  id?: string;
  getManifest?: () => { version?: string };
  onMessage?: {
    addListener(
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: { ok: boolean }) => void
      ) => boolean | undefined
    ): void;
  };
};

export type LocalAgentCommandsApi = {
  onCommand: { addListener(listener: (command: string) => void): void };
};

export type LocalAgentsHostApis = {
  alarms?: LocalAgentAlarmsApi;
  availability: LocalAgentApiAvailability;
  commands?: LocalAgentCommandsApi;
  createId?: () => string;
  createSocket?: LoopbackSocketConnect;
  now?: () => number;
  runtime?: LocalAgentRuntimeApi;
  storage: LocalAgentStorageArea;
  tabs?: LocalAgentTabsApi;
  timers?: LocalAgentTimers;
  tools?: LocalAgentBrowserTools;
  userAgent: string;
  watch?: LocalAgentStorageWatch;
};

export type LocalAgentsHost = { stop(): void };

export type LocalAgentGlobalScope = {
  alarms?: LocalAgentAlarmsApi;
  commands?: LocalAgentCommandsApi;
  debugger?: unknown;
  runtime?: LocalAgentRuntimeApi;
  scripting?: unknown;
  tabGroups?: unknown;
  tabs?: LocalAgentTabsApi;
  webRequest?: unknown;
};

const senderSchema = z.object({ id: z.string().optional(), url: z.string().optional() });

const isTrustedPanelSender = (sender: unknown, runtimeId: string | undefined): boolean => {
  const parsed = senderSchema.safeParse(sender);

  if (!parsed.success || runtimeId === undefined || parsed.data.id !== runtimeId) {
    return false;
  }

  const url = parsed.data.url ?? '';

  return url.startsWith('chrome-extension://') || url.startsWith('moz-extension://');
};

const errorResponse = (id: string | number, error: unknown) =>
  error instanceof LocalAgentRpcError
    ? buildErrorMessage({ code: error.code, id, message: error.message })
    : buildErrorMessage({
        code: LOCAL_AGENT_ERROR_CODES.internalError,
        id,
        message: 'Local agent request failed.',
      });

/** Browser globals plus WXT storage, with the shipped defaults. */
export const readLocalAgentsHostApis = (): LocalAgentsHostApis => {
  const scope = globalThis as typeof globalThis & {
    browser?: LocalAgentGlobalScope;
    chrome?: LocalAgentGlobalScope;
    navigator?: { userAgent?: string };
  };
  const apis = scope.browser ?? scope.chrome ?? {};
  const storage: LocalAgentStorageArea = {
    getItem: key => extensionStorage.getItem(key),
    removeItem: key => extensionStorage.removeItem(key),
    setItem: (key, value) => extensionStorage.setItem(key, value),
  };
  // WXT's `watch` is generic over the stored value; the transport only needs the key.
  // eslint-disable-next-line promise/prefer-await-to-callbacks -- storage watcher callback signature
  const storageWatch: LocalAgentStorageWatch = (key, callback) =>
    extensionStorage.watch(key, callback);

  return {
    availability: {
      hasDebugger: apis.debugger !== undefined,
      hasScripting: apis.scripting !== undefined,
      hasTabGroups: apis.tabGroups !== undefined,
      hasWebRequest: apis.webRequest !== undefined,
    },
    storage,
    userAgent: scope.navigator?.userAgent ?? '',
    ...(apis.alarms === undefined ? {} : { alarms: apis.alarms }),
    ...(apis.commands === undefined ? {} : { commands: apis.commands }),
    ...(apis.runtime === undefined ? {} : { runtime: apis.runtime }),
    ...(apis.tabs === undefined ? {} : { tabs: apis.tabs }),
    watch: storageWatch,
  };
};

const statusOf = (connections: Map<string, LocalAgentConnection>): LocalAgentEndpointStatus[] => {
  const statuses: LocalAgentEndpointStatus[] = [];

  for (const connection of connections.values()) {
    if (connection.endpoint.transport === 'loopback') {
      statuses.push({
        endpointId: connection.endpoint.endpointId,
        hubId: connection.endpoint.hubId,
        state: connection.state(),
        transport: 'loopback',
      });
    } else {
      statuses.push({
        endpointId: connection.endpoint.endpointId,
        state: connection.state(),
        transport: 'native',
      });
    }
  }

  return statuses;
};

export const startLocalAgentsHost = (
  options: LocalAgentsHostApis = readLocalAgentsHostApis()
): LocalAgentsHost => {
  const { alarms, availability, commands, runtime, storage, tabs, userAgent, watch } = options;
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const timers = options.timers ?? localAgentTimers;
  const connectSocket = options.createSocket ?? connectLoopbackSocket;
  const registry = createLocalAgentControllerRegistry({ createHandle: createId, now, storage });
  const dispatcher = createLocalAgentDispatcher({
    registry,
    tools: options.tools ?? createUnavailableBrowserTools(),
  });
  const hello = createLocalAgentHello({
    availability,
    extensionVersion: runtime?.getManifest?.().version,
    userAgent,
  });

  const connections = new Map<string, LocalAgentConnection>();
  const controllerConnections = new Map<string, LocalAgentConnection>();
  const cleanup: (() => void)[] = [];
  const publish = createSerialTaskQueue();
  let enabled = false;
  let stopped = false;

  const publishStatus = (): Promise<void> =>
    publish(async () => {
      await saveLocalAgentStatus(storage, statusOf(connections));
    });

  /** Connection-driven bookkeeping must never surface as an unhandled rejection. */
  const runTask = (task: () => Promise<void>): void => {
    void (async (): Promise<void> => {
      try {
        await task();
      } catch {
        // Transient bookkeeping failures surface through the connection state.
      }

      await publishStatus();
    })();
  };

  const ensureController = async (
    connection: LocalAgentConnection,
    controllerId: string
  ): Promise<void> => {
    if (controllerConnections.get(controllerId) === connection) {
      return;
    }

    const transport: LocalAgentTransport = connection.endpoint.transport;

    await registry.registerController({
      controllerId,
      transport,
      ...(connection.endpoint.transport === 'loopback' ? { hubId: connection.endpoint.hubId } : {}),
    });
    controllerConnections.set(controllerId, connection);
  };

  const handleRpc = async (
    connection: LocalAgentConnection,
    controllerId: string,
    message: JsonRpcMessage
  ): Promise<void> => {
    if (message.kind !== 'request') {
      // V1 has no CLI notifications, and this slice sends no requests to the CLI.
      return;
    }

    try {
      const result = await dispatcher.handle(controllerId, message.method, message.params);

      connection.send(controllerId, buildResultMessage(message.id, result));
    } catch (error) {
      connection.send(controllerId, errorResponse(message.id, error));
    }
  };

  const handleEnvelope = (
    connection: LocalAgentConnection,
    envelope: LocalAgentIncomingEnvelope
  ): void => {
    if (envelope.type === 'controller.connected') {
      runTask(async () => {
        await ensureController(connection, envelope.controllerId);
      });

      return;
    }

    if (envelope.type === 'controller.disconnected') {
      controllerConnections.delete(envelope.controllerId);
      runTask(async () => {
        await registry.removeController(envelope.controllerId);
      });

      return;
    }

    runTask(async () => {
      await ensureController(connection, envelope.controllerId);
      await handleRpc(connection, envelope.controllerId, envelope.message);
    });
  };

  /**
   * A dropped connection ends its controllers' sessions: the hub assigns a new
   * controllerId per CLI socket, so the old rows can never be resumed.
   */
  const forgetControllersOf = async (connection: LocalAgentConnection): Promise<void> => {
    const controllerIds: string[] = [];

    for (const [controllerId, mapped] of controllerConnections) {
      if (mapped === connection) {
        controllerIds.push(controllerId);
      }
    }

    await Promise.all(
      controllerIds.map(async controllerId => {
        controllerConnections.delete(controllerId);
        await registry.removeController(controllerId);
      })
    );

    if (controllerIds.length > 0) {
      await publishStatus();
    }
  };

  const addConnection = (
    endpoint: LocalAgentEndpoint,
    extensionHello: LocalAgentExtensionHello
  ) => {
    let lastState: LocalAgentConnectionState = { kind: 'off' };
    const dial =
      endpoint.transport === 'native'
        ? createNativeDial({ hello: extensionHello, runtime: runtime ?? {} })
        : createLoopbackDial({ connectSocket, endpoint, hello: extensionHello, timers });
    const connection = createLocalAgentConnection({
      dial,
      endpoint,
      now,
      onEnvelope: envelope => {
        handleEnvelope(connection, envelope);
      },
      onStateChange: next => {
        if (lastState.kind === 'connected' && next.kind !== 'connected') {
          void forgetControllersOf(connection);
        }

        lastState = next;
        void publishStatus();
      },
      timers,
    });

    connections.set(endpoint.endpointId, connection);

    return connection;
  };

  const closeConnection = (connection: LocalAgentConnection): void => {
    for (const [controllerId, mapped] of controllerConnections) {
      if (mapped === connection) {
        controllerConnections.delete(controllerId);
      }
    }

    connection.close();
    connections.delete(connection.endpoint.endpointId);
  };

  const revokeAll = async (reason: 'switch_off' | 'user_stop'): Promise<void> => {
    const revoked = await registry.takeAllSessions();

    for (const { controllerId, sessionHandle } of revoked) {
      controllerConnections
        .get(controllerId)
        ?.send(controllerId, buildNotification('session.revoked', { reason, sessionHandle }));
    }

    controllerConnections.clear();
  };

  const disconnectController = async (controllerId: string): Promise<void> => {
    const removed = await registry.removeController(controllerId);
    const connection = controllerConnections.get(controllerId);

    controllerConnections.delete(controllerId);

    for (const session of removed?.sessions ?? []) {
      connection?.send(
        controllerId,
        buildNotification('session.revoked', {
          reason: 'disconnect',
          sessionHandle: session.sessionHandle,
        })
      );
    }
  };

  const reconcile = async (): Promise<void> => {
    if (!enabled || stopped) {
      return;
    }

    const endpoints = await loadLocalAgentEndpoints(storage);

    if (!connections.has(NATIVE_ENDPOINT_ID)) {
      addConnection({ endpointId: NATIVE_ENDPOINT_ID, transport: 'native' }, hello).connect();
    }

    for (const endpoint of endpoints) {
      if (!connections.has(endpoint.hubId)) {
        addConnection(
          {
            endpointId: endpoint.hubId,
            hubId: endpoint.hubId,
            key: endpoint.key,
            transport: 'loopback',
            ws: endpoint.ws,
          },
          hello
        ).connect();
      }
    }

    for (const connection of connections.values()) {
      if (
        connection.endpoint.transport === 'loopback' &&
        !endpoints.some(endpoint => endpoint.hubId === connection.endpoint.endpointId)
      ) {
        closeConnection(connection);
      }
    }

    for (const connection of connections.values()) {
      connection.connect();
    }

    await publishStatus();
  };

  const applyEnabled = async (next: boolean): Promise<void> => {
    if (next === enabled) {
      return;
    }

    enabled = next;

    if (!enabled) {
      await revokeAll('switch_off');

      for (const connection of connections.values()) {
        closeConnection(connection);
      }

      await alarms?.clear(LOCAL_AGENTS_WATCHDOG_ALARM);
      await publishStatus();

      return;
    }

    alarms?.create(LOCAL_AGENTS_WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES });
    await reconcile();
  };

  const refreshSettings = async (): Promise<void> => {
    const settings = await loadLocalAgentSettings(storage);

    await applyEnabled(settings.enabled);
  };

  const refreshSettingsQuietly = (): void => {
    void (async (): Promise<void> => {
      try {
        await refreshSettings();
      } catch {
        // A failed settings read leaves the switch off; the next storage event retries.
      }
    })();
  };

  const acceptPairing = async (
    endpoint: LocalAgentPairingEndpoint,
    tabId: number
  ): Promise<void> => {
    await saveLocalAgentEndpoint(storage, endpoint);

    // Pairing tabs are single-use; closing the tab also clears the key from the address bar.
    try {
      await tabs?.remove(tabId);
    } catch {
      // Already gone (the user closed it) — nothing to do.
    }

    await reconcile();
  };

  const stopAll = async (): Promise<void> => {
    await revokeAll('user_stop');
    await publishStatus();
  };

  const handlePanelCommand = (command: LocalAgentPanelCommand): Promise<void> =>
    command.kind === 'stop_all' ? stopAll() : disconnectController(command.controllerId);

  alarms?.onAlarm.addListener(alarm => {
    if (alarm.name === LOCAL_AGENTS_WATCHDOG_ALARM && enabled) {
      void reconcile();
    }
  });

  tabs?.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!enabled || stopped) {
      return;
    }

    const endpoint = parsePairingUrl(changeInfo.url ?? tab.url ?? '');

    if (endpoint !== null) {
      void acceptPairing(endpoint, tabId);
    }
  });

  commands?.onCommand.addListener(command => {
    if (command === STOP_ALL_LOCAL_AGENTS_COMMAND) {
      void stopAll();
    }
  });

  runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (!isTrustedPanelSender(sender, runtime?.id)) {
      return;
    }

    const parsed = localAgentPanelCommandSchema.safeParse(message);

    if (!parsed.success) {
      return;
    }

    void (async (): Promise<void> => {
      let ok = false;

      try {
        await handlePanelCommand(parsed.data);
        ok = true;
      } catch {
        ok = false;
      }

      sendResponse(localAgentCommandResponseSchema.parse({ ok }));
    })();

    return true;
  });

  if (watch !== undefined) {
    cleanup.push(watch(LOCAL_AGENT_SETTINGS_STORAGE_KEY, refreshSettingsQuietly));
  }

  refreshSettingsQuietly();

  return {
    stop: () => {
      stopped = true;

      for (const remove of cleanup) {
        remove();
      }

      for (const connection of connections.values()) {
        closeConnection(connection);
      }
    },
  };
};
