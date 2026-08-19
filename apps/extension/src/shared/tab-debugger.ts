/* eslint-disable max-lines */
import { z } from 'zod';

export const DEBUGGER_PROTOCOL_VERSION = '1.3';
export const LIST_INSPECTABLE_TABS_MESSAGE = 'kilo.tabs.listInspectable';
export const EVAL_TAB_MESSAGE = 'kilo.tabs.eval';
export const PAGE_SNAPSHOT_MESSAGE = 'kilo.tabs.snapshot';
export const VIEWPORT_SCREENSHOT_MESSAGE = 'kilo.tabs.viewportScreenshot';
export const WEB_MCP_DISCOVER_MESSAGE = 'kilo.tabs.webMcpDiscover';
export const WEB_MCP_EXECUTE_MESSAGE = 'kilo.tabs.webMcpExecute';
export const DEFAULT_EVAL_TIMEOUT_MS = 5000;
/**
 * Characters of visible page text one snapshot returns. A/B-measured: a 24k
 * window reads a long article in three calls instead of nine. Fewer
 * round-trips means a weak model gets fewer chances to stop early, and the
 * shorter conversation costs FEWER total bytes than the narrow window it
 * replaced. The injected function cannot close over this constant, so it is
 * passed in as an argument.
 */
export const MAX_SNAPSHOT_TEXT_LENGTH = 24_000;

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
  // Chrome reports the target document and frame of a successful injection.
  readonly documentId?: string;
  readonly frameId?: number;
}

export interface BrowserScriptingApi {
  readonly executeScript: (details: {
    readonly args: string[];
    readonly func: (...args: string[]) => unknown;
    readonly target: { readonly tabId: number; readonly documentIds?: string[] };
    readonly world: 'MAIN';
  }) => Promise<BrowserScriptingInjectionResult[]> | BrowserScriptingInjectionResult[];
}

export interface InspectableTab {
  readonly id: number;
  readonly title: string;
  readonly url: string;
}

export interface PageSnapshotNode {
  /** Absolute action URL of the enclosing form, for form fields. */
  readonly formAction?: string;
  /** Lowercase method of the enclosing form ("get" or "post"), for form fields. */
  readonly formMethod?: string;
  readonly href?: string;
  readonly id: string;
  readonly label?: string;
  /** The name attribute, for form fields — a GET form submits as formAction?name=value. */
  readonly name?: string;
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

export interface PageTextMatch {
  readonly excerpt: string;
  /** Character offset of the match inside the full visible page text. */
  readonly offset: number;
}

export interface PageSnapshot {
  readonly limits: PageSnapshotLimits;
  readonly nodes: PageSnapshotNode[];
  readonly nodesTruncated: boolean;
  readonly snapshotId: string;
  readonly text: string;
  /** Full-text search matches, present when the snapshot ran with a query. */
  readonly textMatches?: PageTextMatch[];
  /** Character offset of `text` inside the full visible page text. */
  readonly textStart: number;
  /** Length of the full visible page text this window was cut from. */
  readonly textTotalChars: number;
  readonly textTruncated: boolean;
  readonly title: string;
  /** Total full-text match count, present when the snapshot ran with a query. */
  readonly totalTextMatches?: number;
  readonly url: string;
}

export interface ViewportScreenshot {
  readonly dataUrl: string;
  readonly devicePixelRatio: number;
  readonly height: number;
  readonly mediaType: 'image/png';
  readonly width: number;
}

export interface WebMcpToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly origin: string;
  readonly inputSchema: unknown;
}

export interface WebMcpDiscoveryResult {
  readonly documentId: string;
  readonly tools: WebMcpToolDescriptor[];
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
      readonly query?: string;
      readonly tabId: number;
      readonly textStart?: number;
      readonly timeoutMs?: number;
      readonly type: typeof PAGE_SNAPSHOT_MESSAGE;
    }
  | {
      readonly tabId: number;
      readonly type: typeof VIEWPORT_SCREENSHOT_MESSAGE;
    }
  | {
      readonly tabId: number;
      readonly type: typeof WEB_MCP_DISCOVER_MESSAGE;
    }
  | {
      readonly arguments: string;
      readonly definitionSignature: string;
      readonly documentId: string;
      readonly tabId: number;
      readonly toolName: string;
      readonly type: typeof WEB_MCP_EXECUTE_MESSAGE;
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
      readonly result: EvalTabResult;
      readonly ok: true;
      readonly type: typeof WEB_MCP_DISCOVER_MESSAGE;
    }
  | {
      readonly result: EvalTabResult;
      readonly ok: true;
      readonly type: typeof WEB_MCP_EXECUTE_MESSAGE;
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
    query: z.string().optional(),
    tabId: z.number(),
    textStart: z.number().optional(),
    timeoutMs: z.number().optional(),
    type: z.literal(PAGE_SNAPSHOT_MESSAGE),
  }),
  z.object({
    tabId: z.number(),
    type: z.literal(VIEWPORT_SCREENSHOT_MESSAGE),
  }),
  z.object({
    tabId: z.number(),
    type: z.literal(WEB_MCP_DISCOVER_MESSAGE),
  }),
  z.object({
    arguments: z.string(),
    definitionSignature: z.string(),
    documentId: z.string(),
    tabId: z.number(),
    toolName: z.string(),
    type: z.literal(WEB_MCP_EXECUTE_MESSAGE),
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
    ok: z.literal(true),
    result: evalTabResultSchema,
    type: z.literal(WEB_MCP_DISCOVER_MESSAGE),
  }),
  z.object({
    ok: z.literal(true),
    result: evalTabResultSchema,
    type: z.literal(WEB_MCP_EXECUTE_MESSAGE),
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

// One global capture lock since captureVisibleTab grabs whichever tab is active in a window, so the activate/capture/restore window must not interleave (screenshots are rare; key per-window only if throughput matters).
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
// eslint-disable-next-line max-params -- the injected function is serialized into the page, so every input must arrive as a positional string argument.
const runInjectedPageSnapshot = (
  timeoutMsText: string,
  maxTextLengthText: string,
  textStartText?: string,
  queryText?: string
): PageSnapshot => {
  const maxTextLength = Number(maxTextLengthText);
  const maxNodeCount = 80;
  const maxNodeTextLength = 500;
  const maxTextMatches = 20;
  const excerptRadius = 120;
  const textStartRaw = Number(textStartText ?? '0');
  const textStart = Number.isFinite(textStartRaw) && textStartRaw > 0 ? textStartRaw : 0;
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
  // One getComputedStyle per element instead of per text node per ancestor: hidden/non-content text (script JSON, inline styles, display:none modals, aria-hidden subtrees) is never surfaced as "visible page text".
  const visibilityByElement = new Map<Element, boolean>();
  const isVisibleElement = (element: Element): boolean => {
    const cached = visibilityByElement.get(element);
    if (cached !== undefined) {
      return cached;
    }
    let visible = true;
    if (nonRenderedTags.has(element.tagName) || element.getAttribute('aria-hidden') === 'true') {
      visible = false;
    } else {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        visible = false;
      } else {
        const parent = element.parentElement;
        visible = parent === null || isVisibleElement(parent);
      }
    }
    visibilityByElement.set(element, visible);
    return visible;
  };
  const isRenderedTextNode = (textNode: Node): boolean =>
    textNode.parentElement === null || isVisibleElement(textNode.parentElement);
  const getPageText = (): {
    fullText: string;
    text: string;
    start: number;
    totalChars: number;
    cutShort: boolean;
  } => {
    // The full visible text is collected so a window can start at any offset and the search sees the whole page. A deadline mid-walk keeps what was collected instead of failing the snapshot.
    const root = document.body ?? document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let node = walker.nextNode();
    let cutShort = false;

    while (node !== null) {
      if (performance.now() > deadline) {
        cutShort = true;
        break;
      }

      const text = normalize(node.textContent ?? '');
      if (text !== '' && isRenderedTextNode(node)) {
        parts.push(text);
      }

      node = walker.nextNode();
    }

    const fullText = normalize(parts.join(' '));
    const start = Math.min(textStart, fullText.length);

    return {
      cutShort,
      fullText,
      start,
      text: fullText.slice(start, start + maxTextLength),
      totalChars: fullText.length,
    };
  };
  const findTextMatches = (
    fullText: string
  ): { matches: { excerpt: string; offset: number }[]; totalMatches: number } => {
    const needle = normalize(queryText ?? '');
    const matches: { excerpt: string; offset: number }[] = [];
    let totalMatches = 0;
    if (needle === '') {
      return { matches, totalMatches };
    }
    // Lowercasing changes the length of some characters (e.g. Turkish İ), shifting every later offset; a case-insensitive regex over the original text keeps offsets true to it.
    const needlePattern = new RegExp(
      needle.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`),
      'giu'
    );
    let match = needlePattern.exec(fullText);
    while (match !== null) {
      totalMatches += 1;
      if (matches.length < maxTextMatches) {
        const start = Math.max(0, match.index - excerptRadius);
        const end = Math.min(fullText.length, match.index + needle.length + excerptRadius);
        matches.push({ excerpt: fullText.slice(start, end), offset: match.index });
      }
      match = needlePattern.exec(fullText);
    }
    return { matches, totalMatches };
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
        formAction?: string;
        formMethod?: string;
        href?: string;
        id: string;
        label?: string;
        name?: string;
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

      // Form fields carry their name and form target so a GET search form can be turned into a URL (formAction?name=value) without submitting it. An unparsable form action is omitted rather than failing the snapshot.
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        if (element.name !== '') {
          node.name = element.name;
        }
        const { form } = element;
        const rawAction = form === null ? null : (form.getAttribute('action') ?? '');
        if (form !== null && rawAction !== null && URL.canParse(rawAction, location.href)) {
          const action = new URL(rawAction, location.href);
          action.hash = '';
          node.formAction = action.toString();
          node.formMethod = form.method === 'post' ? 'post' : 'get';
        }
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
  const search = normalize(queryText ?? '') === '' ? undefined : findTextMatches(pageText.fullText);

  return {
    limits: { maxNodeCount, maxNodeTextLength, maxTextLength },
    nodes,
    nodesTruncated: candidates.length > maxNodeCount || elementNode !== null,
    snapshotId: `snapshot-${Date.now().toString(36)}`,
    text: pageText.text,
    ...(search === undefined
      ? {}
      : { textMatches: search.matches, totalTextMatches: search.totalMatches }),
    textStart: pageText.start,
    textTotalChars: pageText.totalChars,
    textTruncated: pageText.cutShort || pageText.start + pageText.text.length < pageText.totalChars,
    title: document.title,
    url: sanitizeUrl(location.href),
  };
};
/* eslint-enable unicorn/consistent-function-scoping */

/* eslint-disable unicorn/consistent-function-scoping */
// eslint-disable-next-line max-params -- the injected function is serialized into the page, so every input must arrive as a positional string argument.
const runInjectedWebMcpDiscover = async (): Promise<WebMcpToolDescriptor[]> => {
  const { modelContext } = document as Document & {
    modelContext?: {
      getTools?: () => Promise<unknown>;
    };
  };
  const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
  const isToolRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

  if (modelContext === undefined || typeof modelContext.getTools !== 'function') {
    return [];
  }

  const tools = await modelContext.getTools();
  if (!isArray(tools)) {
    return [];
  }

  const descriptors: WebMcpToolDescriptor[] = [];
  for (const tool of tools) {
    const record = isToolRecord(tool) ? tool : {};
    descriptors.push({
      description: typeof record['description'] === 'string' ? record['description'] : '',
      inputSchema: record['inputSchema'],
      name: typeof record['name'] === 'string' ? record['name'] : '',
      origin: typeof record['origin'] === 'string' ? record['origin'] : '',
      title: typeof record['title'] === 'string' ? record['title'] : '',
    });
  }

  return descriptors;
};

const runInjectedWebMcpExecute = async (
  toolNameText: string,
  argumentsText: string,
  definitionSignatureText: string
): Promise<unknown> => {
  const { modelContext } = document as Document & {
    modelContext?: {
      getTools?: () => Promise<unknown>;
      executeTool?: (tool: unknown, argumentsText: string) => Promise<unknown>;
    };
  };
  const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
  const isToolRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

  if (
    modelContext === undefined ||
    typeof modelContext.getTools !== 'function' ||
    typeof modelContext.executeTool !== 'function'
  ) {
    throw new Error('WebMCP is not available in this document.');
  }

  const tools = await modelContext.getTools();
  if (!isArray(tools)) {
    throw new TypeError('WebMCP returned no tools.');
  }

  let tool: unknown = undefined;
  for (const candidate of tools) {
    const record = isToolRecord(candidate) ? candidate : {};
    if (record['name'] === toolNameText) {
      tool = candidate;
      break;
    }
  }

  if (tool === undefined) {
    throw new Error(`WebMCP tool "${toolNameText}" is not available.`);
  }

  // Rebuild the ordered definition signature identically to web-mcp-tools.ts and reject a changed registration as a stale tool.
  const record = isToolRecord(tool) ? tool : {};
  const name = typeof record['name'] === 'string' ? record['name'] : '';
  const title = typeof record['title'] === 'string' ? record['title'] : '';
  const description = typeof record['description'] === 'string' ? record['description'] : '';
  const origin = typeof record['origin'] === 'string' ? record['origin'] : '';
  let schema = record['inputSchema'];
  if (typeof schema === 'string') {
    try {
      schema = JSON.parse(schema) as unknown;
    } catch {
      schema = undefined;
    }
  }
  const normalizedSchema =
    typeof schema === 'object' && schema !== null && !Array.isArray(schema) ? schema : undefined;
  const definitionSignature = JSON.stringify([name, title, description, origin, normalizedSchema]);

  if (definitionSignature !== definitionSignatureText) {
    throw new Error(`WebMCP tool "${toolNameText}" changed; refresh the page tools.`);
  }

  const result = await modelContext.executeTool(tool, argumentsText);

  return result;
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
  query = '',
  scriptingApi,
  tabId,
  textStart = 0,
  timeoutMs = DEFAULT_EVAL_TIMEOUT_MS,
}: {
  readonly query?: string;
  readonly scriptingApi: BrowserScriptingApi;
  readonly tabId: number;
  readonly textStart?: number;
  readonly timeoutMs?: number;
}): Promise<EvalTabResult> => {
  try {
    const [response] = await withTimeout(
      Promise.resolve(
        scriptingApi.executeScript({
          args: [String(timeoutMs), String(MAX_SNAPSHOT_TEXT_LENGTH), String(textStart), query],
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

const isWebMcpToolDescriptorArray = (value: unknown): value is WebMcpToolDescriptor[] =>
  Array.isArray(value);

export const discoverWebMcpToolsInTab = async ({
  scriptingApi,
  tabId,
}: {
  readonly scriptingApi: BrowserScriptingApi;
  readonly tabId: number;
}): Promise<EvalTabResult> => {
  try {
    const [response] = await withTimeout(
      Promise.resolve(
        scriptingApi.executeScript({
          args: [],
          func: runInjectedWebMcpDiscover,
          target: { tabId },
          world: 'MAIN',
        })
      ),
      DEFAULT_EVAL_TIMEOUT_MS
    );

    if (response?.error !== undefined) {
      const detail = extractInjectionErrorText(response.error);

      return {
        error:
          detail === undefined
            ? 'Failed to discover WebMCP tools.'
            : `Failed to discover WebMCP tools: ${detail}`,
        ok: false,
      };
    }

    const documentId = typeof response?.documentId === 'string' ? response.documentId : '';
    const tools = isWebMcpToolDescriptorArray(response?.result) ? response.result : [];

    // The browser must report the target document; without it the tools cannot be bound to a page.
    if (documentId === '') {
      return { ok: true, value: { documentId: '', tools: [] } satisfies WebMcpDiscoveryResult };
    }

    return { ok: true, value: { documentId, tools } satisfies WebMcpDiscoveryResult };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to discover WebMCP tools.',
      ok: false,
    };
  }
};

export const executeWebMcpToolInTab = async ({
  arguments: argumentsText,
  definitionSignature,
  documentId,
  scriptingApi,
  tabId,
  toolName,
}: {
  readonly arguments: string;
  readonly definitionSignature: string;
  readonly documentId: string;
  readonly scriptingApi: BrowserScriptingApi;
  readonly tabId: number;
  readonly toolName: string;
}): Promise<EvalTabResult> => {
  try {
    const [response] = await withTimeout(
      Promise.resolve(
        scriptingApi.executeScript({
          args: [toolName, argumentsText, definitionSignature],
          func: runInjectedWebMcpExecute,
          target: { documentIds: [documentId], tabId },
          world: 'MAIN',
        })
      ),
      DEFAULT_EVAL_TIMEOUT_MS
    );

    if (response?.error !== undefined) {
      const detail = extractInjectionErrorText(response.error);

      return {
        error:
          detail === undefined
            ? 'WebMCP tool execution failed.'
            : `WebMCP tool execution failed: ${detail}`,
        ok: false,
      };
    }

    return { ok: true, value: response?.result };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'WebMCP tool execution failed.',
      ok: false,
    };
  }
};

export const isTabDebuggerRequest = (value: unknown): value is TabDebuggerRequest =>
  tabDebuggerRequestSchema.safeParse(value).success;

export const isTabDebuggerResponse = (value: unknown): value is TabDebuggerResponse =>
  tabDebuggerResponseSchema.safeParse(value).success;
