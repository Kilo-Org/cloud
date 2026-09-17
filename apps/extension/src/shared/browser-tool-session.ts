/* eslint-disable max-lines */
import { z } from 'zod';
import { DEBUGGER_PROTOCOL_VERSION, getInspectableTab } from './tab-debugger';
import type {
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerDetachListener,
  ChromeDebuggerEventListener,
  ChromeDebuggerTarget,
} from './tab-debugger';

/**
 * Buffered console messages one session keeps. N = 200: the largest
 * `browser_console_messages` payload a model reads is far below this, and a
 * page that logs in a loop cannot grow the session without limit. Oldest
 * entries are dropped first.
 */
export const MAX_BROWSER_TOOL_CONSOLE_MESSAGES = 200;
/**
 * Tracked network requests one session keeps. N = 200 matches the console
 * bound: a chatty page (polling, asset bursts) stops growing the buffer, and
 * the requests a model asks about are the recent ones. Oldest dropped first.
 */
export const MAX_BROWSER_TOOL_NETWORK_REQUESTS = 200;
/** Text characters kept per console message, so one huge log line cannot dominate the buffer. */
export const MAX_BROWSER_TOOL_MESSAGE_TEXT_LENGTH = 4000;

/**
 * CDP domains a browser-tool session keeps enabled for the tab's lifetime so
 * events arrive between tool calls: console (`Runtime`, `Log`), network
 * (`Network`), dialogs/navigation (`Page`), element refs (`DOM`), snapshot
 * (`Accessibility`).
 */
const ENABLED_CDP_DOMAINS = [
  'Runtime.enable',
  'Log.enable',
  'Network.enable',
  'Page.enable',
  'DOM.enable',
  'Accessibility.enable',
] as const;

const BROWSER_TOOL_SESSION_DISPOSED_ERROR = 'The browser tool session was disposed.';
/**
 * The debugger detached while the session was enabling its domains (tab
 * closed, the user opened DevTools, another consumer took the target). The
 * session is not attached afterwards; the next tool call attaches again.
 */
const BROWSER_TOOL_SESSION_DETACHED_ERROR = 'The debugger detached from the tab.';
const DETACH_REASON_TARGET_CLOSED = 'target_closed';

export interface BrowserConsoleMessage {
  readonly level: string;
  readonly text: string;
  readonly timestamp?: number;
  readonly url?: string;
}

export interface BrowserNetworkRequest {
  readonly failure?: string;
  readonly finishedAt?: number;
  readonly method?: string;
  readonly mimeType?: string;
  readonly postData?: string;
  readonly requestHeaders?: Record<string, string>;
  readonly requestId: string;
  readonly resourceType?: string;
  readonly responseHeaders?: Record<string, string>;
  readonly startedAt?: number;
  readonly status?: number;
  readonly statusText?: string;
  readonly url: string;
}

export interface BrowserToolDialog {
  readonly defaultValue?: string;
  readonly message: string;
  readonly type: string;
  readonly url?: string;
}

/** One snapshot element reference: the ref the snapshot surfaced, and how to get back to the node. */
export interface BrowserToolRefEntry {
  readonly backendNodeId?: number;
  readonly ref: string;
  readonly selector?: string;
}

export type BrowserToolResolvedTarget =
  | {
      readonly backendNodeId: number;
      readonly kind: 'ref';
      readonly ref: string;
    }
  | {
      readonly kind: 'selector';
      readonly nodeId: number;
      readonly selector: string;
    };

export interface BrowserToolSession {
  /**
   * Attaches the debugger and enables the CDP domains, once. Idempotent, and
   * called by `send`/`resolveTarget`; call it before reading
   * `consoleMessages()`/`networkRequests()` so those buffers start filling on
   * the first tool call rather than at background startup.
   */
  readonly attach: () => Promise<void>;
  readonly consoleMessages: () => BrowserConsoleMessage[];
  /**
   * Idempotent. Clears state, unsubscribes, and detaches the debugger; an
   * attach already in flight is awaited and its debugger released.
   */
  readonly dispose: () => Promise<void>;
  readonly isAttached: () => boolean;
  readonly networkRequests: () => BrowserNetworkRequest[];
  /** Replaces the registry, so a ref from an older snapshot cannot resolve. */
  readonly registerRefs: (entries: readonly BrowserToolRefEntry[]) => void;
  readonly resolveTarget: (target: string) => Promise<BrowserToolResolvedTarget | undefined>;
  readonly send: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown> | undefined>;
  /** Returns the pending dialog and clears it, so a second call cannot re-answer it. */
  readonly takeDialog: () => BrowserToolDialog | undefined;
}

const jsonRecordSchema = z.record(z.string(), z.unknown());
const headerValueSchema = z.string();
const primitiveValueSchema = z.union([z.boolean(), z.null(), z.number(), z.string()]);
const remoteObjectSchema = z.object({
  description: z.string().optional(),
  type: z.string().optional(),
  value: z.unknown().optional(),
});
const consoleApiCalledParamsSchema = z.object({
  args: z.array(z.unknown()).optional(),
  timestamp: z.number().optional(),
  type: z.string().optional(),
});
const logEntryAddedParamsSchema = z.object({
  entry: z.object({
    level: z.string().optional(),
    text: z.string(),
    timestamp: z.number().optional(),
    url: z.string().optional(),
  }),
});
const requestWillBeSentParamsSchema = z.object({
  request: z.object({
    headers: jsonRecordSchema.optional(),
    method: z.string().optional(),
    postData: z.string().optional(),
    url: z.string().optional(),
  }),
  requestId: z.string(),
  timestamp: z.number().optional(),
  type: z.string().optional(),
});
const responseReceivedParamsSchema = z.object({
  requestId: z.string(),
  response: z.object({
    headers: jsonRecordSchema.optional(),
    mimeType: z.string().optional(),
    status: z.number().optional(),
    statusText: z.string().optional(),
    url: z.string().optional(),
  }),
  timestamp: z.number().optional(),
  type: z.string().optional(),
});
const loadingFinishedParamsSchema = z.object({
  requestId: z.string(),
  timestamp: z.number().optional(),
});
const loadingFailedParamsSchema = z.object({
  errorText: z.string().optional(),
  requestId: z.string(),
  timestamp: z.number().optional(),
});
const javascriptDialogOpeningParamsSchema = z.object({
  defaultPrompt: z.string().optional(),
  message: z.string().optional(),
  type: z.string().optional(),
  url: z.string().optional(),
});
const frameNavigatedParamsSchema = z.object({
  frame: z.object({
    parentId: z.string().optional(),
    url: z.string().optional(),
  }),
});
const domGetDocumentResponseSchema = z.object({
  root: z.object({ nodeId: z.number() }).optional(),
});
const domQuerySelectorResponseSchema = z.object({ nodeId: z.number() });

const refPattern = /^(?:ref=)?((?:f\d+)?e\d+)$/u;
const parseRef = (target: string): string | undefined => refPattern.exec(target.trim())?.[1];

const truncateText = (text: string): string =>
  text.length > MAX_BROWSER_TOOL_MESSAGE_TEXT_LENGTH
    ? `${text.slice(0, MAX_BROWSER_TOOL_MESSAGE_TEXT_LENGTH)}...`
    : text;

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

// A CDP RemoteObject renders as its primitive value when it has one, otherwise as its description/type (e.g. "Array(3)").
const remoteObjectText = (remoteObject: unknown): string => {
  const parsed = remoteObjectSchema.safeParse(remoteObject);

  if (!parsed.success) {
    return safeStringify(remoteObject);
  }

  const { description, type, value } = parsed.data;

  if (value !== undefined) {
    const primitive = primitiveValueSchema.safeParse(value);

    return primitive.success ? String(primitive.data) : safeStringify(value);
  }

  return description ?? type ?? 'undefined';
};

const toHeaderRecord = (headers: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]): [string, string] => {
      const parsed = headerValueSchema.safeParse(value);

      return [key, parsed.success ? parsed.data : String(value)];
    })
  );

interface MutableNetworkRequest {
  failure?: string;
  finishedAt?: number;
  method?: string;
  mimeType?: string;
  postData?: string;
  requestHeaders?: Record<string, string>;
  requestId: string;
  resourceType?: string;
  responseHeaders?: Record<string, string>;
  startedAt?: number;
  status?: number;
  statusText?: string;
  url: string;
}

export const createBrowserToolSession = ({
  debuggerApi,
  tabId,
  tabsApi,
}: {
  readonly debuggerApi: ChromeDebuggerApi;
  readonly tabId: number;
  readonly tabsApi: BrowserTabsApi;
}): BrowserToolSession => {
  const target: ChromeDebuggerTarget = { tabId };
  const consoleBuffer: BrowserConsoleMessage[] = [];
  const networkById = new Map<string, MutableNetworkRequest>();
  const refs = new Map<string, BrowserToolRefEntry>();
  let attached = false;
  let disposed = false;
  let attachPromise: Promise<void> | undefined = undefined;
  // Bumped by every Debugger.detach for this tab, so an attach in flight can tell that the debugger it just acquired is gone.
  let detachCount = 0;
  let documentNodeId: number | undefined = undefined;
  let dialog: BrowserToolDialog | undefined = undefined;

  const clearState = (): void => {
    consoleBuffer.length = 0;
    networkById.clear();
    refs.clear();
    documentNodeId = undefined;
    dialog = undefined;
  };

  // A navigation replaces the document, so the cached root node id and the snapshot refs of the previous document are stale; drop them instead of querying the old document.
  const invalidateDocument = (): void => {
    documentNodeId = undefined;
    refs.clear();
  };

  const pushConsoleMessage = (message: BrowserConsoleMessage): void => {
    consoleBuffer.push(message);

    while (consoleBuffer.length > MAX_BROWSER_TOOL_CONSOLE_MESSAGES) {
      consoleBuffer.shift();
    }
  };

  const handleConsoleApiCalled = (params: Record<string, unknown> | undefined): void => {
    const parsed = consoleApiCalledParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const { args, timestamp, type } = parsed.data;

    pushConsoleMessage({
      level: type ?? 'log',
      text: truncateText((args ?? []).map(argument => remoteObjectText(argument)).join(' ')),
      ...(timestamp === undefined ? {} : { timestamp }),
    });
  };

  const handleLogEntryAdded = (params: Record<string, unknown> | undefined): void => {
    const parsed = logEntryAddedParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const { entry } = parsed.data;

    pushConsoleMessage({
      level: entry.level ?? 'log',
      text: truncateText(entry.text),
      ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
      ...(entry.url === undefined ? {} : { url: entry.url }),
    });
  };

  const getOrCreateNetworkRequest = (requestId: string, url: string): MutableNetworkRequest => {
    const existing = networkById.get(requestId);

    if (existing !== undefined) {
      return existing;
    }

    const created: MutableNetworkRequest = { requestId, url };

    networkById.set(requestId, created);

    while (networkById.size > MAX_BROWSER_TOOL_NETWORK_REQUESTS) {
      const oldestKey = networkById.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      networkById.delete(oldestKey);
    }

    return created;
  };

  const handleRequestWillBeSent = (params: Record<string, unknown> | undefined): void => {
    const parsed = requestWillBeSentParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const { request, requestId, timestamp, type } = parsed.data;
    const entry = getOrCreateNetworkRequest(requestId, request.url ?? '');

    if (request.url !== undefined) {
      entry.url = request.url;
    }
    if (request.method !== undefined) {
      entry.method = request.method;
    }
    if (request.headers !== undefined) {
      entry.requestHeaders = toHeaderRecord(request.headers);
    }
    if (request.postData !== undefined) {
      entry.postData = truncateText(request.postData);
    }
    if (type !== undefined) {
      entry.resourceType = type;
    }
    if (timestamp !== undefined) {
      entry.startedAt = timestamp;
    }
  };

  const handleResponseReceived = (params: Record<string, unknown> | undefined): void => {
    const parsed = responseReceivedParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const { requestId, response, type } = parsed.data;
    const entry = getOrCreateNetworkRequest(requestId, response.url ?? '');

    if (response.url !== undefined) {
      entry.url = response.url;
    }
    if (response.status !== undefined) {
      entry.status = response.status;
    }
    if (response.statusText !== undefined) {
      entry.statusText = response.statusText;
    }
    if (response.headers !== undefined) {
      entry.responseHeaders = toHeaderRecord(response.headers);
    }
    if (response.mimeType !== undefined) {
      entry.mimeType = response.mimeType;
    }
    if (type !== undefined) {
      entry.resourceType = type;
    }
  };

  const handleLoadingFinished = (params: Record<string, unknown> | undefined): void => {
    const parsed = loadingFinishedParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const { requestId, timestamp } = parsed.data;
    const entry = getOrCreateNetworkRequest(requestId, '');

    if (timestamp !== undefined) {
      entry.finishedAt = timestamp;
    }
  };

  const handleLoadingFailed = (params: Record<string, unknown> | undefined): void => {
    const parsed = loadingFailedParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const { errorText, requestId, timestamp } = parsed.data;
    const entry = getOrCreateNetworkRequest(requestId, '');

    if (errorText !== undefined) {
      entry.failure = errorText;
    }
    if (timestamp !== undefined) {
      entry.finishedAt = timestamp;
    }
  };

  const handleDialogOpening = (params: Record<string, unknown> | undefined): void => {
    const parsed = javascriptDialogOpeningParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const { defaultPrompt, message, type, url } = parsed.data;

    dialog = {
      message: message ?? '',
      type: type ?? 'alert',
      ...(defaultPrompt === undefined ? {} : { defaultValue: defaultPrompt }),
      ...(url === undefined ? {} : { url }),
    };
  };

  // Only a main-frame navigation replaces the document; a subframe navigation leaves the main document's node ids valid.
  const handleFrameNavigated = (params: Record<string, unknown> | undefined): void => {
    const parsed = frameNavigatedParamsSchema.safeParse(params);

    if (!parsed.success || parsed.data.frame.parentId !== undefined) {
      return;
    }

    invalidateDocument();
  };

  const handleEvent: ChromeDebuggerEventListener = (source, method, params) => {
    if (disposed || (source.tabId !== undefined && source.tabId !== tabId)) {
      return;
    }

    if (method === 'Runtime.consoleAPICalled') {
      handleConsoleApiCalled(params);
      return;
    }

    if (method === 'Log.entryAdded') {
      handleLogEntryAdded(params);
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      handleRequestWillBeSent(params);
      return;
    }

    if (method === 'Network.responseReceived') {
      handleResponseReceived(params);
      return;
    }

    if (method === 'Network.loadingFinished') {
      handleLoadingFinished(params);
      return;
    }

    if (method === 'Network.loadingFailed') {
      handleLoadingFailed(params);
      return;
    }

    if (method === 'Page.javascriptDialogOpening') {
      handleDialogOpening(params);
      return;
    }

    if (method === 'Page.javascriptDialogClosed') {
      dialog = undefined;
      return;
    }

    if (method === 'Page.frameNavigated') {
      handleFrameNavigated(params);
      return;
    }

    if (method === 'DOM.documentUpdated') {
      invalidateDocument();
    }
  };

  const handleTabRemoved = (removedTabId: number): void => {
    if (removedTabId === tabId) {
      void dispose();
    }
  };

  const handleDetach: ChromeDebuggerDetachListener = (source, reason) => {
    if (source.tabId !== undefined && source.tabId !== tabId) {
      return;
    }

    detachCount += 1;
    attached = false;
    clearState();

    if (reason === DETACH_REASON_TARGET_CLOSED) {
      void dispose();
    }
  };

  const unsubscribe = (): void => {
    debuggerApi.onDetach.removeListener(handleDetach);
    debuggerApi.onEvent.removeListener(handleEvent);
    tabsApi.onRemoved?.removeListener(handleTabRemoved);
  };

  const detachQuietly = async (): Promise<void> => {
    try {
      await debuggerApi.detach(target);
    } catch {
      // The tab may already be gone; clearing the session state is what matters.
    }
  };

  const doDispose = async (): Promise<void> => {
    disposed = true;
    clearState();
    unsubscribe();

    // An attach already in flight finishes enabling domains after this call's first turn; wait for it so the debugger it acquired is released instead of leaking. `doAttach` detaches itself when it sees `disposed`.
    const pendingAttach = attachPromise;

    if (pendingAttach !== undefined) {
      try {
        await pendingAttach;
      } catch {
        // A failed attach released the debugger itself; there is nothing left to detach.
      }
    }

    if (!attached) {
      return;
    }

    attached = false;

    await detachQuietly();
  };

  let disposePromise: Promise<void> | undefined = undefined;

  const dispose = (): Promise<void> => {
    disposePromise ??= doDispose();

    return disposePromise;
  };

  const doAttach = async (): Promise<void> => {
    const resolution = await getInspectableTab({ tabId, tabsApi });

    if (!resolution.ok) {
      throw new Error(resolution.error);
    }

    // Counted before the attach request so a detach that lands while the domains are being enabled is not overwritten by `attached = true` below.
    const detachCountBeforeAttach = detachCount;

    await debuggerApi.attach(target, DEBUGGER_PROTOCOL_VERSION);

    try {
      for (const method of ENABLED_CDP_DOMAINS) {
        // eslint-disable-next-line no-await-in-loop -- domains must be enabled in order before any tool call reads their events
        await debuggerApi.sendCommand(target, method);
      }
    } catch (error) {
      await detachQuietly();

      throw error;
    }

    if (disposed) {
      // Dispose() landed while the enables were in flight; release the debugger this attach acquired.
      await detachQuietly();

      throw new Error(BROWSER_TOOL_SESSION_DISPOSED_ERROR);
    }

    if (detachCount !== detachCountBeforeAttach) {
      // The browser detached (tab closing, DevTools, another consumer) while the enables were in flight; report the failure so the next call attaches again instead of claiming a session the browser no longer has. Nothing to release: the debugger is already detached.
      throw new Error(BROWSER_TOOL_SESSION_DETACHED_ERROR);
    }

    attached = true;
  };

  const attach = async (): Promise<void> => {
    if (disposed) {
      throw new Error(BROWSER_TOOL_SESSION_DISPOSED_ERROR);
    }

    if (attached) {
      return;
    }

    const pending = attachPromise ?? doAttach();

    attachPromise = pending;

    try {
      await pending;
    } catch (error) {
      attachPromise = undefined;

      throw error;
    }

    attachPromise = undefined;
  };

  const send = async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> => {
    await attach();

    return debuggerApi.sendCommand(target, method, params);
  };

  const getDocumentNodeId = async (): Promise<number | undefined> => {
    if (documentNodeId !== undefined) {
      return documentNodeId;
    }

    const response = await debuggerApi.sendCommand(target, 'DOM.getDocument', { depth: 0 });
    const parsed = domGetDocumentResponseSchema.safeParse(response);

    if (!parsed.success || parsed.data.root === undefined) {
      return undefined;
    }

    documentNodeId = parsed.data.root.nodeId;

    return documentNodeId;
  };

  const resolveSelector = async (
    selector: string
  ): Promise<BrowserToolResolvedTarget | undefined> => {
    await attach();

    const rootNodeId = await getDocumentNodeId();

    if (rootNodeId === undefined) {
      return undefined;
    }

    const response = await debuggerApi.sendCommand(target, 'DOM.querySelector', {
      nodeId: rootNodeId,
      selector,
    });
    const parsed = domQuerySelectorResponseSchema.safeParse(response);

    if (!parsed.success || parsed.data.nodeId === 0) {
      return undefined;
    }

    return { kind: 'selector', nodeId: parsed.data.nodeId, selector };
  };

  const resolveTarget = async (
    targetText: string
  ): Promise<BrowserToolResolvedTarget | undefined> => {
    const ref = parseRef(targetText);

    if (ref === undefined) {
      return resolveSelector(targetText);
    }

    const entry = refs.get(ref);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.backendNodeId !== undefined) {
      return { backendNodeId: entry.backendNodeId, kind: 'ref', ref };
    }

    if (entry.selector === undefined) {
      return undefined;
    }

    const resolved = await resolveSelector(entry.selector);

    return resolved;
  };

  const registerRefs = (entries: readonly BrowserToolRefEntry[]): void => {
    refs.clear();

    for (const entry of entries) {
      refs.set(entry.ref, entry);
    }
  };

  const takeDialog = (): BrowserToolDialog | undefined => {
    const pending = dialog;

    dialog = undefined;

    return pending;
  };

  // Subscribe before any attach so a detach that lands during attach is not missed.
  debuggerApi.onDetach.addListener(handleDetach);
  debuggerApi.onEvent.addListener(handleEvent);
  tabsApi.onRemoved?.addListener(handleTabRemoved);

  return {
    attach,
    consoleMessages: () => [...consoleBuffer],
    dispose,
    isAttached: () => attached,
    networkRequests: () => [...networkById.values()],
    registerRefs,
    resolveTarget,
    send,
    takeDialog,
  };
};
