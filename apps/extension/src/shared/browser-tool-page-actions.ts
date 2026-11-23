/* eslint-disable max-lines -- One module owns the page and lifecycle browser tools; the shared CDP helpers keep their shapes consistent. */
import { z } from 'zod';
import { createWebMcpToolCall } from './agent-conversation';
import {
  AGENT_TAB_OUTSIDE_GROUP_ERROR,
  RUN_CODE_UNSUPPORTED_ERROR,
  ambiguousSelectorError,
  originPatternMatches,
  toBrowserOrigin,
  webMcpCallArgumentError,
  webMcpCallArgumentsSchema,
} from './browser-agent-checks';
import type { AgentReadScope } from './browser-agent-frames';
import { KILO_BROWSER_TOOL_PREFIX } from './browser-tool-contract';
import type {
  BrowserToolDialog,
  BrowserToolResolvedTarget,
  BrowserToolUniqueTarget,
  BrowserToolViewportState,
} from './browser-tool-session';
import { listInspectableTabsWithTabsApi } from './tab-debugger';
import type {
  BrowserTabInfo,
  BrowserTabsApi,
  EvalTabResult,
  InspectableTab,
  WebMcpDiscoveryResult,
} from './tab-debugger';
import type { WebMcpToolCallEvent } from './agent-conversation';
import { buildWebMcpToolDefinitions, readableWebMcpTools } from './web-mcp-tools';

/**
 * The ten upstream Playwright MCP page and lifecycle tools the debugger
 * backend implements. Names are upstream names (no `kilo_` prefix); the
 * executor maps a model-facing `kilo_browser_*` call onto one of these.
 * `browser_webmcp_list` is also handled by the read-only module; both read the
 * same page registration.
 */
export const PAGE_BROWSER_TOOL_NAMES = [
  'browser_close',
  'browser_evaluate',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_navigate',
  'browser_navigate_back',
  'browser_resize',
  'browser_run_code_unsafe',
  'browser_tabs',
  'browser_webmcp_call',
  'browser_webmcp_list',
] as const;

export type PageBrowserToolName = (typeof PAGE_BROWSER_TOOL_NAMES)[number];

const PAGE_BROWSER_TOOL_NAME_SET: ReadonlySet<string> = new Set(PAGE_BROWSER_TOOL_NAMES);

const toUpstreamToolName = (name: string): string =>
  name.startsWith(KILO_BROWSER_TOOL_PREFIX) ? name.slice(KILO_BROWSER_TOOL_PREFIX.length) : name;

/** Accepts either the upstream name (`browser_navigate`) or the model-facing `kilo_` name. */
export const isPageBrowserToolName = (name: string): boolean =>
  PAGE_BROWSER_TOOL_NAME_SET.has(toUpstreamToolName(name));

/** The agent has no target tab (closed, or never selected). Reported, never thrown. */
export const BROWSER_TOOL_NO_SELECTED_TAB_ERROR =
  'No selected tab. The agent has no tab to act on; open or select one with browser_tabs.';
/** Upstream's `browser_handle_dialog` error when the session buffered no dialog. */
export const BROWSER_TOOL_NO_DIALOG_ERROR = 'No dialog is currently open.';
/**
 * Upstream cancels a pending file chooser here. The Kilo extension never
 * enables `Page.setInterceptFileChooserEnabled`, so no chooser is ever
 * intercepted and this tool has none to answer. The message names that
 * platform limit so the model does not retry after clicking an upload control.
 * The `takeFileChooser` branch below stays for a session that later wires
 * interception; today it is unreachable in production.
 */
export const BROWSER_TOOL_NO_FILE_CHOOSER_ERROR =
  'browser_file_upload is not available: the Kilo extension does not intercept the page file chooser, so there is no chooser to set files on. This tool cannot be backed by the extension in Chrome or Firefox.';
/** The old eval string guard, carried over so browser_evaluate matches the eval tool. */
export const MAX_BROWSER_EVALUATE_STRING_LENGTH = 8000;
const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 15_000;
const PAGE_LOAD_POLL_INTERVAL_MS = 100;

export interface BrowserToolFileChooser {
  readonly backendNodeId?: number;
  readonly nodeId?: number;
}

/**
 * The slice of `BrowserToolSession` the page and lifecycle tools need: the CDP
 * command channel, the snapshot ref registry, the buffered dialog and — when
 * the session intercepts one — the pending file chooser. A full
 * `BrowserToolSession` satisfies it structurally.
 */
export interface BrowserToolPageActionSession {
  readonly dispose?: () => Promise<void>;
  readonly resolveTarget: (target: string) => Promise<BrowserToolResolvedTarget | undefined>;
  readonly send: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown> | undefined>;
  readonly takeDialog: () => BrowserToolDialog | undefined;
  readonly takeFileChooser?: () => BrowserToolFileChooser | undefined;
  /**
   * The tab's viewport identity. Every caller view of a tab shares the tab
   * session's object, so a resize override belongs to the tab. A session
   * without it (a fake) is its own viewport.
   */
  readonly viewportState?: BrowserToolViewportState | undefined;
}

/** `chrome.tabs` plus the create/remove calls the browser_tabs actions need. */
export interface BrowserToolPageTabsApi extends BrowserTabsApi {
  readonly create?:
    | ((properties: {
        readonly active?: boolean;
        readonly url?: string;
      }) => Promise<BrowserTabInfo> | BrowserTabInfo)
    | undefined;
  readonly remove?: ((tabId: number) => Promise<void> | void) | undefined;
}

/** What an agent caller may do with tabs: its grants and its session's group. */
export interface BrowserAgentAccess {
  readonly actOrigins: readonly string[];
  readonly groupTabs?: readonly number[] | undefined;
  readonly navigateOrigins: readonly string[];
  readonly readableOrigins: readonly string[];
}

export interface BrowserToolPageActionOptions {
  /** Present only for a CLI agent caller: the tab actions enforce the D9 boundary, and the WebMCP list shows only what it may read. */
  readonly agentScope?: AgentReadScope | undefined;
  /** Present only for a CLI agent caller: the tab actions enforce the D9 boundary and per-origin grants. */
  readonly agentAccess?: BrowserAgentAccess | undefined;
  /** Records a tab the call opened, with the tab that opened it, so the session may use it later. */
  readonly noteTabCreated?: ((tabId: number, openerTabId: number | undefined) => void) | undefined;
  /** WebMCP discovery in the tab's top-level document; wired to the existing WebMCP runtime. */
  readonly webMcpDiscover?: (tabId: number) => Promise<WebMcpDiscoveryResult | undefined>;
  /** WebMCP execution by tool name; wired to the existing WebMCP runtime. */
  readonly webMcpExecute?: (event: WebMcpToolCallEvent) => Promise<EvalTabResult>;
  /** The agent's target tab, for the tabs list marker and the close action. */
  readonly tabId?: number;
  readonly tabsApi?: BrowserToolPageTabsApi;
  readonly now?: () => number;
}

const stringSchema = z.string();
const numberSchema = z.coerce.number();
const booleanSchema = z.boolean();
const stringArraySchema = z.array(z.string());
const integerSchema = z.coerce.number().int();

const cdpRemoteObjectSchema = z.object({
  description: z.string().optional(),
  value: z.unknown().optional(),
});
const cdpEvaluateResponseSchema = z.object({
  exceptionDetails: z.unknown().optional(),
  result: cdpRemoteObjectSchema.optional(),
});
const cdpExceptionSchema = z.object({ text: z.string() });
const cdpResolveNodeResponseSchema = z.object({
  object: z.object({ objectId: z.string().optional() }).optional(),
});
/** `Page.navigate` sets `errorText` when the navigation could not start or resolve. */
const cdpNavigateResponseSchema = z.object({ errorText: z.string().optional() });
const navigationHistorySchema = z.object({
  currentIndex: z.number(),
  entries: z.array(
    z.object({ id: z.number(), title: z.string().optional(), url: z.string().optional() })
  ),
});
const pageIdentitySchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
});

const fail = (error: string): EvalTabResult => ({ error, ok: false });
const done = (value: unknown): EvalTabResult => ({ ok: true, value });

const getStringArgument = (args: Record<string, unknown>, name: string): string | undefined => {
  const parsed = stringSchema.safeParse(args[name]);

  return parsed.success ? parsed.data : undefined;
};

const getBooleanArgument = (args: Record<string, unknown>, name: string): boolean | undefined => {
  const parsed = booleanSchema.safeParse(args[name]);

  return parsed.success ? parsed.data : undefined;
};

const getPositiveNumberArgument = (
  args: Record<string, unknown>,
  name: string
): number | undefined => {
  if (args[name] === undefined || args[name] === null) {
    return undefined;
  }

  const parsed = numberSchema.safeParse(args[name]);

  return parsed.success && Number.isFinite(parsed.data) && parsed.data > 0
    ? parsed.data
    : undefined;
};

const getIndexArgument = (args: Record<string, unknown>, name: string): number | undefined => {
  if (args[name] === undefined || args[name] === null) {
    return undefined;
  }

  const parsed = integerSchema.safeParse(args[name]);

  return parsed.success && parsed.data >= 0 ? parsed.data : undefined;
};

const getStringArrayArgument = (
  args: Record<string, unknown>,
  name: string
): string[] | undefined => {
  const parsed = stringArraySchema.safeParse(args[name]);

  return parsed.success ? parsed.data : undefined;
};

const getExceptionMessage = (exceptionDetails: unknown): string => {
  const parsed = cdpExceptionSchema.safeParse(exceptionDetails);

  return parsed.success && parsed.data.text.trim() !== ''
    ? `Page evaluation failed: ${parsed.data.text}`
    : 'Page evaluation failed.';
};

/**
 * Carries over the old eval guard: a value that cannot survive JSON is an
 * error, and a string longer than the guard is returned truncated with its
 * original length so the model can see how much it did not receive.
 */
export const serializeBrowserEvaluateResult = (value: unknown): EvalTabResult => {
  try {
    JSON.stringify(value);
  } catch {
    return fail('Eval result was not JSON-serializable.');
  }

  const stringValue = stringSchema.safeParse(value);

  if (stringValue.success && stringValue.data.length > MAX_BROWSER_EVALUATE_STRING_LENGTH) {
    return done({
      originalLength: stringValue.data.length,
      truncated: true,
      type: 'string',
      value: stringValue.data.slice(0, MAX_BROWSER_EVALUATE_STRING_LENGTH),
    });
  }

  return value === undefined ? { ok: true } : done(value);
};

const readEvaluateResponse = (response: Record<string, unknown> | undefined): EvalTabResult => {
  const parsed = cdpEvaluateResponseSchema.safeParse(response);

  if (!parsed.success) {
    return fail('Debugger returned an invalid evaluate response.');
  }

  const { exceptionDetails, result } = parsed.data;

  if (exceptionDetails !== undefined) {
    return fail(getExceptionMessage(exceptionDetails));
  }

  if (result === undefined) {
    return fail('Debugger returned an invalid evaluate result.');
  }

  return Object.hasOwn(result, 'value')
    ? serializeBrowserEvaluateResult(result.value)
    : { ok: true };
};

const sleep = (ms: number): Promise<void> =>
  // eslint-disable-next-line promise/avoid-new -- a poll interval has no other primitive
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const runPageExpression = async (
  session: BrowserToolPageActionSession,
  expression: string
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- CDP returns an arbitrary JSON value; every caller parses it at its own boundary.
): Promise<unknown> => {
  const response = await session.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  const parsed = cdpEvaluateResponseSchema.safeParse(response);

  if (!parsed.success) {
    throw new Error('Debugger returned an invalid evaluate response.');
  }

  if (parsed.data.exceptionDetails !== undefined) {
    throw new Error(getExceptionMessage(parsed.data.exceptionDetails));
  }

  return parsed.data.result?.value;
};

const waitForPageLoad = async (
  session: BrowserToolPageActionSession,
  now: () => number,
  timeoutMs = DEFAULT_PAGE_LOAD_TIMEOUT_MS
): Promise<void> => {
  const start = now();

  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop -- polling a page condition is inherently sequential
      if ((await runPageExpression(session, 'document.readyState')) === 'complete') {
        return;
      }
    } catch {
      // A destroyed execution context mid-navigation is expected; poll again until the deadline.
    }

    if (now() - start >= timeoutMs) {
      return;
    }

    // eslint-disable-next-line no-await-in-loop -- polling a page condition is inherently sequential
    await sleep(PAGE_LOAD_POLL_INTERVAL_MS);
  }
};

const readPageIdentity = async (
  session: BrowserToolPageActionSession
): Promise<{ readonly title: string; readonly url: string }> => {
  try {
    const parsed = pageIdentitySchema.safeParse(
      await runPageExpression(session, '({ title: document.title, url: location.href })')
    );

    return parsed.success
      ? { title: parsed.data.title ?? '', url: parsed.data.url ?? '' }
      : { title: '', url: '' };
  } catch {
    return { title: '', url: '' };
  }
};

/**
 * Starts a `Page.navigate` and returns its `errorText` when the browser could
 * not load the URL (a network or protocol-level failure). Upstream reports that
 * as a tool error instead of the previous page's identity.
 */
const navigateToUrl = async (
  session: BrowserToolPageActionSession,
  url: string
): Promise<string | undefined> => {
  const parsed = cdpNavigateResponseSchema.safeParse(await session.send('Page.navigate', { url }));
  const errorText = parsed.success ? parsed.data.errorText : undefined;

  return errorText === undefined || errorText.trim() === '' ? undefined : errorText;
};

const resolveElementObjectId = async (
  session: BrowserToolPageActionSession,
  resolved: BrowserToolUniqueTarget
): Promise<string | undefined> => {
  const response = await session.send(
    'DOM.resolveNode',
    resolved.kind === 'ref'
      ? { backendNodeId: resolved.backendNodeId }
      : { nodeId: resolved.nodeId }
  );
  const parsed = cdpResolveNodeResponseSchema.safeParse(response);

  return parsed.success ? parsed.data.object?.objectId : undefined;
};

const evaluateFunctionInPage = async (
  session: BrowserToolPageActionSession,
  functionText: string,
  target: string | undefined
): Promise<EvalTabResult> => {
  if (target === undefined) {
    return readEvaluateResponse(
      await session.send('Runtime.evaluate', {
        awaitPromise: true,
        expression: `(${functionText})()`,
        returnByValue: true,
      })
    );
  }

  const resolved = await session.resolveTarget(target);

  if (resolved?.kind === 'ambiguous') {
    return fail(ambiguousSelectorError(resolved.matches));
  }

  if (resolved === undefined) {
    return fail(`Element was not found for target: ${target}`);
  }

  const objectId = await resolveElementObjectId(session, resolved);

  if (objectId === undefined) {
    return fail('Element could not be resolved in the page.');
  }

  return readEvaluateResponse(
    await session.send('Runtime.callFunctionOn', {
      awaitPromise: true,
      functionDeclaration: `function() { return (${functionText})(this); }`,
      objectId,
      returnByValue: true,
    })
  );
};

/**
 * Viewports a resize already overrode, so a later resize clears the old
 * override first. The key is the tab's shared viewport identity, so a resize
 * from one caller view and the tab's own session agree.
 */
const resizedViewports = new WeakSet<object>();

const viewportKeyOf = (session: BrowserToolPageActionSession): object =>
  session.viewportState ?? session;

const runNavigate = async (
  session: BrowserToolPageActionSession,
  args: Record<string, unknown>,
  now: () => number
): Promise<EvalTabResult> => {
  const url = getStringArgument(args, 'url');

  if (url === undefined || url.trim() === '') {
    return fail('browser_navigate needs a url.');
  }

  const navigationError = await navigateToUrl(session, url);

  if (navigationError !== undefined) {
    return fail(`browser_navigate could not load ${url}: ${navigationError}`);
  }

  await waitForPageLoad(session, now);

  return done(await readPageIdentity(session));
};

const runNavigateBack = async (
  session: BrowserToolPageActionSession,
  now: () => number
): Promise<EvalTabResult> => {
  const parsed = navigationHistorySchema.safeParse(await session.send('Page.getNavigationHistory'));

  if (!parsed.success) {
    return fail('The page history was unavailable.');
  }

  const previous =
    parsed.data.currentIndex > 0 ? parsed.data.entries[parsed.data.currentIndex - 1] : undefined;

  if (previous === undefined) {
    return fail('There is no previous page in the history.');
  }

  await session.send('Page.navigateToHistoryEntry', { entryId: previous.id });
  await waitForPageLoad(session, now);
  const identity = await readPageIdentity(session);

  return done({
    title: identity.title === '' ? (previous.title ?? '') : identity.title,
    url: identity.url === '' ? (previous.url ?? '') : identity.url,
  });
};

const runResize = async (
  session: BrowserToolPageActionSession,
  args: Record<string, unknown>
): Promise<EvalTabResult> => {
  const width = getPositiveNumberArgument(args, 'width');
  const height = getPositiveNumberArgument(args, 'height');

  if (width === undefined || height === undefined) {
    return fail('browser_resize needs positive finite width and height.');
  }

  const viewportKey = viewportKeyOf(session);

  if (resizedViewports.has(viewportKey)) {
    await session.send('Emulation.clearDeviceMetricsOverride');
  }

  await session.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  resizedViewports.add(viewportKey);

  return done({ height, width });
};

const runHandleDialog = async (
  session: BrowserToolPageActionSession,
  args: Record<string, unknown>
): Promise<EvalTabResult> => {
  const dialog = session.takeDialog();

  if (dialog === undefined) {
    return fail(BROWSER_TOOL_NO_DIALOG_ERROR);
  }

  const accept = getBooleanArgument(args, 'accept') ?? false;
  const promptText = getStringArgument(args, 'promptText');

  await session.send('Page.handleJavaScriptDialog', {
    accept,
    ...(promptText === undefined ? {} : { promptText }),
  });

  // The message was shown with the modal state, to a caller allowed to read it; echoing it here would show it to all.
  return done({ accepted: accept, type: dialog.type });
};

const runFileUpload = async (
  session: BrowserToolPageActionSession,
  args: Record<string, unknown>
): Promise<EvalTabResult> => {
  const paths = getStringArrayArgument(args, 'paths');
  const chooser = session.takeFileChooser?.();

  if (chooser === undefined) {
    return fail(BROWSER_TOOL_NO_FILE_CHOOSER_ERROR);
  }

  let reference: { readonly backendNodeId?: number; readonly nodeId?: number } | undefined =
    undefined;

  if (chooser.backendNodeId !== undefined) {
    reference = { backendNodeId: chooser.backendNodeId };
  } else if (chooser.nodeId !== undefined) {
    reference = { nodeId: chooser.nodeId };
  }

  if (reference === undefined) {
    return fail(BROWSER_TOOL_NO_FILE_CHOOSER_ERROR);
  }

  await session.send('DOM.setFileInputFiles', { files: paths ?? [], ...reference });

  return paths === undefined ? done({ cancelled: true }) : done({ files: paths });
};

const runEvaluate = async (
  session: BrowserToolPageActionSession,
  args: Record<string, unknown>
): Promise<EvalTabResult> => {
  const functionText = getStringArgument(args, 'function');

  if (functionText === undefined || functionText.trim() === '') {
    return fail('browser_evaluate needs a function argument.');
  }

  const result = await evaluateFunctionInPage(
    session,
    functionText,
    getStringArgument(args, 'target')
  );
  const filename = getStringArgument(args, 'filename');

  return result.ok && filename !== undefined && filename !== ''
    ? done({
        note: 'The Kilo extension cannot write result files; the value is returned instead.',
        value: result.value,
      })
    : result;
};

// eslint-disable-next-line require-await, typescript-eslint/require-await -- the tabs API is optional; the absent branch resolves to no tabs
const listInspectableTabs = async (
  tabsApi: BrowserToolPageTabsApi | undefined
): Promise<InspectableTab[] | undefined> => {
  if (tabsApi?.query === undefined) {
    return undefined;
  }

  return listInspectableTabsWithTabsApi(tabsApi);
};

const closeTab = async (
  tabsApi: BrowserToolPageTabsApi,
  tabId: number,
  session: BrowserToolPageActionSession | undefined
): Promise<EvalTabResult> => {
  const remove = tabsApi.remove?.bind(tabsApi);

  if (remove === undefined) {
    return fail('The browser cannot close tabs through this API.');
  }

  await remove(tabId);
  await session?.dispose?.();

  return done('Closed the tab.');
};

const grantsOrigin = (origins: readonly string[], url: string | undefined): boolean => {
  const origin = toBrowserOrigin(url);

  return origin !== undefined && origins.some(pattern => originPatternMatches(pattern, origin));
};

/**
 * The tabs an agent caller can reach, which is the D9 boundary: its session's
 * group (the tabs the user dragged in or shared). Acting on any other tab is
 * refused, and a grant for that origin is not an allowance, so listing one
 * would only report the user's other tabs — with their count — and hand out an
 * index that select and close must refuse. A panel caller reaches every tab.
 */
const reachableTabs = (
  tabs: readonly InspectableTab[],
  access: BrowserAgentAccess | undefined
): readonly InspectableTab[] =>
  access === undefined ? tabs : tabs.filter(tab => access.groupTabs?.includes(tab.id) === true);

type ReachableTabResolution =
  | { readonly ok: true; readonly tab: InspectableTab }
  | { readonly error: string; readonly ok: false };

/**
 * The tab at a listed index. `list` numbers only the reachable tabs, so select
 * and close resolve the same way. Every index past that list is one refusal
 * when the caller is an agent: a different answer for a browser tab the list
 * omits would report how many tabs the browser holds. Without agent access
 * the list is the browser's, so a past index names nothing.
 */
const reachableTabAt = (
  tabs: readonly InspectableTab[],
  access: BrowserAgentAccess | undefined,
  index: number
): ReachableTabResolution => {
  const tab = reachableTabs(tabs, access)[index];

  if (tab !== undefined) {
    return { ok: true, tab };
  }

  return access === undefined
    ? { error: `No tab at index ${String(index)}.`, ok: false }
    : { error: AGENT_TAB_OUTSIDE_GROUP_ERROR, ok: false };
};

/**
 * The tab tools: `list` reports the tabs this caller may reach, `select` and
 * `close` address that same list by index, and `new` opens a tab behind the
 * user's.
 */
const runTabs = async (
  args: Record<string, unknown>,
  session: BrowserToolPageActionSession | undefined,
  options: BrowserToolPageActionOptions
): Promise<EvalTabResult> => {
  const action = getStringArgument(args, 'action');

  if (action === undefined || action === '') {
    return fail('browser_tabs requires an action of list, new, close or select.');
  }

  if (action === 'list') {
    const tabs = await listInspectableTabs(options.tabsApi);

    if (tabs === undefined) {
      return fail('The browser tab API is unavailable.');
    }

    // The index counts only the tabs this caller can reach, so a listed index is always one it may select or close.
    const listed = reachableTabs(tabs, options.agentAccess).map((tab, index) => ({
      index,
      selected: tab.id === options.tabId,
      title: tab.title,
      url: tab.url,
    }));

    // An agent reads Playwright MCP's own list shape, `- 1: (current) [Title](url)`.
    // One prompt then works on either backend, and the list costs lines instead of JSON per tab.
    // The panel keeps the tab objects it renders from.
    return done(
      options.agentAccess === undefined
        ? { tabs: listed }
        : listed
            .map(
              tab =>
                `- ${String(tab.index)}: ${tab.selected ? '(current) ' : ''}[${tab.title}](${tab.url})`
            )
            .join('\n')
    );
  }

  if (action === 'new') {
    const create = options.tabsApi?.create?.bind(options.tabsApi);

    if (create === undefined) {
      return fail('The browser cannot open a new tab through this API.');
    }

    const url = getStringArgument(args, 'url');

    if (
      options.agentAccess !== undefined &&
      url !== undefined &&
      !grantsOrigin(options.agentAccess.navigateOrigins, url)
    ) {
      return fail(`Opening a tab at ${url} needs a navigate grant for that origin (blocked).`);
    }

    // A tool call never takes the user's foreground: the tab opens behind the one they are looking at (D9).
    const tab = await create(url === undefined ? { active: false } : { active: false, url });

    if (tab?.id !== undefined) {
      options.noteTabCreated?.(tab.id, options.tabId);
    }

    return done({
      selected: true,
      tabId: tab?.id,
      title: tab?.title ?? '',
      url: tab?.url ?? url ?? '',
    });
  }

  if (action === 'close') {
    const index = getIndexArgument(args, 'index');
    let { tabId } = options;

    if (index !== undefined) {
      const tabs = await listInspectableTabs(options.tabsApi);
      const found =
        tabs === undefined ? undefined : reachableTabAt(tabs, options.agentAccess, index);

      if (found === undefined || !found.ok) {
        return fail(found?.error ?? `No tab at index ${String(index)}.`);
      }

      tabId = found.tab.id;
    }

    if (tabId === undefined) {
      return fail(BROWSER_TOOL_NO_SELECTED_TAB_ERROR);
    }

    if (options.tabsApi === undefined) {
      return fail('The browser tab API is unavailable.');
    }

    // Disposing is only correct when the closed tab is the agent's target.
    return closeTab(options.tabsApi, tabId, tabId === options.tabId ? session : undefined);
  }

  if (action === 'select') {
    const index = getIndexArgument(args, 'index');

    if (index === undefined) {
      return fail('browser_tabs select needs an index.');
    }

    const tabs = await listInspectableTabs(options.tabsApi);
    const found = tabs === undefined ? undefined : reachableTabAt(tabs, options.agentAccess, index);

    if (found === undefined || !found.ok) {
      return fail(found?.error ?? `No tab at index ${String(index)}.`);
    }

    const { tab } = found;

    const update = options.tabsApi?.update?.bind(options.tabsApi);

    if (update === undefined) {
      return fail('The browser cannot select tabs through this API.');
    }

    await update(tab.id, { active: true });

    return done({
      selected: true,
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
    });
  }

  return fail(`browser_tabs requires an action of list, new, close or select.`);
};

const runWebMcpList = async (options: BrowserToolPageActionOptions): Promise<EvalTabResult> => {
  if (options.webMcpDiscover === undefined) {
    return fail('WebMCP discovery API is unavailable.');
  }

  if (options.tabId === undefined) {
    return fail(BROWSER_TOOL_NO_SELECTED_TAB_ERROR);
  }

  const discovery = await options.webMcpDiscover(options.tabId);

  if (discovery === undefined) {
    return fail('WebMCP discovery returned an invalid result.');
  }

  return done({
    tools: readableWebMcpTools(discovery.tools, options.agentScope?.readableOrigins).map(tool => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name,
      origin: tool.origin,
      title: tool.title,
    })),
  });
};

const runWebMcpCall = async (
  args: Record<string, unknown>,
  options: BrowserToolPageActionOptions
): Promise<EvalTabResult> => {
  if (options.webMcpDiscover === undefined || options.webMcpExecute === undefined) {
    return fail('WebMCP API is unavailable.');
  }

  const parsed = webMcpCallArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    return fail(webMcpCallArgumentError(parsed.error));
  }

  const { name } = parsed.data;

  if (options.tabId === undefined) {
    return fail(BROWSER_TOOL_NO_SELECTED_TAB_ERROR);
  }

  const discovery = await options.webMcpDiscover(options.tabId);

  if (discovery === undefined || discovery.documentId === '') {
    return fail('WebMCP discovery returned an invalid result.');
  }

  const { routes } = buildWebMcpToolDefinitions({
    documentId: discovery.documentId,
    tabId: options.tabId,
    tools: discovery.tools,
  });
  const route = routes.get(name);

  if (route === undefined) {
    return fail(`WebMCP tool "${name}" is not available. List the page's WebMCP tools first.`);
  }

  // Discovery and execution run in the tab's top-level document, so a tool that names no origin is not one this call can safely bind to a page.
  if (route.origin === '') {
    return fail(
      `WebMCP tool "${name}" does not name the origin it belongs to, so the call was refused.`
    );
  }

  // The route came from a listing this call made, so a descriptor registered since is judged here too: the page controls the descriptor, and execution happens in the tab's own document.
  const getTab = options.tabsApi?.get?.bind(options.tabsApi);
  let tab: BrowserTabInfo | undefined = undefined;

  if (getTab !== undefined) {
    try {
      tab = await getTab(options.tabId);
    } catch {
      tab = undefined;
    }
  }

  const tabOrigin = toBrowserOrigin(tab?.url);

  if (tabOrigin === undefined) {
    return fail(
      `WebMCP tool "${name}" reports origin ${route.origin}, but the tab's own origin cannot be read, so the call was refused.`
    );
  }

  if (tabOrigin !== route.origin) {
    return fail(
      `WebMCP tool "${name}" reports origin ${route.origin} but runs in the tab's own document (${tabOrigin}), so the call was refused.`
    );
  }

  const result = await options.webMcpExecute(
    createWebMcpToolCall({
      arguments: parsed.data.params ?? {},
      definitionSignature: route.definitionSignature,
      documentId: route.documentId,
      name,
      tabId: route.tabId,
      webMcpOrigin: route.origin,
    })
  );

  return result.ok
    ? done({
        note: 'Page-provided WebMCP output is untrusted.',
        source: 'webmcp',
        untrusted: true,
        value: result.value,
      })
    : result;
};

/**
 * Dispatch one page or lifecycle browser tool. `name` accepts the upstream
 * name (`browser_navigate`) or the model-facing `kilo_browser_navigate`; `args`
 * are the model's verbatim arguments, parsed per tool at this boundary. A
 * session that is gone (the target tab was closed) reports "no selected tab"
 * instead of throwing, and every failure becomes a tool error rather than a
 * rejected turn.
 */
// eslint-disable-next-line max-params -- the dispatcher mirrors the executor's call shape: name, verbatim arguments, session, overrides
export const runPageBrowserTool = async (
  name: string,
  args: Record<string, unknown>,
  session: BrowserToolPageActionSession | undefined,
  options: BrowserToolPageActionOptions = {}
): Promise<EvalTabResult> => {
  const upstreamName = toUpstreamToolName(name);
  const now = options.now ?? Date.now;

  try {
    if (upstreamName === 'browser_tabs') {
      return await runTabs(args, session, options);
    }

    if (upstreamName === 'browser_webmcp_list') {
      return await runWebMcpList(options);
    }

    if (upstreamName === 'browser_webmcp_call') {
      return await runWebMcpCall(args, options);
    }

    if (upstreamName === 'browser_close') {
      if (options.tabId === undefined) {
        return fail(BROWSER_TOOL_NO_SELECTED_TAB_ERROR);
      }

      if (options.tabsApi === undefined) {
        return fail('The browser tab API is unavailable.');
      }

      return await closeTab(options.tabsApi, options.tabId, session);
    }

    if (session === undefined) {
      return fail(BROWSER_TOOL_NO_SELECTED_TAB_ERROR);
    }

    switch (upstreamName) {
      case 'browser_navigate': {
        return await runNavigate(session, args, now);
      }
      case 'browser_navigate_back': {
        return await runNavigateBack(session, now);
      }
      case 'browser_resize': {
        return await runResize(session, args);
      }
      case 'browser_handle_dialog': {
        return await runHandleDialog(session, args);
      }
      case 'browser_file_upload': {
        return await runFileUpload(session, args);
      }
      case 'browser_evaluate': {
        return await runEvaluate(session, args);
      }
      case 'browser_run_code_unsafe': {
        return fail(RUN_CODE_UNSUPPORTED_ERROR);
      }
      default: {
        return fail(`${name} is not a page browser tool.`);
      }
    }
  } catch (error) {
    return fail(
      `${upstreamName} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Clears the device-metrics override a resize applied to this tab. The wiring
 * calls it when it disposes a tab's session so a resized tab returns to its
 * natural viewport.
 */
export const clearBrowserToolResize = async (
  session: BrowserToolPageActionSession | undefined
): Promise<void> => {
  if (session === undefined) {
    return;
  }

  const viewportKey = viewportKeyOf(session);

  if (!resizedViewports.has(viewportKey)) {
    return;
  }

  resizedViewports.delete(viewportKey);

  try {
    await session.send('Emulation.clearDeviceMetricsOverride');
  } catch {
    // The tab may be gone; the override went with it.
  }
};
