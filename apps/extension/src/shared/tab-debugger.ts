/* eslint-disable max-lines */
import { z } from 'zod';

export const DEBUGGER_PROTOCOL_VERSION = '1.3';
export const LIST_INSPECTABLE_TABS_MESSAGE = 'kilo.tabs.listInspectable';
export const EVAL_TAB_MESSAGE = 'kilo.tabs.eval';
export const PAGE_SNAPSHOT_MESSAGE = 'kilo.tabs.snapshot';
export const VIEWPORT_SCREENSHOT_MESSAGE = 'kilo.tabs.viewportScreenshot';
export const DEFAULT_EVAL_TIMEOUT_MS = 5000;

export interface ChromeDebuggerTargetInfo {
  readonly attached?: boolean;
  readonly tabId?: number;
  readonly title?: string;
  readonly type?: string;
  readonly url?: string;
}

export interface ChromeDebuggerTarget {
  readonly tabId: number;
}

export interface ChromeDebuggerApi {
  readonly attach: (target: ChromeDebuggerTarget, requiredVersion: string) => Promise<void> | void;
  readonly detach: (target: ChromeDebuggerTarget) => Promise<void> | void;
  readonly getTargets: () => Promise<ChromeDebuggerTargetInfo[]> | ChromeDebuggerTargetInfo[];
  readonly sendCommand: (
    target: ChromeDebuggerTarget,
    method: string,
    commandParams?: Record<string, unknown>
  ) => unknown;
}

export interface BrowserTabInfo {
  readonly active?: boolean;
  readonly id?: number;
  readonly title?: string;
  readonly url?: string;
  readonly windowId?: number;
}

export interface BrowserTabsApi {
  readonly captureVisibleTab?: (
    windowId?: number,
    options?: { readonly format: 'png' }
  ) => Promise<string> | string;
  readonly get?: (tabId: number) => Promise<BrowserTabInfo> | BrowserTabInfo;
  readonly query: (
    queryInfo: Record<string, unknown>
  ) => Promise<BrowserTabInfo[]> | BrowserTabInfo[];
  readonly update?: (
    tabId: number,
    updateProperties: { readonly active: boolean }
  ) => Promise<BrowserTabInfo> | BrowserTabInfo;
}

export interface BrowserScriptingInjectionResult {
  // Firefox sets `error` (the thrown/rejected value) when the injected function fails; `result` is absent.
  readonly error?: unknown;
  readonly result?: unknown;
}

export interface BrowserScriptingApi {
  readonly executeScript: (details: {
    readonly args: string[];
    readonly func: (...args: string[]) => unknown;
    readonly target: { readonly tabId: number };
    readonly world: 'MAIN';
  }) => Promise<BrowserScriptingInjectionResult[]> | BrowserScriptingInjectionResult[];
}

export interface InspectableTab {
  readonly id: number;
  readonly title: string;
  readonly url: string;
}

export interface PageSnapshotNode {
  readonly href?: string;
  readonly id: string;
  readonly label?: string;
  readonly role: string;
  readonly state?: Record<string, boolean>;
  readonly tag: string;
  readonly text?: string;
}

export interface PageSnapshotLimits {
  readonly maxNodeCount: number;
  readonly maxNodeTextLength: number;
  readonly maxTextLength: number;
}

export interface PageSnapshot {
  readonly limits: PageSnapshotLimits;
  readonly nodes: PageSnapshotNode[];
  readonly nodesTruncated: boolean;
  readonly snapshotId: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly title: string;
  readonly url: string;
}

export interface ViewportScreenshot {
  readonly dataUrl: string;
  readonly devicePixelRatio: number;
  readonly height: number;
  readonly mediaType: 'image/png';
  readonly width: number;
}

export type EvalTabResult =
  | {
      readonly description?: string;
      readonly ok: true;
      readonly value?: unknown;
    }
  | {
      readonly error: string;
      readonly ok: false;
    };

export type TabDebuggerRequest =
  | {
      readonly type: typeof LIST_INSPECTABLE_TABS_MESSAGE;
    }
  | {
      readonly code: string;
      readonly tabId: number;
      readonly timeoutMs?: number;
      readonly type: typeof EVAL_TAB_MESSAGE;
    }
  | {
      readonly tabId: number;
      readonly timeoutMs?: number;
      readonly type: typeof PAGE_SNAPSHOT_MESSAGE;
    }
  | {
      readonly tabId: number;
      readonly type: typeof VIEWPORT_SCREENSHOT_MESSAGE;
    };

export type TabDebuggerResponse =
  | {
      readonly ok: true;
      readonly tabs: InspectableTab[];
      readonly type: typeof LIST_INSPECTABLE_TABS_MESSAGE;
    }
  | {
      readonly result: EvalTabResult;
      readonly ok: true;
      readonly type: typeof EVAL_TAB_MESSAGE;
    }
  | {
      readonly result: EvalTabResult;
      readonly ok: true;
      readonly type: typeof PAGE_SNAPSHOT_MESSAGE;
    }
  | {
      readonly result: EvalTabResult;
      readonly ok: true;
      readonly type: typeof VIEWPORT_SCREENSHOT_MESSAGE;
    }
  | {
      readonly error: string;
      readonly ok: false;
    };

const inspectableTabSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
});
const evalTabResultSchema = z.union([
  z.object({
    description: z.string().optional(),
    ok: z.literal(true),
    value: z.unknown().optional(),
  }),
  z.object({
    error: z.string(),
    ok: z.literal(false),
  }),
]);
const tabDebuggerRequestSchema = z.union([
  z.object({
    type: z.literal(LIST_INSPECTABLE_TABS_MESSAGE),
  }),
  z.object({
    tabId: z.number(),
    timeoutMs: z.number().optional(),
    type: z.literal(PAGE_SNAPSHOT_MESSAGE),
  }),
  z.object({
    tabId: z.number(),
    type: z.literal(VIEWPORT_SCREENSHOT_MESSAGE),
  }),
  z.object({
    code: z.string(),
    tabId: z.number(),
    timeoutMs: z.number().optional(),
    type: z.literal(EVAL_TAB_MESSAGE),
  }),
]);
const tabDebuggerResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    tabs: z.array(inspectableTabSchema),
    type: z.literal(LIST_INSPECTABLE_TABS_MESSAGE),
  }),
  z.object({
    ok: z.literal(true),
    result: evalTabResultSchema,
    type: z.literal(EVAL_TAB_MESSAGE),
  }),
  z.object({
    ok: z.literal(true),
    result: evalTabResultSchema,
    type: z.literal(PAGE_SNAPSHOT_MESSAGE),
  }),
  z.object({
    ok: z.literal(true),
    result: evalTabResultSchema,
    type: z.literal(VIEWPORT_SCREENSHOT_MESSAGE),
  }),
  z.object({
    error: z.string(),
    ok: z.literal(false),
  }),
]);
const chromeEvalResultSchema = z.object({
  description: z.string().optional(),
  value: z.unknown().optional(),
});
const chromeEvalResponseSchema = z.object({
  exceptionDetails: z.unknown().optional(),
  result: chromeEvalResultSchema.optional(),
});
const maxEvalStringLength = 8000;

const isNormalPageUrl = (url: string | undefined): url is string =>
  url?.startsWith('http://') === true ||
  url?.startsWith('https://') === true ||
  url?.startsWith('file://') === true;

export const listInspectableTabs = async (
  debuggerApi: ChromeDebuggerApi
): Promise<InspectableTab[]> => {
  const targets = await debuggerApi.getTargets();

  return targets
    .filter(
      (
        target
      ): target is ChromeDebuggerTargetInfo & { readonly tabId: number; readonly url: string } =>
        target.type === 'page' && typeof target.tabId === 'number' && isNormalPageUrl(target.url)
    )
    .map(target => {
      const title = target.title?.trim();

      return {
        id: target.tabId,
        title: title === undefined || title === '' ? target.url : title,
        url: target.url,
      };
    });
};

export const listInspectableTabsWithTabsApi = async (
  tabsApi: BrowserTabsApi
): Promise<InspectableTab[]> => {
  const tabs = await tabsApi.query({});

  return tabs
    .filter(
      (tab): tab is BrowserTabInfo & { readonly id: number; readonly url: string } =>
        typeof tab.id === 'number' && isNormalPageUrl(tab.url)
    )
    .map(tab => {
      const title = tab.title?.trim();

      return {
        id: tab.id,
        title: title === undefined || title === '' ? tab.url : title,
        url: tab.url,
      };
    });
};

const getTabId = (tab: BrowserTabInfo | undefined): number | undefined =>
  typeof tab?.id === 'number' ? tab.id : undefined;
const getPngDimensions = (dataUrl: string): { height: number; width: number } | undefined => {
  try {
    const bytes = Uint8Array.from(
      atob(dataUrl.slice('data:image/png;base64,'.length)),
      character => character.codePointAt(0) ?? 0
    );
    const view = new DataView(bytes.buffer);

    return { height: view.getUint32(20), width: view.getUint32(16) };
  } catch {
    return undefined;
  }
};

// Ponytail: one global capture lock since captureVisibleTab grabs whichever tab is active in a window, so the activate/capture/restore window must not interleave (screenshots are rare; key per-window only if throughput matters).
const ignoreSettled = (): void => {};
// eslint-disable-next-line promise/prefer-await-to-then
let screenshotCaptureChain: Promise<unknown> = Promise.resolve();
const runScreenshotCaptureExclusively = <Result>(task: () => Promise<Result>): Promise<Result> => {
  // The promise chain is the mutex; keep it alive after either outcome.
  // eslint-disable-next-line promise/prefer-await-to-then
  const run = screenshotCaptureChain.then(task, task);

  // eslint-disable-next-line promise/prefer-await-to-then
  screenshotCaptureChain = run.then(ignoreSettled, ignoreSettled);

  return run;
};

export const getViewportScreenshotWithTabsApi = ({
  tabId,
  tabsApi,
}: {
  readonly tabId: number;
  readonly tabsApi: BrowserTabsApi;
}): Promise<EvalTabResult> => {
  const captureVisibleTab = tabsApi.captureVisibleTab?.bind(tabsApi);
  const getTab = tabsApi.get?.bind(tabsApi);
  const updateTab = tabsApi.update?.bind(tabsApi);
  const queryTabs = tabsApi.query.bind(tabsApi);

  if (captureVisibleTab === undefined || getTab === undefined || updateTab === undefined) {
    return Promise.resolve({ error: 'Viewport screenshot API is unavailable.', ok: false });
  }

  return runScreenshotCaptureExclusively(async () => {
    const { windowId } = await getTab(tabId);
    const activeTabQuery =
      windowId === undefined ? { active: true, currentWindow: true } : { active: true, windowId };
    const [previousActiveTab] = await queryTabs(activeTabQuery);
    const previousActiveTabId = getTabId(previousActiveTab);

    try {
      await updateTab(tabId, { active: true });
      const [activeTab] = await queryTabs(activeTabQuery);

      // A manual tab switch can land between activation and capture; refuse rather than capture and upload a different tab's contents.
      if (getTabId(activeTab) !== tabId) {
        return { error: 'The selected tab was not active at capture time.', ok: false };
      }

      const dataUrl = await captureVisibleTab(windowId, { format: 'png' });

      if (!dataUrl.startsWith('data:image/png;base64,')) {
        return { error: 'Viewport screenshot API returned an invalid image.', ok: false };
      }
      const dimensions = getPngDimensions(dataUrl);

      return {
        ok: true,
        value: {
          dataUrl,
          devicePixelRatio: 1,
          height: dimensions?.height ?? 0,
          mediaType: 'image/png',
          width: dimensions?.width ?? 0,
        } satisfies ViewportScreenshot,
      };
    } finally {
      if (previousActiveTabId !== undefined && previousActiveTabId !== tabId) {
        try {
          await updateTab(previousActiveTabId, { active: true });
        } catch {
          // The previous tab may have closed; don't let restore mask the result.
        }
      }
    }
  });
};

const getEvalExpression = (code: string): string => `(async () => { ${code} })()`;
const getExceptionMessage = (exceptionDetails: unknown): string => {
  if (
    typeof exceptionDetails === 'object' &&
    exceptionDetails !== null &&
    'text' in exceptionDetails &&
    typeof exceptionDetails.text === 'string' &&
    exceptionDetails.text.trim() !== ''
  ) {
    return `Page evaluation failed: ${exceptionDetails.text}`;
  }

  return 'Page evaluation failed.';
};
const extractInjectionErrorText = (error: unknown): string | undefined => {
  if (typeof error === 'string' && error.trim() !== '') {
    return error;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.trim() !== ''
  ) {
    return error.message;
  }

  return undefined;
};
const toSerializableEvalResult = (value: unknown): EvalTabResult => {
  try {
    JSON.stringify(value);
  } catch {
    return { error: 'Eval result was not JSON-serializable.', ok: false };
  }

  if (typeof value === 'string' && value.length > maxEvalStringLength) {
    return {
      ok: true,
      value: {
        originalLength: value.length,
        truncated: true,
        type: 'string',
        value: value.slice(0, maxEvalStringLength),
      },
    };
  }

  return { ok: true, value };
};

const runInjectedEval = (code: string): unknown =>
  // eslint-disable-next-line eslint/no-new-func, typescript-eslint/no-implied-eval, typescript-eslint/no-unsafe-call
  new Function(`return (async () => { ${code} })()`)();

/* eslint-disable unicorn/consistent-function-scoping */
const runInjectedPageSnapshot = (timeoutMsText: string): PageSnapshot => {
  const maxTextLength = 8000;
  const maxNodeCount = 80;
  const maxNodeTextLength = 500;
  const timeoutMs = Number(timeoutMsText);
  const deadline =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? performance.now() + timeoutMs
      : Number.POSITIVE_INFINITY;
  const checkDeadline = (): void => {
    if (performance.now() > deadline) {
      throw new Error('Page snapshot timed out.');
    }
  };
  const normalize = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();
  const truncate = (value: string, maxLength: number): string =>
    value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  const sanitizeUrl = (value: string): string => {
    try {
      const url = new URL(value);

      url.search = '';
      url.hash = '';

      return url.toString();
    } catch {
      return '[invalid URL]';
    }
  };
  const getLabelText = (element: Element): string => {
    const ariaLabel = element.getAttribute('aria-label');

    if (ariaLabel !== null && ariaLabel.trim() !== '') {
      return ariaLabel;
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const labels =
        element.labels === null ? [] : [...element.labels].map(label => label.textContent ?? '');
      const placeholder =
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.placeholder
          : '';

      return [...labels, placeholder].find(value => value.trim() !== '') ?? '';
    }

    return '';
  };
  const nonRenderedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);
  const isRenderedTextNode = (textNode: Node): boolean => {
    // Walk ancestors so hidden/non-content text (script JSON, inline styles, display:none modals, aria-hidden subtrees) is never surfaced as "visible page text".
    for (let element = textNode.parentElement; element !== null; element = element.parentElement) {
      if (nonRenderedTags.has(element.tagName) || element.getAttribute('aria-hidden') === 'true') {
        return false;
      }

      const style = getComputedStyle(element);

      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
    }

    return true;
  };
  const getPageText = (): { text: string; truncated: boolean } => {
    const root = document.body ?? document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let length = 0;
    let node = walker.nextNode();

    while (node !== null && length < maxTextLength) {
      checkDeadline();

      const text = normalize(node.textContent ?? '');
      if (text !== '' && isRenderedTextNode(node)) {
        parts.push(text);
        length += text.length + 1;
      }

      node = walker.nextNode();
    }

    const text = normalize(parts.join(' '));

    return { text: truncate(text, maxTextLength), truncated: text.length > maxTextLength };
  };
  const getRole = (element: Element): string => {
    const explicitRole = element.getAttribute('role');
    const tag = element.tagName.toLowerCase();

    if (explicitRole !== null && explicitRole.trim() !== '') {
      return explicitRole;
    }

    if (/^h[1-6]$/u.test(tag)) {
      return 'heading';
    }

    if (tag === 'a') {
      return 'link';
    }

    if (tag === 'button') {
      return 'button';
    }

    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      return 'field';
    }

    return tag;
  };
  const selector = [
    'a',
    'button',
    'input',
    'select',
    'textarea',
    '[aria-label]',
    '[role]',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
  ].join(',');
  const isVisible = (element: Element): boolean => {
    const style = getComputedStyle(element);

    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = element.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0;
  };
  const getPriority = (node: PageSnapshotNode): number => {
    if (node.role === 'button' || node.role === 'field') {
      return 0;
    }

    if (node.role === 'link' || node.role === 'heading') {
      return 1;
    }

    return 2;
  };
  const root = document.body ?? document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: node =>
      node instanceof Element && node.matches(selector)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  const candidates: PageSnapshotNode[] = [];
  let elementNode = walker.nextNode();

  while (elementNode !== null && candidates.length < maxNodeCount * 3) {
    checkDeadline();

    if (elementNode instanceof Element && isVisible(elementNode)) {
      const element = elementNode;
      const tag = element.tagName.toLowerCase();
      const text = truncate(normalize(element.textContent ?? ''), maxNodeTextLength);
      const label = truncate(normalize(getLabelText(element)), maxNodeTextLength);
      const state: Record<string, boolean> = {};

      if (
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        state['disabled'] = element.disabled;
      }

      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
        state['checked'] = element.checked;
      }

      const node: {
        href?: string;
        id: string;
        label?: string;
        role: string;
        state?: Record<string, boolean>;
        tag: string;
        text?: string;
      } = {
        id: `node-${candidates.length + 1}`,
        role: getRole(element),
        tag,
      };

      if (element instanceof HTMLAnchorElement && element.href !== '') {
        node.href = sanitizeUrl(element.href);
      }

      if (label !== '') {
        node.label = label;
      }

      if (Object.keys(state).length > 0) {
        node.state = state;
      }

      if (text !== '') {
        node.text = text;
      }

      candidates.push(node);
    }

    elementNode = walker.nextNode();
  }
  const nodes = candidates
    .toSorted((left, right) => getPriority(left) - getPriority(right))
    .slice(0, maxNodeCount);
  const pageText = getPageText();

  return {
    limits: { maxNodeCount, maxNodeTextLength, maxTextLength },
    nodes,
    nodesTruncated: candidates.length > maxNodeCount || elementNode !== null,
    snapshotId: `snapshot-${Date.now().toString(36)}`,
    text: pageText.text,
    textTruncated: pageText.truncated,
    title: document.title,
    url: sanitizeUrl(location.href),
  };
};
/* eslint-enable unicorn/consistent-function-scoping */

const withTimeout = async <Result>(
  promise: Promise<Result>,
  timeoutMs: number
): Promise<Result> => {
  let timeout: ReturnType<typeof setTimeout> | undefined = undefined;

  try {
    return await Promise.race([
      promise,
      // eslint-disable-next-line promise/avoid-new
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Page evaluation timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

export const evalInTab = async ({
  code,
  debuggerApi,
  tabId,
  timeoutMs = DEFAULT_EVAL_TIMEOUT_MS,
}: {
  readonly code: string;
  readonly debuggerApi: ChromeDebuggerApi;
  readonly tabId: number;
  readonly timeoutMs?: number;
}): Promise<EvalTabResult> => {
  const target = { tabId };
  let attached = false;

  try {
    await debuggerApi.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attached = true;

    const response = await debuggerApi.sendCommand(target, 'Runtime.evaluate', {
      awaitPromise: true,
      expression: getEvalExpression(code),
      returnByValue: true,
      timeout: timeoutMs,
    });

    const parsed = chromeEvalResponseSchema.safeParse(response);

    if (!parsed.success) {
      return { error: 'Debugger returned an invalid eval response.', ok: false };
    }

    const { exceptionDetails, result } = parsed.data;

    if (exceptionDetails !== undefined) {
      return { error: getExceptionMessage(exceptionDetails), ok: false };
    }

    if (result === undefined) {
      return { error: 'Debugger returned an invalid eval result.', ok: false };
    }

    const normalizedResult = Object.hasOwn(result, 'value')
      ? toSerializableEvalResult(result.value)
      : ({ ok: true } satisfies EvalTabResult);

    return normalizedResult.ok && result.description !== undefined
      ? { ...normalizedResult, description: result.description }
      : normalizedResult;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Page evaluation failed.',
      ok: false,
    };
  } finally {
    if (attached) {
      try {
        await debuggerApi.detach(target);
      } catch {
        // Detach can fail if the tab closed or already detached; keep the result.
      }
    }
  }
};

export const evalInTabWithScripting = async ({
  code,
  scriptingApi,
  tabId,
  timeoutMs = DEFAULT_EVAL_TIMEOUT_MS,
}: {
  readonly code: string;
  readonly scriptingApi: BrowserScriptingApi;
  readonly tabId: number;
  readonly timeoutMs?: number;
}): Promise<EvalTabResult> => {
  try {
    /*
     * Soft timeout only. withTimeout rejects this promise, but a runaway model-authored snippet
     * keeps running in the page's MAIN world after we report a timeout — scripting has no
     * cancellation primitive. The Chrome/CDP path passes a real timeout to Runtime.evaluate; this
     * one can't. Revisit if scripting ever gains enforced cancellation.
     */
    const [response] = await withTimeout(
      Promise.resolve(
        scriptingApi.executeScript({
          args: [code],
          func: runInjectedEval,
          target: { tabId },
          world: 'MAIN',
        })
      ),
      timeoutMs
    );

    if (response?.error !== undefined) {
      const detail = extractInjectionErrorText(response.error);

      return {
        error:
          detail === undefined ? 'Page evaluation failed.' : `Page evaluation failed: ${detail}`,
        ok: false,
      };
    }

    return toSerializableEvalResult(response?.result);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Page evaluation failed.',
      ok: false,
    };
  }
};

export const getPageSnapshotInTabWithScripting = async ({
  scriptingApi,
  tabId,
  timeoutMs = DEFAULT_EVAL_TIMEOUT_MS,
}: {
  readonly scriptingApi: BrowserScriptingApi;
  readonly tabId: number;
  readonly timeoutMs?: number;
}): Promise<EvalTabResult> => {
  try {
    const [response] = await withTimeout(
      Promise.resolve(
        scriptingApi.executeScript({
          args: [String(timeoutMs)],
          func: runInjectedPageSnapshot,
          target: { tabId },
          world: 'MAIN',
        })
      ),
      timeoutMs
    );

    if (response?.error !== undefined) {
      const detail = extractInjectionErrorText(response.error);

      return {
        error:
          detail === undefined
            ? 'Failed to read page snapshot.'
            : `Failed to read page snapshot: ${detail}`,
        ok: false,
      };
    }

    return { ok: true, value: response?.result };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to read page snapshot.',
      ok: false,
    };
  }
};

export const isTabDebuggerRequest = (value: unknown): value is TabDebuggerRequest =>
  tabDebuggerRequestSchema.safeParse(value).success;

export const isTabDebuggerResponse = (value: unknown): value is TabDebuggerResponse =>
  tabDebuggerResponseSchema.safeParse(value).success;
