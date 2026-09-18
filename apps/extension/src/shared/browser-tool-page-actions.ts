/* eslint-disable max-lines -- One module owns the page and lifecycle browser tools; the shared CDP helpers keep their shapes consistent. */
import { z } from 'zod';
import { createWebMcpToolCall } from './agent-conversation';
import { KILO_BROWSER_TOOL_PREFIX } from './browser-tool-contract';
import { pressKeyChord } from './browser-tool-interact-actions';
import type { BrowserToolDialog, BrowserToolResolvedTarget } from './browser-tool-session';
import { listInspectableTabsWithTabsApi } from './tab-debugger';
import type {
  BrowserTabInfo,
  BrowserTabsApi,
  EvalTabResult,
  InspectableTab,
  WebMcpDiscoveryResult,
} from './tab-debugger';
import type { WebMcpToolCallEvent } from './agent-conversation';
import { buildWebMcpToolDefinitions } from './web-mcp-tools';

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

/** The page methods browser_run_code_unsafe backs; anything else is a named tool error. */
export const RUN_CODE_SUPPORTED_METHODS = [
  'click',
  'content',
  'evaluate',
  'fill',
  'goto',
  'press',
  'screenshot',
  'selectOption',
  'title',
  'type',
  'waitForSelector',
] as const;

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
}

/** `chrome.tabs` plus the create/remove calls the browser_tabs actions need. */
export interface BrowserToolPageTabsApi extends BrowserTabsApi {
  readonly create?: (properties: {
    readonly url?: string;
  }) => Promise<BrowserTabInfo> | BrowserTabInfo;
  readonly remove?: (tabId: number) => Promise<void> | void;
}

export interface BrowserToolPageActionOptions {
  /** WebMCP discovery across frames; wired to the existing WebMCP runtime. */
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
const jsonRecordSchema = z.record(z.string(), z.unknown());
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
const cdpScreenshotResponseSchema = z.object({ data: z.string().optional() });
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
const pageScreenshotSchema = z.object({ base64: z.string(), mediaType: z.literal('image/png') });

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

const getRecordArgument = (
  args: Record<string, unknown>,
  name: string
): Record<string, unknown> | undefined => {
  const parsed = jsonRecordSchema.safeParse(args[name]);

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
  resolved: BrowserToolResolvedTarget
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

const clickExpression = (selector: string): string =>
  `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (element === null) { throw new Error('No element matches selector: ' + ${JSON.stringify(selector)}); } element.click(); return true; })()`;

const fillExpression = (selector: string, value: string): string =>
  `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (element === null) { throw new Error('No element matches selector: ' + ${JSON.stringify(selector)}); } const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (setter) { setter.call(element, ${JSON.stringify(value)}); } else { element.value = ${JSON.stringify(value)}; } element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;

const focusExpression = (selector: string): string =>
  `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (element === null) { throw new Error('No element matches selector: ' + ${JSON.stringify(selector)}); } element.focus(); return true; })()`;

const selectOptionExpression = (selector: string, values: readonly string[]): string =>
  `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLSelectElement)) { throw new Error('Element is not a select: ' + ${JSON.stringify(selector)}); } const wanted = ${JSON.stringify(values)}.map(String); for (const option of element.options) { option.selected = wanted.includes(option.value) || wanted.includes((option.textContent ?? '').trim()); } element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;

const waitForSelectorExpression = (selector: string): string =>
  `document.querySelector(${JSON.stringify(selector)}) !== null`;

/**
 * The `page` argument browser_run_code_unsafe hands the snippet, backed by the
 * session's CDP primitives. Every method the extension cannot back reports a
 * tool error naming the method instead of failing as an undefined call.
 */
const createRunCodePage = (
  session: BrowserToolPageActionSession,
  now: () => number
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the page facade surfaces the page's own untyped values to the snippet by contract.
): Record<string, (...args: never[]) => Promise<unknown>> => {
  const handlers = {
    async click(selector: string): Promise<void> {
      await runPageExpression(session, clickExpression(selector));
    },
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- the page facade hands the snippet the page's own untyped value
    content(): Promise<unknown> {
      return runPageExpression(session, 'document.documentElement.outerHTML');
    },
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- the page facade hands the snippet the page's own untyped value
    evaluate(handler: unknown, argument?: unknown): Promise<unknown> {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the facade accepts a handler function or pre-stringified source; a function is serialized
      const source = typeof handler === 'function' ? handler.toString() : String(handler);

      return runPageExpression(
        session,
        `(${source})(${JSON.stringify(argument === undefined ? null : argument)})`
      );
    },
    async fill(selector: string, value: string): Promise<void> {
      await runPageExpression(session, fillExpression(selector, value));
    },
    async goto(url: string): Promise<{ readonly title: string; readonly url: string }> {
      const navigationError = await navigateToUrl(session, url);

      if (navigationError !== undefined) {
        throw new Error(`page.goto could not load ${url}: ${navigationError}`);
      }

      await waitForPageLoad(session, now);

      return readPageIdentity(session);
    },
    async press(key: string): Promise<void> {
      const pressed = await pressKeyChord(session, key);

      if (!pressed.ok) {
        throw new Error(pressed.error);
      }
    },
    async screenshot(): Promise<z.infer<typeof pageScreenshotSchema>> {
      const response = await session.send('Page.captureScreenshot', { format: 'png' });
      const parsed = cdpScreenshotResponseSchema.safeParse(response);

      return { base64: parsed.success ? (parsed.data.data ?? '') : '', mediaType: 'image/png' };
    },
    async selectOption(selector: string, values: string | readonly string[]): Promise<void> {
      await runPageExpression(
        session,
        selectOptionExpression(selector, Array.isArray(values) ? values : [values])
      );
    },
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- the page facade hands the snippet the page's own untyped value
    title(): Promise<unknown> {
      return runPageExpression(session, 'document.title');
    },
    async type(selector: string, text: string): Promise<void> {
      await runPageExpression(session, focusExpression(selector));
      await session.send('Input.insertText', { text });
    },
    async waitForSelector(
      selector: string,
      options?: { readonly timeout?: number }
    ): Promise<void> {
      const requested = options?.timeout;
      const timeoutMs =
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- snippet-authored options are untyped; validate the timeout before clamping it
        typeof requested === 'number' && Number.isFinite(requested) && requested > 0
          ? Math.min(requested, DEFAULT_PAGE_LOAD_TIMEOUT_MS)
          : DEFAULT_PAGE_LOAD_TIMEOUT_MS;
      const start = now();

      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- polling a page condition is inherently sequential
        if ((await runPageExpression(session, waitForSelectorExpression(selector))) === true) {
          return;
        }

        if (now() - start >= timeoutMs) {
          throw new Error(`Timed out waiting for selector: ${selector}`);
        }

        // eslint-disable-next-line no-await-in-loop -- polling a page condition is inherently sequential
        await sleep(PAGE_LOAD_POLL_INTERVAL_MS);
      }
    },
  };

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- the run-code page is a deliberately open facade; unknown members throw at access time.
  return new Proxy(handlers, {
    get: (target, property, receiver) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a Proxy get trap receives arbitrary string or symbol keys; there is no schema to parse
      if (typeof property === 'symbol' || property === 'then') {
        return;
      }

      if (Object.hasOwn(target, property)) {
        // oxlint-disable-next-line anti-slop/no-reflect-get, typescript-eslint/no-unsafe-return -- a Proxy get trap has no direct member access for a runtime key
        return Reflect.get(target, property, receiver);
      }

      throw new Error(
        `page.${property} is not supported by the Kilo extension. Supported methods: ${RUN_CODE_SUPPORTED_METHODS.join(', ')}.`
      );
    },
  });
};

// oxlint-disable-next-line anti-slop/no-unknown-returns -- the snippet resolves to the page's own JSON value; the shared serializer guards the result
type RunCodeSnippet = (page: unknown) => Promise<unknown>;

const runCodeUnsafe = async (
  session: BrowserToolPageActionSession,
  args: Record<string, unknown>,
  now: () => number
): Promise<EvalTabResult> => {
  const code = getStringArgument(args, 'code');
  const filename = getStringArgument(args, 'filename');

  if (code === undefined || code.trim() === '') {
    return filename === undefined || filename === ''
      ? fail('browser_run_code_unsafe requires a code argument.')
      : fail(
          'browser_run_code_unsafe cannot load code from a file: the Kilo extension has no workspace filesystem. Pass the code inline as a function of `page`.'
        );
  }

  let compiled: RunCodeSnippet | undefined = undefined;

  try {
    // The snippet is model-authored and RCE-equivalent by contract; it runs in the extension runtime with a page object backed by the session primitives.
    // eslint-disable-next-line eslint/no-new-func, typescript-eslint/no-implied-eval, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-type-assertion
    const AsyncFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
      ...parameters: string[]
    ) => RunCodeSnippet;

    compiled = new AsyncFunctionConstructor('page', `return await (${code})(page);`);
  } catch (error) {
    return fail(
      `browser_run_code_unsafe could not compile the snippet: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }

  try {
    return serializeBrowserEvaluateResult(await compiled(createRunCodePage(session, now)));
  } catch (error) {
    return fail(
      `browser_run_code_unsafe failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
};

/** Sessions a resize already overrode, so a later resize clears the old override first. */
const resizedSessions = new WeakSet<BrowserToolPageActionSession>();

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

  if (resizedSessions.has(session)) {
    await session.send('Emulation.clearDeviceMetricsOverride');
  }

  await session.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  resizedSessions.add(session);

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

  return done({ accepted: accept, message: dialog.message, type: dialog.type });
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

    return done({
      tabs: tabs.map((tab, index) => ({
        index,
        selected: tab.id === options.tabId,
        title: tab.title,
        url: tab.url,
      })),
    });
  }

  if (action === 'new') {
    const create = options.tabsApi?.create?.bind(options.tabsApi);

    if (create === undefined) {
      return fail('The browser cannot open a new tab through this API.');
    }

    const url = getStringArgument(args, 'url');
    const tab = await create(url === undefined ? {} : { url });

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
      const tab = tabs?.[index];

      if (tab === undefined) {
        return fail(`No tab at index ${String(index)}.`);
      }

      tabId = tab.id;
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
    const tab = tabs?.[index];

    if (tab === undefined) {
      return fail(`No tab at index ${String(index)}.`);
    }

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
    tools: discovery.tools.map(tool => ({
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

  const name = getStringArgument(args, 'name');

  if (name === undefined || name === '') {
    return fail('browser_webmcp_call needs a tool name.');
  }

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
    return fail(`WebMCP tool "${name}" is not available. Call kilo_browser_webmcp_list first.`);
  }

  const result = await options.webMcpExecute(
    createWebMcpToolCall({
      arguments: getRecordArgument(args, 'params') ?? {},
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
        return await runCodeUnsafe(session, args, now);
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
 * Clears the device-metrics override a resize applied to this session. The
 * wiring calls it when it disposes a session so a resized tab returns to its
 * natural viewport.
 */
export const clearBrowserToolResize = async (
  session: BrowserToolPageActionSession | undefined
): Promise<void> => {
  if (session === undefined || !resizedSessions.has(session)) {
    return;
  }

  resizedSessions.delete(session);

  try {
    await session.send('Emulation.clearDeviceMetricsOverride');
  } catch {
    // The tab may be gone; the override went with it.
  }
};
