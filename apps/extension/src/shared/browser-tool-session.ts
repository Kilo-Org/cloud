/* eslint-disable max-lines */
import { z } from 'zod';
import { buildWorkflowPageCode } from './agent-workflow-runner';
import { TAB_TAKEN_ERROR } from './browser-caller';
import { KILO_BROWSER_TOOL_PREFIX, toKiloBrowserToolName } from './browser-tool-contract';
import {
  redactSensitiveBody,
  redactSensitiveHeaders,
  renderResponseBody,
} from './browser-tool-redaction';
import {
  DEBUGGER_PROTOCOL_VERSION,
  discoverWebMcpToolsInTab,
  evalInTabWithScripting,
  evaluateTabCode,
  executeWebMcpToolInTab,
  getInspectableTab,
  getViewportScreenshotWithTabsApi,
} from './tab-debugger';
import { buildWebMcpDefinitionSignature } from './web-mcp-tools';
import type {
  BrowserScriptingApi,
  BrowserTabInfo,
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerDetachListener,
  ChromeDebuggerEventListener,
  ChromeDebuggerTarget,
  EvalTabResult,
  WebMcpToolDescriptor,
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
 * Why the debugger-only tools cannot run where `chrome.debugger` is missing.
 * Firefox exposes no CDP, so console, network, dialog, file-chooser and
 * model-authored Playwright-code tools have no scripting equivalent.
 */
export const FIREFOX_PLATFORM_LIMIT = 'this browser exposes no debugger protocol';

const FIREFOX_UNSUPPORTED_BROWSER_TOOL_BASE_NAMES = [
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_handle_dialog',
  'browser_file_upload',
  'browser_run_code_unsafe',
] as const;

/** The model-facing names of the tools Firefox cannot express through the scripting API. */
export const FIREFOX_UNSUPPORTED_BROWSER_TOOLS: readonly string[] =
  FIREFOX_UNSUPPORTED_BROWSER_TOOL_BASE_NAMES.map(baseName => toKiloBrowserToolName(baseName));

/**
 * The tool error the scripting backend returns for a tool the platform cannot
 * express, or `undefined` when the tool has a scripting implementation.
 * Accepts the model-facing `kilo_browser_*` name or the upstream `browser_*`
 * one, so both the executor and the wiring layer can call it.
 */
export const getFirefoxUnsupportedToolError = (tool: string): string | undefined => {
  const name = tool.startsWith(KILO_BROWSER_TOOL_PREFIX) ? tool : toKiloBrowserToolName(tool);

  return FIREFOX_UNSUPPORTED_BROWSER_TOOLS.some(candidate => candidate === name)
    ? `${name} is not available in Firefox: ${FIREFOX_PLATFORM_LIMIT}.`
    : undefined;
};

/** Longest wait_for/text poll the scripting backend runs before it reports a timeout. */
export const MAX_BROWSER_TOOL_WAIT_MS = 15_000;
/** Soft timeout for one scripting tool action; larger than the debugger's default for snapshot-sized results. */
const SCRIPTING_ACTION_TIMEOUT_MS = 20_000;
/** Lines of aria-snapshot context `find` reports around each match. */
const FIND_CONTEXT_LINES = 3;

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

/**
 * A hidden tab queues `Input.*` commands until it is shown, then fires them
 * late; the call that already returned success acted on the wrong page state.
 * Bound each input command instead of retrying blind.
 * Evidence: https://github.com/BrowserMCP/mcp/blob/main/packages/mcp/spikes/hidden-tabs/RESULTS.md
 */
const INPUT_COMMAND_TIMEOUT_MS = 5000;
/**
 * Bound on the frame a background tab's screencast is asked for. Chrome makes
 * that frame on the request in about 11 ms (measured on the click-then-
 * screenshot cycle); past this bound the plain capture takes over, so a
 * screenshot is never slower or absent because of the shortcut.
 */
const SCREENCAST_FRAME_TIMEOUT_MS = 250;
const SCREENCAST_FRAME_EVENT = 'Page.screencastFrame';
const FOCUS_EMULATION_METHOD = 'Emulation.setFocusEmulationEnabled';
const visibilityStateSchema = z.object({
  result: z.object({ value: z.string().optional() }).optional(),
});
const layoutViewportSchema = z.object({
  layoutViewport: z.object({ clientHeight: z.number(), clientWidth: z.number() }).optional(),
});
const screencastFrameSchema = z.object({
  data: z.string(),
  sessionId: z.number(),
});

/**
 * How many base64 characters of a frame are decoded to read its pixel size:
 * a PNG header sits in the first 24 bytes, and a JPEG's frame header follows
 * its application segments, which fit well inside this prefix.
 */
const IMAGE_HEADER_BASE64_CHARS = 8192;
/** The PNG signature: 137 80 78 71 13 10 26 10 opens every PNG. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
/** `SOF0`..`SOF15` as decimal bytes, minus 196, 200 and 204, which carry something other than a frame. */
const JPEG_FRAME_MARKERS = new Set([
  192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
]);

/** The bytes of a base64 prefix, or `undefined` when it is not base64 at all. */
const decodeBase64 = (text: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(text), character => character.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
};

/**
 * The pixel size of a base64 png or jpeg, decoded from its own header.
 *
 * The screencast's `deviceWidth`/`deviceHeight` are in device-independent
 * pixels while `Page.captureScreenshot` answers in device pixels — measured at
 * 1280x720 against 2560x1440 on a DPR-2 Chromium — so the metadata cannot say
 * whether the frame is the image the mask geometry was computed for. The
 * encoded image can, whatever the ratio. `undefined` when the header cannot be
 * read, which falls back to the plain capture rather than risk a mis-scaled one.
 */
const imagePixelSize = (
  base64: string,
  format: 'jpeg' | 'png'
): { readonly height: number; readonly width: number } | undefined => {
  const prefix = base64.slice(0, IMAGE_HEADER_BASE64_CHARS - (IMAGE_HEADER_BASE64_CHARS % 4));
  const bytes = decodeBase64(prefix);

  if (bytes === undefined) {
    return undefined;
  }

  if (format === 'png') {
    const isPng = bytes.length >= 24 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

    if (!isPng) {
      return undefined;
    }

    // IHDR follows the 8-byte signature, a 4-byte length and the 4-byte type: width then height,
    // Each a 4-byte big-endian integer, so 256 ^ 3 down to 256 ^ 0 are the byte positions.
    const at = (offset: number): number => bytes[offset] ?? 0;
    const width = ((at(16) * 256 + at(17)) * 256 + at(18)) * 256 + at(19);
    const height = ((at(20) * 256 + at(21)) * 256 + at(22)) * 256 + at(23);

    return { height, width };
  }

  // 255 216 is the JPEG start-of-image marker: anything else is not a jpeg at all.
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) {
    return undefined;
  }

  // Walk the segment chain to the frame header: `FF <marker> <2-byte length>`.
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 255) {
      return undefined;
    }

    const marker = bytes[offset + 1] ?? 0;

    if (JPEG_FRAME_MARKERS.has(marker)) {
      // Height and width follow the 8-bit precision and the segment length.
      return {
        height: (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0),
        width: (bytes[offset + 7] ?? 0) * 256 + (bytes[offset + 8] ?? 0),
      };
    }

    const length = (bytes[offset + 2] ?? 0) * 256 + (bytes[offset + 3] ?? 0);

    if (length < 2) {
      return undefined;
    }

    offset += 2 + length;
  }

  return undefined;
};

export interface BrowserConsoleMessage {
  /** The frame that produced it, when the debugger reported one. */
  readonly frameId?: string;
  readonly level: string;
  readonly text: string;
  readonly timestamp?: number;
  readonly url?: string;
}

export interface BrowserNetworkRequest {
  readonly failure?: string;
  readonly finishedAt?: number;
  /**
   * The frame that issued the request (CDP `Network.requestWillBeSent.frameId`).
   * A `Document` request whose frame is the main frame marks a page load.
   */
  readonly frameId?: string;
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

/**
 * One download the tab started (`Browser.downloadWillBegin`). The agent's
 * check module cancels a download that began without a step token, so the
 * buffer keeps only what a caller needs to name it.
 */
export interface BrowserToolDownload {
  readonly guid?: string;
  readonly startedAt?: number;
  readonly suggestedFilename?: string;
  readonly url?: string;
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
    }
  | {
      /** The selector parses, but matches several elements: a target must be unique. */
      readonly kind: 'ambiguous';
      readonly matches: number;
      readonly selector: string;
    };

/** A target that can be acted on: an ambiguous selector has no element to act on. */
export type BrowserToolUniqueTarget = Exclude<
  BrowserToolResolvedTarget,
  { readonly kind: 'ambiguous' }
>;

export type BrowserToolBackend = 'debugger' | 'scripting';

/**
 * One browser tool call's outcome. The scripting backend returns errors as
 * values so a tool the platform cannot express surfaces as a tool error
 * instead of an exception.
 */
export type BrowserToolCallResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly error: string; readonly ok: false };

/**
 * Tab operations the scripting backend needs beyond the session's
 * debugger-era tabs surface. Optional, so the wiring slice can keep passing a
 * plain `BrowserTabsApi`; the tools that need a missing member report the
 * missing browser API instead of failing silently.
 */
export interface BrowserToolTabsApi {
  readonly create?:
    | ((properties: {
        readonly active?: boolean;
        readonly url?: string;
        readonly windowId?: number;
      }) => Promise<BrowserTabInfo> | BrowserTabInfo)
    | undefined;
  readonly remove?: ((tabId: number) => Promise<void> | void) | undefined;
}

/**
 * Identity of one tab's viewport state. The tab session and every caller view
 * share the same object, so a viewport override a resize applied from one
 * caller belongs to the tab and is cleared once when the tab's session is
 * disposed.
 */
export interface BrowserToolViewportState {
  readonly tabId: number;
}

/**
 * A live call's cancellation state: the side panel took the tab over, so the
 * call still unwinding must stop issuing commands instead of interleaving them
 * with the panel's. Read before every command the caller view sends.
 */
export interface BrowserToolCallGuard {
  readonly cancelled: () => boolean;
}

/**
 * One out-of-process iframe auto-attached under the tab's debugger. Chrome
 * leaves these out of `Page.getFrameTree`, so `Target.attachedToTarget` is the
 * only place the tab learns the frame exists, its URL (hence its origin), and
 * the flattened child session that can read it.
 */
export interface BrowserToolChildFrame {
  /** The frame's URL, as the target reported it when it attached. */
  readonly url: string;
  /** The flattened child session; commands addressed to it read the frame's own document. */
  readonly sessionId: string;
}

export interface BrowserToolSession {
  /**
   * Attaches the debugger and enables the CDP domains, once. Idempotent, and
   * called by `send`/`resolveTarget`; call it before reading
   * `consoleMessages()`/`networkRequests()` so those buffers start filling on
   * the first tool call rather than at background startup. On the scripting
   * backend it validates that the tab is inspectable instead.
   */
  readonly attach: () => Promise<void>;
  /**
   * A caller-scoped view of this tab session. It shares the tab's one
   * attachment, console/network buffers and dialogs, but its ref registry is
   * private: a full snapshot from one caller never invalidates another
   * caller's refs. A `guard` ends this view's commands as soon as it reports
   * cancelled.
   */
  readonly bindCaller: (callerKey: string, guard?: BrowserToolCallGuard) => BrowserToolSession;
  /**
   * Out-of-process iframes attached under this tab, keyed by their frame id
   * (for an OOPIF the frame id is the target id). Auto-attach populates it;
   * on a platform without `chrome.debugger` there are none, so it is absent.
   * A caller that cannot see a frame here must treat it as unreadable.
   */
  readonly childFrames?: () => ReadonlyMap<string, BrowserToolChildFrame>;
  /**
   * Which platform the session drives. `scripting` means `chrome.debugger` is
   * unavailable (Firefox) and the page is driven through
   * `browser.scripting.executeScript` in the MAIN world.
   */
  readonly backend: BrowserToolBackend;
  /**
   * One base64 image of the tab's viewport, of the page as it is now, taken
   * without activating the tab. Chrome renders an inactive tab about one frame
   * per second, so `Page.captureScreenshot` of a page that just changed waits
   * for that frame (~1 s on the measured click-then-screenshot cycle); a
   * screencast frame is made on request (~11 ms), and the focus emulation the
   * session holds from attach is what makes the renderer paint the change.
   *
   * `undefined` when no frame arrives in time, its size is not the layout
   * viewport (the mask geometry is laid over this image, so it must be the size
   * a plain capture of the viewport is), or the platform has no screencast. The
   * caller then captures the ordinary way: a screenshot never fails because of
   * this.
   *
   * `guard` is checked before every command the capture sends, so a call the
   * panel took over mid-capture stops at once; its own screencast is stopped
   * once, and nothing else. A `webp` request takes no frame: `Page.startScreencast`
   * has no webp format, and the plain capture keeps the media type truthful.
   */
  readonly captureViewportImage: (
    format: 'jpeg' | 'png' | 'webp',
    guard?: BrowserToolCallGuard
  ) => Promise<string | undefined>;
  /**
   * Runs one upstream browser tool. On the scripting backend this is the only
   * way to reach the page: snapshot, find, screenshot, wait_for, evaluate,
   * click, type, hover, drag, drop, fill_form, select_option, press_key,
   * navigate, navigate_back, close, tabs, resize, webmcp_list and webmcp_call
   * work with the upstream arguments, and the tools the scripting API cannot
   * express return a tool error naming the tool and the platform limit. Never
   * throws and never returns a silent no-op.
   */
  readonly callTool: (
    tool: string,
    args?: Record<string, unknown>
  ) => Promise<BrowserToolCallResult>;
  readonly consoleMessages: () => BrowserConsoleMessage[];
  /**
   * Idempotent. Clears state, unsubscribes, and detaches the debugger; an
   * attach already in flight is awaited and its debugger released.
   */
  readonly dispose: () => Promise<void>;
  /**
   * Runs model-authored code (the workflow `page` scripts) in this tab through
   * the same attachment the tool calls use. Never attaches or detaches a second
   * debugger: the session owns the tab's one attachment.
   */
  readonly evaluateInTab: (code: string, timeoutMs?: number) => Promise<EvalTabResult>;
  /**
   * The tool error for a tool this platform cannot run, or `undefined` when it
   * can. The wiring layer consults it before dispatching a tool, so the
   * debugger-only tools fail by name on Firefox instead of returning an empty
   * result.
   */
  readonly getToolUnavailableError: (tool: string) => string | undefined;
  /** Every download the session has seen, oldest first. */
  readonly downloads: () => readonly BrowserToolDownload[];
  readonly isAttached: () => boolean;
  /** Every request the session has seen, including earlier documents. */
  readonly networkRequests: () => BrowserNetworkRequest[];
  /**
   * Requests since the current page load: from the last main-frame `Document`
   * request onward. A subframe navigation's `Document` request never moves the
   * boundary. A session attached mid-load has no observed main-frame document
   * request, so it returns the whole buffer (everything since attach is the
   * current load).
   */
  readonly networkRequestsSinceLoad: () => BrowserNetworkRequest[];
  /** Replaces this caller's registry, so a ref from an older snapshot cannot resolve. */
  readonly registerRefs: (
    entries: readonly BrowserToolRefEntry[],
    options?: { readonly merge?: boolean }
  ) => void;
  /**
   * Drops a caller's ref registry for good: the caller itself is gone (its
   * conversation was deleted, its workflow run or agent session finished). The
   * attachment and other callers keep working. Releasing a lease at turn end
   * does not call this, so a caller's refs outlive its turn like Playwright's
   * page handles; only a navigation, a tab dispose or this call clears them.
   */
  readonly disposeCaller: (callerKey: string) => void;
  readonly resolveTarget: (target: string) => Promise<BrowserToolResolvedTarget | undefined>;
  /**
   * One CDP command on the tab's session. `sessionId` addresses a flattened
   * child session (an out-of-process iframe) instead, so a caller holding one
   * reads that frame's own document.
   */
  readonly send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ) => Promise<Record<string, unknown> | undefined>;
  /** Returns the pending dialog and clears it, so a second call cannot re-answer it. */
  readonly takeDialog: () => BrowserToolDialog | undefined;
  /** Returns the downloads seen since the last call and clears them. */
  readonly takeDownloads: () => readonly BrowserToolDownload[];
  /**
   * Calls `listener` for every download the tab announces as it arrives, and
   * returns the function that stops it. A guard that keeps listening for a late
   * download needs the announcement itself: the browser names a download a
   * moment before the item exists, and a call that arrives in between must not
   * have to wait for it.
   */
  readonly watchDownloads: (listener: (download: BrowserToolDownload) => void) => () => void;
  /** The tab's viewport identity, shared with every caller view of this tab. */
  readonly viewportState: BrowserToolViewportState;
}

const jsonRecordSchema = z.record(z.string(), z.unknown());
const headerValueSchema = z.string();
// The contract types a checkbox/radio value as the string "true"/"false", so both spellings map to a boolean before the page script decides to click.
const booleanValueSchema = z
  .union([z.boolean(), z.enum(['false', 'true'])])
  .transform(value => value === true || value === 'true');
const primitiveValueSchema = z.union([z.boolean(), z.null(), z.number(), z.string()]);
const remoteObjectSchema = z.object({
  description: z.string().optional(),
  type: z.string().optional(),
  value: z.unknown().optional(),
});
const consoleApiCalledParamsSchema = z.object({
  args: z.array(z.unknown()).optional(),
  executionContextId: z.number().optional(),
  timestamp: z.number().optional(),
  type: z.string().optional(),
});
const executionContextCreatedParamsSchema = z.object({
  context: z.object({
    auxData: z.object({ frameId: z.string().optional() }).optional(),
    id: z.number(),
  }),
});
const executionContextDestroyedParamsSchema = z.object({
  executionContextId: z.number(),
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
  frameId: z.string().optional(),
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
    id: z.string().optional(),
    parentId: z.string().optional(),
    url: z.string().optional(),
  }),
});
const attachedToTargetParamsSchema = z.object({
  sessionId: z.string(),
  targetInfo: z.object({
    targetId: z.string(),
    type: z.string().optional(),
    url: z.string().optional(),
  }),
});
const detachedFromTargetParamsSchema = z.object({
  sessionId: z.string(),
  targetId: z.string().optional(),
});
const domGetDocumentResponseSchema = z.object({
  root: z.object({ nodeId: z.number() }).optional(),
});
const domQuerySelectorAllResponseSchema = z.object({ nodeIds: z.array(z.number()) });
const injectedNumberSchema = z.number();

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

// Firefox scripting backend
//
// Firefox exposes no `chrome.debugger`, so the debugger-backed session cannot exist there.
// The scripting session keeps the same tool surface and drives the page with the
// MAIN-world scripting call through `evalInTabWithScripting`.
// It reuses the page-helper layer in `agent-workflow-runner.ts` for text-based targeting.
// This is the same hard platform split the eval path in `tab-debugger.ts` already makes.

const scriptJson = (value: unknown): string => JSON.stringify(value) ?? 'null';

/**
 * In-page helpers every scripting action shares. Plain ES5-compatible code:
 * it is embedded into the injected script text, so it cannot reference module
 * scope and must not use template literals or optional chaining (the injected
 * string is compiled in the page).
 */
const SCRIPTING_PAGE_PREAMBLE = `
const __visible = (el) => {
  if (el.getAttribute('aria-hidden') === 'true') { return false; }
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
};
const __selectorFor = (el) => {
  const parts = [];
  let node = el;
  while (node !== null && node.nodeType === 1 && node.parentElement !== null) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    const position = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + position + ')' : tag);
    node = parent;
  }
  return parts.join(' > ');
};
const __element = (selector) => {
  const el = document.querySelector(selector);
  if (el === null) { throw new Error('No element matches selector: ' + selector); }
  return el;
};
const __role = (el) => {
  const explicit = el.getAttribute('role');
  if (explicit !== null && explicit !== '') { return explicit; }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') { return 'checkbox'; }
    if (type === 'radio') { return 'radio'; }
    if (type === 'button' || type === 'submit' || type === 'reset') { return 'button'; }
    if (type === 'search') { return 'searchbox'; }
    if (type === 'range') { return 'slider'; }
    return 'textbox';
  }
  const roles = {
    a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading', img: 'img', li: 'listitem',
    ol: 'list', option: 'option', p: 'paragraph', select: 'combobox',
    table: 'table', td: 'cell', textarea: 'textbox', th: 'columnheader',
    tr: 'row', ul: 'list',
  };
  return roles[tag] || '';
};
const __accessibleName = (el) => {
  const labelled = el.getAttribute('aria-label');
  if (labelled !== null && labelled.trim() !== '') { return labelled.trim(); }
  const alt = el.getAttribute('alt');
  if (alt !== null && alt.trim() !== '') { return alt.trim(); }
  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null && placeholder.trim() !== '') { return placeholder.trim(); }
  const text = (el.textContent || '').replace(/\\s+/gu, ' ').trim();
  return text.length > 200 ? text.slice(0, 200) : text;
};
const __ariaAttributes = (el) => {
  const parts = [];
  const tag = el.tagName.toLowerCase();
  const level = el.getAttribute('aria-level');
  if (level !== null && level !== '') { parts.push('[level=' + level + ']'); }
  else if (/^h[1-6]$/u.test(tag)) { parts.push('[level=' + tag.charAt(1) + ']'); }
  if (el.getAttribute('aria-disabled') === 'true' || el.disabled === true) { parts.push('[disabled]'); }
  if (el.checked === true) { parts.push('[checked]'); }
  if (el.getAttribute('aria-expanded') === 'true') { parts.push('[expanded]'); }
  if (el.getAttribute('aria-pressed') === 'true') { parts.push('[pressed]'); }
  if (el.getAttribute('aria-selected') === 'true') { parts.push('[selected]'); }
  if (document.activeElement === el) { parts.push('[active]'); }
  return parts;
};
const __buildAria = (root, maxDepth, withBoxes, refStart) => {
  const interactiveRoles = [
    'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'option',
    'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
    'treeitem',
  ];
  const lines = [];
  const refs = [];
  let nextRef = refStart;
  const walk = (el, depth) => {
    if (maxDepth !== null && depth > maxDepth) { return; }
    if (!__visible(el)) { return; }
    const role = __role(el);
    const name = __accessibleName(el);
    const children = Array.from(el.children);
    let refPart = '';
    if (interactiveRoles.indexOf(role) !== -1) {
      nextRef += 1;
      refPart = 'e' + nextRef;
      refs.push({ ref: refPart, selector: __selectorFor(el) });
    }
    const attributes = __ariaAttributes(el).join('');
    let box = '';
    if (withBoxes) {
      const rect = el.getBoundingClientRect();
      box = '[box=' + Math.round(rect.left) + ',' + Math.round(rect.top) + ',' + Math.round(rect.width) + ',' + Math.round(rect.height) + ']';
    }
    const quoted = name === '' ? '' : ' "' + name.split('"').join('') + '"';
    if (role !== '' && (name !== '' || interactiveRoles.indexOf(role) !== -1)) {
      lines.push('  '.repeat(depth) + '- ' + role + quoted + refPart + attributes + box);
    } else if (role === '' && name !== '' && children.length === 0) {
      lines.push('  '.repeat(depth) + '- text: ' + name);
    }
    for (const child of children) { walk(child, depth + 1); }
  };
  walk(root, 0);
  return { lines: lines, nextRef: nextRef, refs: refs };
};
const __modifiers = (modifiers) => {
  const isMac = /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent || '');
  const controlOrMeta = modifiers.indexOf('ControlOrMeta') !== -1;
  return {
    altKey: modifiers.indexOf('Alt') !== -1,
    ctrlKey: modifiers.indexOf('Control') !== -1 || (controlOrMeta && !isMac),
    metaKey: modifiers.indexOf('Meta') !== -1 || (controlOrMeta && isMac),
    shiftKey: modifiers.indexOf('Shift') !== -1,
  };
};
const __mouse = (el, type, options) => {
  const rect = el.getBoundingClientRect();
  const init = Object.assign({
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    view: window,
  }, options);
  if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
    el.dispatchEvent(new PointerEvent(type, Object.assign({ isPrimary: true, pointerId: 1, pointerType: 'mouse' }, init)));
    return;
  }
  el.dispatchEvent(new MouseEvent(type, init));
};
const __selectOption = (el, value) => {
  const wanted = String(value).trim().toLowerCase();
  const options = Array.from(el.options || []);
  const exactValue = options.filter((candidate) => String(candidate.value).trim().toLowerCase() === wanted)[0];
  const byText = options.filter((candidate) => String(candidate.textContent || '').trim().toLowerCase() === wanted)[0];
  const option = exactValue || byText;
  if (option === undefined || option === null) {
    const labels = options.slice(0, 20).map((candidate) => String(candidate.textContent || '').trim()).filter(Boolean);
    throw new Error('No option matches "' + value + '". Options: ' + labels.join(', ').slice(0, 300));
  }
  option.selected = true;
  if (el.multiple !== true) { el.value = option.value; }
  return option.value === '' ? String(option.textContent || '') : option.value;
};
const __sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Same semantics as the runner's fillElement: native value setter plus input/change events, so framework listeners observe the write.
const __fillElement = (el, value) => {
  if (el instanceof HTMLSelectElement) {
    const options = Array.from(el.options);
    const wanted = String(value).trim().toLowerCase();
    const option = options.filter((candidate) => String(candidate.value).trim().toLowerCase() === wanted || String(candidate.textContent || '').trim().toLowerCase() === wanted)[0];
    if (option === undefined) {
      const labels = options.slice(0, 20).map((candidate) => String(candidate.textContent || '').trim()).filter(Boolean);
      throw new Error('No option matches "' + value + '". Options: ' + labels.join(', ').slice(0, 300));
    }
    el.value = option.value;
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor !== undefined && descriptor.set !== undefined) { descriptor.set.call(el, value); }
    else { el.value = value; }
  } else if (el.isContentEditable === true) {
    el.textContent = value;
  } else {
    throw new Error('The matched element is not a fillable input. Target the inner input element, or use a click on it first.');
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const __finish = (value) => ({ done: true, result: value });
`;

const buildSnapshotPageScript = ({
  boxes,
  depth,
  refStart,
  targetSelector,
}: {
  readonly boxes: boolean;
  readonly depth: number | undefined;
  readonly refStart: number;
  readonly targetSelector: string | undefined;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const rootSelector = ${scriptJson(targetSelector ?? null)};
const maxDepth = ${scriptJson(depth ?? null)};
const withBoxes = ${scriptJson(boxes)};
const refStart = ${scriptJson(refStart)};
const root = rootSelector === null ? (document.body || document.documentElement) : __element(rootSelector);
const aria = __buildAria(root, maxDepth, withBoxes, refStart);
return __finish({
  lines: aria.lines,
  nextRef: aria.nextRef,
  refs: aria.refs,
  title: document.title,
  url: location.href,
});`;

const buildFindPageScript = ({
  boxes,
  depth,
  needle,
  refStart,
  regex,
  targetSelector,
}: {
  readonly boxes: boolean;
  readonly depth: number | undefined;
  readonly needle: string | undefined;
  readonly refStart: number;
  readonly regex: string | undefined;
  readonly targetSelector: string | undefined;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const rootSelector = ${scriptJson(targetSelector ?? null)};
const maxDepth = ${scriptJson(depth ?? null)};
const withBoxes = ${scriptJson(boxes)};
const refStart = ${scriptJson(refStart)};
const needle = ${scriptJson(needle ?? null)};
const regexSource = ${scriptJson(regex ?? null)};
const pattern = regexSource === null ? null : new RegExp(regexSource, 'iu');
const matcher = (line) => pattern === null ? line.toLowerCase().indexOf(String(needle).toLowerCase()) !== -1 : pattern.test(line);
const root = rootSelector === null ? (document.body || document.documentElement) : __element(rootSelector);
const aria = __buildAria(root, maxDepth, withBoxes, refStart);
const blocks = [];
let total = 0;
for (let index = 0; index < aria.lines.length; index += 1) {
  if (!matcher(aria.lines[index])) { continue; }
  total += 1;
  const from = Math.max(0, index - ${String(FIND_CONTEXT_LINES)});
  const to = Math.min(aria.lines.length, index + ${String(FIND_CONTEXT_LINES + 1)});
  blocks.push(aria.lines.slice(from, to).join('\\n'));
}
return __finish({ blocks: blocks, refs: aria.refs, nextRef: aria.nextRef, total: total });`;

const buildWaitForPageScript = ({
  text,
  textGone,
  waitMs,
}: {
  readonly text: string | undefined;
  readonly textGone: string | undefined;
  readonly waitMs: number;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const needle = ${scriptJson(text ?? null)};
const gone = ${scriptJson(textGone ?? null)};
const waitMs = ${scriptJson(waitMs)};
const startedAt = Date.now();
if (needle !== null) {
  while (!page.hasText(needle)) {
    if (Date.now() - startedAt >= waitMs) {
      throw new Error('Timed out waiting for text: ' + needle + ' after ' + Math.round(waitMs / 1000) + ' seconds.');
    }
    await __sleep(200);
  }
  return __finish('Text appeared: ' + needle + '.');
}
if (gone !== null) {
  while (page.hasText(gone)) {
    if (Date.now() - startedAt >= waitMs) {
      throw new Error('Timed out waiting for text to disappear: ' + gone + ' after ' + Math.round(waitMs / 1000) + ' seconds.');
    }
    await __sleep(200);
  }
  return __finish('Text disappeared: ' + gone + '.');
}
await __sleep(waitMs);
return __finish('Waited ' + Math.round(waitMs / 1000) + ' second(s).');`;

const buildEvaluatePageScript = ({
  functionText,
  selector,
}: {
  readonly functionText: string;
  readonly selector: string | undefined;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const source = ${scriptJson(functionText)};
const selector = ${scriptJson(selector ?? null)};
const fn = new Function('return (' + source + ')')();
if (typeof fn !== 'function') {
  throw new Error('The function argument must be a function: () => { ... } or (element) => { ... }.');
}
const element = selector === null ? undefined : __element(selector);
const output = await fn(element);
let stringified;
try { stringified = JSON.stringify(output); } catch (error) {
  throw new Error('The evaluated result was not JSON-serializable.');
}
if (stringified === undefined) { return __finish(null); }
return __finish(JSON.parse(stringified));`;

const buildClickPageScript = ({
  button,
  doubleClick,
  description,
  modifiers,
  selector,
}: {
  readonly button: string;
  readonly doubleClick: boolean;
  readonly description: string;
  readonly modifiers: readonly string[];
  readonly selector: string;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const selector = ${scriptJson(selector)};
const el = __element(selector);
el.scrollIntoView({ block: 'center', inline: 'center' });
const button = ${scriptJson(button)};
const buttonIndex = button === 'middle' ? 1 : (button === 'right' ? 2 : 0);
const flags = __modifiers(${scriptJson(modifiers)});
const pressed = buttonIndex === 0 ? 1 : (buttonIndex === 1 ? 4 : 2);
const base = Object.assign({ button: buttonIndex }, flags);
__mouse(el, 'pointerdown', Object.assign({}, base, { buttons: pressed }));
__mouse(el, 'mousedown', Object.assign({}, base, { buttons: pressed }));
__mouse(el, 'pointerup', Object.assign({}, base, { buttons: 0 }));
__mouse(el, 'mouseup', Object.assign({}, base, { buttons: 0 }));
__mouse(el, 'click', Object.assign({}, base, { buttons: 0, detail: 1 }));
if (${scriptJson(doubleClick)}) {
  __mouse(el, 'pointerdown', Object.assign({}, base, { buttons: pressed }));
  __mouse(el, 'mousedown', Object.assign({}, base, { buttons: pressed, detail: 2 }));
  __mouse(el, 'pointerup', Object.assign({}, base, { buttons: 0 }));
  __mouse(el, 'mouseup', Object.assign({}, base, { buttons: 0, detail: 2 }));
  __mouse(el, 'click', Object.assign({}, base, { buttons: 0, detail: 2 }));
  __mouse(el, 'dblclick', Object.assign({}, base, { buttons: 0, detail: 2 }));
}
return __finish('Clicked ' + ${scriptJson(description)} + ' with the ' + ${scriptJson(button)} + ' button.');`;

const buildTypePageScript = ({
  selector,
  slowly,
  submit,
  text,
}: {
  readonly selector: string;
  readonly slowly: boolean;
  readonly submit: boolean;
  readonly text: string;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const selector = ${scriptJson(selector)};
const text = ${scriptJson(text)};
const el = __element(selector);
el.scrollIntoView({ block: 'center' });
if (typeof el.focus === 'function') { el.focus(); }
const editable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable === true;
if (!editable) { throw new Error('The matched element is not a fillable input: ' + selector); }
if (${scriptJson(slowly)}) {
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (el.isContentEditable === true) { el.textContent = (el.textContent || '') + character; }
    else { __fillElement(el, (el.value || '') + character); }
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: character }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: character }));
    await __sleep(20);
  }
} else {
  __fillElement(el, text);
}
let submitted = false;
if (${scriptJson(submit)}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  if (!(el instanceof HTMLTextAreaElement) && el.form !== null && el.form !== undefined) {
    try { el.form.requestSubmit(); submitted = true; } catch (error) { el.form.submit(); submitted = true; }
  }
}
return __finish('Typed into ' + selector + (submitted ? ' and pressed Enter.' : '.'));`;

const buildHoverPageScript = ({ selector }: { readonly selector: string }): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const el = __element(${scriptJson(selector)});
el.scrollIntoView({ block: 'center', inline: 'center' });
const flags = __modifiers([]);
__mouse(el, 'mouseover', flags);
__mouse(el, 'mouseenter', flags);
__mouse(el, 'mousemove', flags);
return __finish('Hovered over ' + ${scriptJson(selector)} + '.');`;

const buildDragPageScript = ({
  endSelector,
  startSelector,
}: {
  readonly endSelector: string;
  readonly startSelector: string;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const start = __element(${scriptJson(startSelector)});
const end = __element(${scriptJson(endSelector)});
start.scrollIntoView({ block: 'center', inline: 'center' });
const startRect = start.getBoundingClientRect();
const endRect = end.getBoundingClientRect();
const from = { clientX: startRect.left + startRect.width / 2, clientY: startRect.top + startRect.height / 2 };
const to = { clientX: endRect.left + endRect.width / 2, clientY: endRect.top + endRect.height / 2 };
const base = Object.assign({ bubbles: true, cancelable: true }, __modifiers([]));
__mouse(start, 'mousemove', Object.assign({}, base, from, { buttons: 0 }));
__mouse(start, 'mousedown', Object.assign({}, base, from, { button: 0, buttons: 1 }));
for (let step = 1; step <= 10; step += 1) {
  const clientX = from.clientX + ((to.clientX - from.clientX) * step) / 10;
  const clientY = from.clientY + ((to.clientY - from.clientY) * step) / 10;
  __mouse(end, 'mousemove', Object.assign({}, base, { clientX: clientX, clientY: clientY, buttons: 1 }));
}
__mouse(end, 'mouseup', Object.assign({}, base, to, { button: 0, buttons: 0 }));
return __finish('Dragged ' + ${scriptJson(startSelector)} + ' onto ' + ${scriptJson(endSelector)} + '.');`;

const buildDropPageScript = ({
  data,
  paths,
  selector,
}: {
  readonly data: Readonly<Record<string, string>>;
  readonly paths: readonly string[];
  readonly selector: string;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const el = __element(${scriptJson(selector)});
const data = ${scriptJson(data)};
const paths = ${scriptJson(paths)};
const dataEntries = Object.entries(data);
if (dataEntries.length === 0 && paths.length === 0) {
  throw new Error('At least one of "paths" or "data" must be provided.');
}
if (dataEntries.length === 0) {
  throw new Error('Browser drop with paths is not available in Firefox: the page cannot read local files. Pass data instead.');
}
el.scrollIntoView({ block: 'center', inline: 'center' });
const rect = el.getBoundingClientRect();
const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
const transfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
if (transfer !== null) {
  for (const entry of dataEntries) { transfer.setData(entry[0], entry[1]); }
}
if (transfer !== null && typeof DragEvent === 'function') {
  el.dispatchEvent(new DragEvent('dragenter', Object.assign({ dataTransfer: transfer }, options)));
  el.dispatchEvent(new DragEvent('dragover', Object.assign({ dataTransfer: transfer }, options)));
  el.dispatchEvent(new DragEvent('drop', Object.assign({ dataTransfer: transfer }, options)));
} else {
  __mouse(el, 'dragenter', options);
  __mouse(el, 'dragover', options);
  __mouse(el, 'drop', options);
}
return __finish('Dropped ' + dataEntries.length + ' data item(s) onto ' + ${scriptJson(selector)} + '.');`;

const buildFillFormPageScript = ({
  fields,
}: {
  readonly fields: readonly {
    readonly name: string;
    readonly selector: string;
    readonly type: string;
    readonly value: string | boolean;
  }[];
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const fields = ${scriptJson(fields)};
const outcomes = [];
for (const field of fields) {
  const el = document.querySelector(field.selector);
  if (el === null) {
    outcomes.push(field.name + ': no element matches ' + field.selector);
    continue;
  }
  try {
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (Boolean(el.checked) !== Boolean(field.value)) { el.click(); }
      outcomes.push(field.name + ': ' + (el.checked ? 'checked' : 'unchecked'));
    } else if (field.type === 'combobox') {
      outcomes.push(field.name + ': selected ' + __selectOption(el, field.value));
    } else {
      __fillElement(el, String(field.value));
      outcomes.push(field.name + ': filled');
    }
  } catch (error) {
    outcomes.push(field.name + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}
return __finish('Filled ' + fields.length + ' field(s).\\n' + outcomes.join('\\n'));`;

const buildSelectOptionPageScript = ({
  selector,
  values,
}: {
  readonly selector: string;
  readonly values: readonly string[];
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const el = __element(${scriptJson(selector)});
const values = ${scriptJson(values)};
if (!(el instanceof HTMLSelectElement)) { throw new Error('The matched element is not a select: ' + ${scriptJson(selector)}); }
const chosen = [];
for (const value of values) { chosen.push(__selectOption(el, value)); }
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return __finish('Selected ' + chosen.join(', ') + '.');`;

const buildPressKeyPageScript = ({ key }: { readonly key: string }): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const key = ${scriptJson(key)};
const parts = key.split('+');
const main = parts[parts.length - 1];
const flags = __modifiers(parts.slice(0, -1));
const known = /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|F[1-9]|F1[0-2])$/u;
if (!known.test(main) && main.length !== 1) { throw new Error('Unknown key: ' + main); }
const active = document.activeElement || document.body;
if (active === null) { throw new Error('No element can receive the key.'); }
const keyValue = main === 'Space' ? ' ' : main;
active.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true, key: keyValue }, flags)));
active.dispatchEvent(new KeyboardEvent('keyup', Object.assign({ bubbles: true, key: keyValue }, flags)));
return __finish('Pressed ' + key + '.');`;

const buildNavigatePageScript = ({ url }: { readonly url: string }): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
let resolved;
try { resolved = new URL(${scriptJson(url)}, location.href); } catch (error) { throw new Error('Invalid URL: ' + ${scriptJson(url)}); }
if (resolved.protocol === 'javascript:' || resolved.protocol === 'data:') {
  throw new Error('Refusing to navigate to a ' + resolved.protocol + ' URL.');
}
setTimeout(() => { location.assign(resolved.toString()); }, 0);
return __finish('Navigating to ' + resolved.toString() + '.');`;

const buildNavigateBackPageScript = (): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
setTimeout(() => { history.back(); }, 0);
return __finish('Went back one history entry.');`;

const buildResizePageScript = ({
  height,
  width,
}: {
  readonly height: number;
  readonly width: number;
}): string =>
  `${SCRIPTING_PAGE_PREAMBLE}
const width = ${scriptJson(width)};
const height = ${scriptJson(height)};
if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
  throw new Error('Resize needs positive, finite width and height.');
}
window.resizeTo(width, height);
return __finish('Resized the window to ' + width + 'x' + height + '.');`;

const scriptingEnvelopeSchema = z.object({
  dryRunActions: z.array(z.unknown()).optional(),
  error: z.string().optional(),
  ok: z.boolean(),
  value: z.unknown().optional(),
});

type ScriptingEnvelope = z.infer<typeof scriptingEnvelopeSchema>;

/**
 * The page scripts are run through `buildWorkflowPageCode`, so the script's
 * return value is the workflow `{ done: true, result }` shape. The tool
 * handlers want the payload itself; unwrap it here in one place instead of in
 * every builder.
 */
const scriptingWorkflowResultSchema = z.object({
  done: z.literal(true),
  result: z.unknown(),
});

const viewportScreenshotSchema = z.object({
  dataUrl: z.string(),
  devicePixelRatio: z.number(),
  height: z.number(),
  mediaType: z.string(),
  width: z.number(),
});

/** Runs one generated page script through the scripting API and unwraps the workflow-style envelope. */
const runScriptingPageScript = async ({
  script,
  scriptingApi,
  tabId,
  timeoutMs = SCRIPTING_ACTION_TIMEOUT_MS,
}: {
  readonly script: string;
  readonly scriptingApi: BrowserScriptingApi | undefined;
  readonly tabId: number;
  readonly timeoutMs?: number;
}): Promise<BrowserToolCallResult> => {
  if (scriptingApi === undefined) {
    return { error: 'Page scripting is unavailable in this browser.', ok: false };
  }

  const code = buildWorkflowPageCode(script, {}, false);
  const result = await evalInTabWithScripting({ code, scriptingApi, tabId, timeoutMs });

  if (!result.ok) {
    return { error: result.error, ok: false };
  }

  const parsed = scriptingEnvelopeSchema.safeParse(result.value);

  if (!parsed.success) {
    return { error: 'The page action returned an invalid result.', ok: false };
  }

  const envelope: ScriptingEnvelope = parsed.data;

  if (!envelope.ok) {
    return { error: envelope.error ?? 'The page action failed.', ok: false };
  }

  const workflowResult = scriptingWorkflowResultSchema.safeParse(envelope.value);

  return { ok: true, value: workflowResult.success ? workflowResult.data.result : envelope.value };
};

const resolveScriptingTarget = (
  refs: ReadonlyMap<string, BrowserToolRefEntry>,
  target: string
):
  | { readonly kind: 'ok'; readonly description: string; readonly selector: string }
  | { readonly error: string; readonly kind: 'error' } => {
  const ref = parseRef(target);

  if (ref === undefined) {
    return { description: target, kind: 'ok', selector: target };
  }

  const entry = refs.get(ref);

  if (entry?.selector === undefined) {
    return {
      error: `Unknown element reference ${ref}. Take a fresh kilo_browser_snapshot and use a ref from it.`,
      kind: 'error',
    };
  }

  return { description: `ref=${ref}`, kind: 'ok', selector: entry.selector };
};

const browserToolTargetArgsSchema = z.object({ target: z.string().min(1) });
const browserToolSnapshotArgsSchema = z.object({
  boxes: z.boolean().optional(),
  depth: z.number().int().nonnegative().optional(),
  filename: z.string().optional(),
  target: z.string().optional(),
});
const browserToolFindArgsSchema = z.object({
  depth: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
  target: z.string().optional(),
  text: z.string().optional(),
});
const browserToolWaitForArgsSchema = z.object({
  text: z.string().optional(),
  textGone: z.string().optional(),
  time: z.number().nonnegative().optional(),
});
const browserToolEvaluateArgsSchema = z.object({
  element: z.string().optional(),
  filename: z.string().optional(),
  function: z.string().min(1),
  target: z.string().optional(),
});
const browserToolClickArgsSchema = z.object({
  button: z.enum(['left', 'middle', 'right']).optional(),
  doubleClick: z.boolean().optional(),
  element: z.string().optional(),
  modifiers: z.array(z.string()).optional(),
  target: z.string().min(1),
});
const browserToolTypeArgsSchema = z.object({
  element: z.string().optional(),
  slowly: z.boolean().optional(),
  submit: z.boolean().optional(),
  target: z.string().min(1),
  text: z.string(),
});
const browserToolDragArgsSchema = z.object({
  endElement: z.string().optional(),
  endTarget: z.string().min(1),
  startElement: z.string().optional(),
  startTarget: z.string().min(1),
});
const browserToolDropArgsSchema = z.object({
  data: z.record(z.string(), z.string()).optional(),
  paths: z.array(z.string()).optional(),
  target: z.string().min(1),
});
const browserToolFillFormArgsSchema = z.object({
  fields: z.array(
    z.object({
      name: z.string(),
      target: z.string().min(1),
      type: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    })
  ),
});
const browserToolSelectOptionArgsSchema = z.object({
  target: z.string().min(1),
  values: z.array(z.string()).min(1),
});
const browserToolPressKeyArgsSchema = z.object({ key: z.string().min(1) });
const browserToolNavigateArgsSchema = z.object({ url: z.string().min(1) });
const browserToolResizeArgsSchema = z.object({ height: z.number(), width: z.number() });
const browserToolTabsArgsSchema = z.object({
  action: z.enum(['close', 'list', 'new', 'select']),
  index: z.number().int().nonnegative().optional(),
  url: z.string().optional(),
});
const browserToolWebMcpCallArgsSchema = z.object({
  name: z.string().min(1),
  params: z.union([z.record(z.string(), z.unknown()), z.undefined()]).optional(),
});
const browserToolConsoleMessagesArgsSchema = z.object({
  all: z.boolean().optional(),
  level: z.enum(['debug', 'error', 'info', 'warning']).optional(),
});
const browserToolHandleDialogArgsSchema = z.object({
  accept: z.boolean(),
  promptText: z.string().optional(),
});
const browserToolNetworkRequestArgsSchema = z.object({
  number: z.number().int().positive().optional(),
  part: z.enum(['body', 'request', 'response']).optional(),
  requestId: z.string().optional(),
});
const browserToolScreenshotArgsSchema = z.object({
  filename: z.string().optional(),
  fullPage: z.boolean().optional(),
  target: z.string().optional(),
  type: z.enum(['jpeg', 'png', 'webp']).optional(),
});
const browserToolSnapshotResultSchema = z.object({
  lines: z.array(z.string()),
  nextRef: z.number(),
  refs: z.array(z.object({ ref: z.string(), selector: z.string() })),
});
const browserToolFindResultSchema = z.object({
  blocks: z.array(z.string()),
  nextRef: z.number(),
  refs: z.array(z.object({ ref: z.string(), selector: z.string() })),
  total: z.number(),
});
const browserToolTabSchema = z.object({
  active: z.boolean().optional(),
  id: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  windowId: z.number().optional(),
});

type BrowserToolTab = z.infer<typeof browserToolTabSchema>;
const browserToolTabListSchema = z.array(browserToolTabSchema);
const browserToolWebMcpDiscoverySchema = z.object({
  documentId: z.string(),
  tools: z.array(
    z.object({
      description: z.string(),
      inputSchema: z.unknown(),
      name: z.string(),
      origin: z.string(),
      title: z.string(),
    })
  ),
});
const networkBodySchema = z.object({
  base64Encoded: z.boolean().optional(),
  body: z.string(),
});

const downloadWillBeginSchema = z.object({
  guid: z.string().optional(),
  suggestedFilename: z.string().optional(),
  url: z.string().optional(),
});

/**
 * CDP methods that back a tool Firefox cannot express, so a handler that still
 * calls the debugger path fails by the tool's name instead of a bare method.
 */
const SCRIPTING_UNSUPPORTED_METHOD_TOOLS = new Map<string, string>([
  ['DOM.setFileInputFiles', 'browser_file_upload'],
  ['Network.enable', 'browser_network_requests'],
  ['Network.getResponseBody', 'browser_network_request'],
  ['Page.handleJavaScriptDialog', 'browser_handle_dialog'],
  ['Page.setInterceptFileChooserEnabled', 'browser_file_upload'],
]);

/** Console severity, so a requested level includes every more severe one. */
const CONSOLE_LEVEL_SEVERITY = new Map<string, number>([
  ['debug', 0],
  ['error', 3],
  ['info', 1],
  ['log', 1],
  ['warning', 2],
]);

const formatConsoleMessages = (
  messages: readonly BrowserConsoleMessage[],
  level: 'debug' | 'error' | 'info' | 'warning'
): string => {
  const minimum = CONSOLE_LEVEL_SEVERITY.get(level) ?? 0;
  const lines = messages
    .filter(message => (CONSOLE_LEVEL_SEVERITY.get(message.level) ?? 1) >= minimum)
    .map(message => `[${message.level}] ${message.text}`);

  return lines.length === 0 ? 'No console messages.' : lines.join('\n');
};

const formatNetworkRequests = (requests: readonly BrowserNetworkRequest[]): string => {
  if (requests.length === 0) {
    return 'No network requests.';
  }

  return requests
    .map((request, index) => {
      const status = request.status === undefined ? '' : ` ${String(request.status)}`;

      return `${String(index + 1)}. ${request.method ?? 'GET'} ${request.url}${status}`;
    })
    .join('\n');
};

const formatNetworkRequestDetail = (request: BrowserNetworkRequest): string => {
  const lines: string[] = [`${request.method ?? 'GET'} ${request.url}`];

  if (request.status !== undefined) {
    lines.push(`status: ${String(request.status)} ${request.statusText ?? ''}`.trim());
  }
  if (request.failure !== undefined) {
    lines.push(`failure: ${request.failure}`);
  }
  if (request.mimeType !== undefined) {
    lines.push(`mimeType: ${request.mimeType}`);
  }
  if (request.requestHeaders !== undefined) {
    lines.push(
      `request headers: ${JSON.stringify(redactSensitiveHeaders(request.requestHeaders))}`
    );
  }
  if (request.responseHeaders !== undefined) {
    lines.push(
      `response headers: ${JSON.stringify(redactSensitiveHeaders(request.responseHeaders))}`
    );
  }
  if (request.postData !== undefined) {
    lines.push(`request body: ${redactSensitiveBody(request.postData) ?? request.postData}`);
  }

  return lines.join('\n');
};

const formatTabList = (tabs: readonly BrowserToolTab[], selectedTabId: number): string =>
  tabs
    .map((tab, index) => {
      const marker = tab.id === selectedTabId ? ' [selected]' : '';

      return `${String(index)}: ${tab.title ?? ''} - ${tab.url ?? ''}${marker}`;
    })
    .join('\n');

interface MutableNetworkRequest {
  failure?: string;
  finishedAt?: number;
  frameId?: string;
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
  ownedTab,
  scriptingApi,
  tabId,
  tabsApi,
}: {
  /**
   * `chrome.debugger` when the browser has it (Chrome). Absent on Firefox,
   * which selects the scripting backend.
   */
  readonly debuggerApi?: ChromeDebuggerApi | undefined;
  /**
   * Whether the runtime still vouches for this tab as one it opened: such a
   * tab starts at `about:blank`, whose url the browser withholds without the
   * `tabs` permission, so the precheck cannot judge it and the attach reports
   * an unreachable page instead. A function, because the voucher ends with the
   * tab's first document.
   */
  readonly ownedTab?: (() => boolean) | undefined;
  /** `chrome.scripting`/`browser.scripting`; the scripting backend's way to reach the page. */
  readonly scriptingApi?: BrowserScriptingApi | undefined;
  readonly tabId: number;
  readonly tabsApi: BrowserTabsApi & BrowserToolTabsApi;
}): BrowserToolSession => {
  /**
   * Hard platform split, the same one the eval path in `tab-debugger.ts`
   * makes: without `chrome.debugger` there is no CDP, so every page effect
   * runs through `browser.scripting.executeScript` in the MAIN world.
   */
  const backend: BrowserToolBackend = debuggerApi === undefined ? 'scripting' : 'debugger';
  const target: ChromeDebuggerTarget = { tabId };
  const viewportState: BrowserToolViewportState = { tabId };
  const consoleBuffer: BrowserConsoleMessage[] = [];
  const downloadBuffer: BrowserToolDownload[] = [];
  // Listeners a still-armed guard registered for the announcement itself, not the buffer it drains.
  const downloadListeners = new Set<(download: BrowserToolDownload) => void>();
  const networkById = new Map<string, MutableNetworkRequest>();
  // Refs belong to a caller, not a tab: two side-panel conversations (or a workflow and a panel) must not invalidate each other's snapshots.
  const refsByCaller = new Map<string, Map<string, BrowserToolRefEntry>>();
  const defaultRefs = new Map<string, BrowserToolRefEntry>();
  let attached = false;
  let disposed = false;
  let focusEmulated = false;
  // The capture waiting on a screencast frame, so an event that arrives between commands is delivered.
  // Keyed by its own attempt: a capture that has given up may not answer, clear or stop a newer capture's frame.
  let pendingScreencastFrame:
    | {
        readonly attempt: number;
        readonly resolve: (params: Record<string, unknown> | undefined) => void;
      }
    | undefined = undefined;
  // The capture whose screencast is running: only it may stop the screencast.
  let screencastOwner: number | undefined = undefined;
  let screencastAttempt = 0;
  let attachPromise: Promise<void> | undefined = undefined;
  // Bumped by every Debugger.detach for this tab, so an attach in flight can tell that the debugger it just acquired is gone.
  let detachCount = 0;
  let documentNodeId: number | undefined = undefined;
  let dialog: BrowserToolDialog | undefined = undefined;
  // Monotonic ref numbering for scripting snapshots, so refs stay e1, e2, ... rather than restarting per snapshot.
  let scriptingRefCount = 0;
  // Console messages pushed since the last main-frame navigation, for `all: false`.
  let consoleMessagesSinceNavigation = 0;
  // `Runtime.executionContextId` → frame id, so a console entry can be attributed to its frame.
  const frameIdByExecutionContext = new Map<number, string>();
  // Out-of-process iframes auto-attached under this tab, keyed by frame id (for an OOPIF the frame id is the target id). `Page.getFrameTree` omits them, so this map is the tab's only record of them.
  const childFrames = new Map<string, BrowserToolChildFrame>();
  // The tab's main frame id, learned from `Page.frameNavigated`. A `Document` request in this frame is a page load.
  let mainFrameId: string | undefined = undefined;
  let webMcpDiscovery: { documentId: string; tools: readonly WebMcpToolDescriptor[] } | undefined =
    undefined;

  const callerRefs = (callerKey: string): Map<string, BrowserToolRefEntry> => {
    const existing = refsByCaller.get(callerKey);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, BrowserToolRefEntry>();
    refsByCaller.set(callerKey, created);
    return created;
  };

  const clearRefs = (): void => {
    defaultRefs.clear();
    // A caller view holds its own map by reference, so clear each one before dropping it: a view bound before the navigation must not keep resolving a ref of the old document.
    for (const refs of refsByCaller.values()) {
      refs.clear();
    }
    refsByCaller.clear();
  };

  const clearState = (): void => {
    consoleBuffer.length = 0;
    consoleMessagesSinceNavigation = 0;
    networkById.clear();
    mainFrameId = undefined;
    childFrames.clear();
    clearRefs();
    documentNodeId = undefined;
    dialog = undefined;
    webMcpDiscovery = undefined;
  };

  // A navigation replaces the document, so the cached root node id and the snapshot refs of the previous document are stale for every caller; drop them instead of querying the old document.
  const invalidateDocument = (): void => {
    documentNodeId = undefined;
    consoleMessagesSinceNavigation = 0;
    clearRefs();
  };

  const pushConsoleMessage = (message: BrowserConsoleMessage): void => {
    consoleBuffer.push(message);
    consoleMessagesSinceNavigation += 1;

    while (consoleBuffer.length > MAX_BROWSER_TOOL_CONSOLE_MESSAGES) {
      consoleBuffer.shift();
    }
  };

  const handleConsoleApiCalled = (params: Record<string, unknown> | undefined): void => {
    const parsed = consoleApiCalledParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const { args, executionContextId, timestamp, type } = parsed.data;
    const frameId =
      executionContextId === undefined
        ? undefined
        : frameIdByExecutionContext.get(executionContextId);

    pushConsoleMessage({
      ...(frameId === undefined ? {} : { frameId }),
      level: type ?? 'log',
      text: truncateText((args ?? []).map(argument => remoteObjectText(argument)).join(' ')),
      ...(timestamp === undefined ? {} : { timestamp }),
    });
  };

  const handleExecutionContextCreated = (params: Record<string, unknown> | undefined): void => {
    const parsed = executionContextCreatedParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    const frameId = parsed.data.context.auxData?.frameId;

    if (frameId !== undefined) {
      frameIdByExecutionContext.set(parsed.data.context.id, frameId);
    }
  };

  const handleExecutionContextDestroyed = (params: Record<string, unknown> | undefined): void => {
    const parsed = executionContextDestroyedParamsSchema.safeParse(params);

    if (parsed.success) {
      frameIdByExecutionContext.delete(parsed.data.executionContextId);
    }
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

    const { frameId, request, requestId, timestamp, type } = parsed.data;
    const entry = getOrCreateNetworkRequest(requestId, request.url ?? '');

    if (request.url !== undefined) {
      entry.url = request.url;
    }
    if (frameId !== undefined) {
      entry.frameId = frameId;
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

  /**
   * The last main-frame `Document` request starts the current page load. A
   * subframe's `Document` request (`frameId` differs from the main frame) never
   * moves the boundary, so a page with iframes keeps its main document and its
   * numbering. Before the first observed main-frame navigation the whole buffer
   * is the current load (the session attached mid-load).
   */
  const networkRequestsSinceLoad = (): BrowserNetworkRequest[] => {
    const requests = [...networkById.values()];

    if (mainFrameId === undefined) {
      return requests;
    }

    let startIndex = 0;

    for (const [index, request] of requests.entries()) {
      if (request.resourceType === 'Document' && request.frameId === mainFrameId) {
        startIndex = index;
      }
    }

    return requests.slice(startIndex);
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

  // Only a main-frame navigation replaces the document; a subframe navigation leaves the main document's node ids valid and its network boundary untouched.
  const handleFrameNavigated = (params: Record<string, unknown> | undefined): void => {
    const parsed = frameNavigatedParamsSchema.safeParse(params);

    if (!parsed.success || parsed.data.frame.parentId !== undefined) {
      return;
    }

    if (parsed.data.frame.id !== undefined) {
      mainFrameId = parsed.data.frame.id;
    }

    invalidateDocument();
  };

  // Flattened auto-attach reports every related target: the OOPIFs are the ones typed `iframe`. Their target id is their frame id.
  const handleAttachedToTarget = (params: Record<string, unknown> | undefined): void => {
    const parsed = attachedToTargetParamsSchema.safeParse(params);

    if (!parsed.success || parsed.data.targetInfo.type !== 'iframe') {
      return;
    }

    childFrames.set(parsed.data.targetInfo.targetId, {
      sessionId: parsed.data.sessionId,
      url: parsed.data.targetInfo.url ?? '',
    });
  };

  const handleDetachedFromTarget = (params: Record<string, unknown> | undefined): void => {
    const parsed = detachedFromTargetParamsSchema.safeParse(params);

    if (!parsed.success) {
      return;
    }

    if (parsed.data.targetId !== undefined) {
      childFrames.delete(parsed.data.targetId);
      return;
    }

    // An older protocol reports only the session; drop the frame that held it.
    for (const [frameId, frame] of childFrames) {
      if (frame.sessionId === parsed.data.sessionId) {
        childFrames.delete(frameId);
        return;
      }
    }
  };

  const handleEvent: ChromeDebuggerEventListener = (source, method, params) => {
    if (disposed || (source.tabId !== undefined && source.tabId !== tabId)) {
      return;
    }

    if (method === SCREENCAST_FRAME_EVENT) {
      // The frame a capture is waiting for; one nobody waits for any more is dropped.
      pendingScreencastFrame?.resolve(params);
      return;
    }

    if (method === 'Runtime.consoleAPICalled') {
      handleConsoleApiCalled(params);
      return;
    }

    if (method === 'Runtime.executionContextCreated') {
      handleExecutionContextCreated(params);
      return;
    }

    if (method === 'Runtime.executionContextDestroyed') {
      handleExecutionContextDestroyed(params);
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

    if (method === 'Browser.downloadWillBegin' || method === 'Page.downloadWillBegin') {
      handleDownloadWillBegin(params);
      return;
    }

    if (method === 'Page.frameNavigated') {
      handleFrameNavigated(params);
      return;
    }

    if (method === 'Target.attachedToTarget') {
      handleAttachedToTarget(params);
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      handleDetachedFromTarget(params);
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
    focusEmulated = false;
    clearState();

    if (reason === DETACH_REASON_TARGET_CLOSED) {
      void dispose();
    }
  };

  const unsubscribe = (): void => {
    debuggerApi?.onDetach.removeListener(handleDetach);
    debuggerApi?.onEvent.removeListener(handleEvent);
    tabsApi.onRemoved?.removeListener(handleTabRemoved);
  };

  const detachQuietly = async (): Promise<void> => {
    if (debuggerApi === undefined) {
      return;
    }

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
    // A tab this runtime opened for a session starts blank, and a blank url is unreadable without the `tabs` permission.
    // Its caller vouches for it until its first document commits, so the attach reports what it cannot reach.
    const resolution =
      ownedTab?.() === true
        ? ({ ok: true, tab: undefined } as const)
        : await getInspectableTab({ tabId, tabsApi });

    if (!resolution.ok) {
      throw new Error(resolution.error);
    }

    if (debuggerApi === undefined) {
      // Scripting backend: there is no protocol to attach. An inspectable tab is the whole handshake; refs and the console buffer were already cleared by dispose/navigation.
      if (disposed) {
        throw new Error(BROWSER_TOOL_SESSION_DISPOSED_ERROR);
      }

      attached = true;

      return;
    }

    // Counted before the attach request so a detach that lands while the domains are being enabled is not overwritten by `attached = true` below.
    const detachCountBeforeAttach = detachCount;

    await debuggerApi.attach(target, DEBUGGER_PROTOCOL_VERSION);

    try {
      for (const method of ENABLED_CDP_DOMAINS) {
        // eslint-disable-next-line no-await-in-loop -- domains must be enabled in order before any tool call reads their events
        await debuggerApi.sendCommand(target, method);
      }
      // A background tab reports no focus to the page; emulation keeps the page acting as if the user is looking at it.
      await debuggerApi.sendCommand(target, FOCUS_EMULATION_METHOD, { enabled: true });
      focusEmulated = true;
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

  const applyFocusEmulation = async (): Promise<void> => {
    if (debuggerApi === undefined) {
      return;
    }

    await debuggerApi.sendCommand(target, FOCUS_EMULATION_METHOD, { enabled: true });
    focusEmulated = true;
  };

  const readVisibilityState = async (): Promise<string | undefined> => {
    if (debuggerApi === undefined) {
      return undefined;
    }

    const response = await debuggerApi.sendCommand(target, 'Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true,
    });
    const parsed = visibilityStateSchema.safeParse(response);

    return parsed.success ? parsed.data.result?.value : undefined;
  };

  const stopScreencast = async (): Promise<void> => {
    try {
      await debuggerApi?.sendCommand(target, 'Page.stopScreencast');
    } catch {
      // A tab that is already gone has nothing left to stop.
    }
  };

  /** A cancelled call sends nothing more: the panel owns the tab from the moment it took over. */
  const assertCallLive = (guard: BrowserToolCallGuard | undefined): void => {
    if (guard?.cancelled() === true) {
      throw new Error(TAB_TAKEN_ERROR);
    }
  };

  /**
   * The screencast's next frame, asked for on this call: `Page.startScreencast`
   * makes the compositor produce one and the event brings it back. The waiter
   * is registered before the command goes out, so the answer cannot be missed,
   * and a frame that answers a capture nobody waits for any more is dropped.
   *
   * Each capture owns one attempt: its `finally` clears the waiter only if that
   * waiter is still its own, and stops the screencast only if it started it, so
   * two captures overlapping on one tab cannot answer or stop each other's.
   *
   * `undefined` when no frame arrives inside the bound — the caller falls back.
   */
  const readScreencastFrame = async (
    format: 'jpeg' | 'png',
    guard: BrowserToolCallGuard | undefined
  ): Promise<z.infer<typeof screencastFrameSchema> | undefined> => {
    if (debuggerApi === undefined) {
      return undefined;
    }

    const attempt = screencastAttempt + 1;
    screencastAttempt = attempt;

    const { promise, resolve } = Promise.withResolvers<Record<string, unknown> | undefined>();
    const timer = setTimeout(() => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- an expired bound answers with no frame
      resolve(undefined);
    }, SCREENCAST_FRAME_TIMEOUT_MS);

    pendingScreencastFrame = { attempt, resolve };
    let started = false;

    try {
      assertCallLive(guard);
      await debuggerApi.sendCommand(target, 'Page.startScreencast', {
        everyNthFrame: 1,
        format,
      });
      started = true;
      screencastOwner = attempt;

      const parsed = screencastFrameSchema.safeParse(await promise);

      if (!parsed.success) {
        return undefined;
      }

      // A taken-over capture stops at once instead of acking a frame the panel's own capture now owns.
      assertCallLive(guard);
      await debuggerApi.sendCommand(target, 'Page.screencastFrameAck', {
        sessionId: parsed.data.sessionId,
      });

      return parsed.data;
    } catch {
      // A screencast this browser refuses leaves the ordinary capture in place.
      return undefined;
    } finally {
      clearTimeout(timer);

      if (pendingScreencastFrame?.attempt === attempt) {
        pendingScreencastFrame = undefined;
      }

      if (started && screencastOwner === attempt) {
        // Its own screencast only: a newer capture's frame must not be stopped by the one it replaced.
        screencastOwner = undefined;
        await stopScreencast();
      }
    }
  };

  const captureViewportImage = async (
    format: 'jpeg' | 'png' | 'webp',
    guard?: BrowserToolCallGuard
  ): Promise<string | undefined> => {
    // `Page.startScreencast` has no webp: the plain capture keeps the requested type truthful.
    if (debuggerApi === undefined || format === 'webp') {
      return undefined;
    }

    assertCallLive(guard);
    await attach();

    try {
      assertCallLive(guard);
      const metrics = layoutViewportSchema.safeParse(
        await debuggerApi.sendCommand(target, 'Page.getLayoutMetrics')
      );
      const layout = metrics.data?.layoutViewport;

      if (!metrics.success || layout === undefined) {
        return undefined;
      }

      // An inactive tab reports no damage to the compositor, so its first screencast frame would be
      // The stale frame the plain capture waits a second for; focus emulation makes the change paint.
      if (!focusEmulated) {
        assertCallLive(guard);
        await applyFocusEmulation();
      }

      assertCallLive(guard);
      const frame = await readScreencastFrame(format, guard);

      if (frame === undefined) {
        return undefined;
      }

      const size = imagePixelSize(frame.data, format);

      // The mask geometry is laid over this image: it must be the pixel size a plain capture of this viewport is.
      // The screencast's own metadata is in device-independent pixels, so the encoded frame is what decides.
      return size !== undefined &&
        size.width === layout.clientWidth &&
        size.height === layout.clientHeight
        ? frame.data
        : undefined;
    } catch {
      // A taken-over call sends nothing more, and a tab that cannot be measured is captured the ordinary way.
      return undefined;
    }
  };

  /**
   * Input goes through one guard: re-apply focus emulation when the tab is
   * hidden, then bound the command. A timeout fails the call with the observed
   * visibility and never retries — the queued command may still fire later.
   */
  const sendInputCommand = async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> => {
    if (debuggerApi === undefined) {
      return undefined;
    }

    if (!focusEmulated) {
      await applyFocusEmulation();
    }

    const visibility = await readVisibilityState();

    if (visibility === 'hidden') {
      await applyFocusEmulation();
    }

    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${method} timed out after ${String(INPUT_COMMAND_TIMEOUT_MS)} ms with document.visibilityState = "${visibility ?? 'unknown'}". The tab may be in the background; bring it to the foreground before retrying.`
        )
      );
    }, INPUT_COMMAND_TIMEOUT_MS);

    try {
      return await Promise.race([debuggerApi.sendCommand(target, method, params), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  const send = async (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown> | undefined> => {
    if (debuggerApi === undefined) {
      // Never a silent answer: without CDP the caller must use `callTool`, and a method that backs a tool Firefox cannot express fails by that tool's name.
      const tool = SCRIPTING_UNSUPPORTED_METHOD_TOOLS.get(method);

      throw new Error(
        tool === undefined
          ? `${method} is not available in Firefox: ${FIREFOX_PLATFORM_LIMIT}. Use session.callTool for the browser tools.`
          : getFirefoxUnsupportedToolError(tool)
      );
    }

    await attach();

    if (method.startsWith('Input.')) {
      return sendInputCommand(method, params);
    }

    // A child session runs in its own process, so the tab's input timing rules do not apply to it.
    return sessionId === undefined
      ? debuggerApi.sendCommand(target, method, params)
      : debuggerApi.sendCommand({ ...target, sessionId }, method, params);
  };

  const getDocumentNodeId = async (): Promise<number | undefined> => {
    if (documentNodeId !== undefined) {
      return documentNodeId;
    }

    if (debuggerApi === undefined) {
      return undefined;
    }

    const response = await debuggerApi.sendCommand(target, 'DOM.getDocument', { depth: 0 });
    const parsed = domGetDocumentResponseSchema.safeParse(response);

    if (!parsed.success || parsed.data.root === undefined) {
      return undefined;
    }

    documentNodeId = parsed.data.root.nodeId;

    return documentNodeId;
  };

  /**
   * How many elements a selector matches on the scripting backend, where there is
   * no DOM node id. Runs through the shared injection helper, so it has the same
   * timeout as the other action injections and surfaces its real error.
   */
  const countScriptingSelectorMatches = async (
    selector: string
  ): Promise<
    | { readonly kind: 'count'; readonly matches: number }
    | { readonly kind: 'error'; readonly error: string }
  > => {
    if (scriptingApi === undefined) {
      return { error: 'Page scripting is unavailable in this browser.', kind: 'error' };
    }

    const result = await evalInTabWithScripting({
      code: `return document.querySelectorAll(${JSON.stringify(selector)}).length;`,
      scriptingApi,
      tabId,
      timeoutMs: SCRIPTING_ACTION_TIMEOUT_MS,
    });

    if (!result.ok) {
      return { error: result.error, kind: 'error' };
    }

    const parsed = injectedNumberSchema.safeParse(result.value);

    return parsed.success
      ? { kind: 'count', matches: parsed.data }
      : { error: 'The selector match count could not be read.', kind: 'error' };
  };

  const resolveSelector = async (
    selector: string
  ): Promise<BrowserToolResolvedTarget | undefined> => {
    if (debuggerApi === undefined) {
      // The scripting path resolves a target by selector; there is no debugger node id, so the tool implementations in `callTool` use `selector` and never `nodeId`. The match count still has to be unique.
      await attach();
      const counted = await countScriptingSelectorMatches(selector);

      if (counted.kind === 'error') {
        throw new Error(counted.error);
      }

      const { matches } = counted;

      if (matches === 0) {
        return undefined;
      }

      if (matches > 1) {
        return { kind: 'ambiguous', matches, selector };
      }

      return { kind: 'selector', nodeId: 0, selector };
    }

    await attach();

    const rootNodeId = await getDocumentNodeId();

    if (rootNodeId === undefined) {
      return undefined;
    }

    // A selector must name exactly one element: querySelector would silently take the first match, so an ambiguous selector would type into an arbitrary field.
    const response = await debuggerApi.sendCommand(target, 'DOM.querySelectorAll', {
      nodeId: rootNodeId,
      selector,
    });
    const parsed = domQuerySelectorAllResponseSchema.safeParse(response);

    if (!parsed.success) {
      return undefined;
    }

    if (parsed.data.nodeIds.length > 1) {
      return { kind: 'ambiguous', matches: parsed.data.nodeIds.length, selector };
    }

    const [nodeId] = parsed.data.nodeIds;

    if (nodeId === undefined || nodeId === 0) {
      return undefined;
    }

    return { kind: 'selector', nodeId, selector };
  };

  const resolveTarget = async (
    targetText: string,
    refs: ReadonlyMap<string, BrowserToolRefEntry>
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

  const registerRefs = (
    refs: Map<string, BrowserToolRefEntry>,
    entries: readonly BrowserToolRefEntry[],
    options?: { readonly merge?: boolean }
  ): void => {
    // A full snapshot replaces the registry; a targeted one adds its refs so the refs of the previous full snapshot keep resolving.
    if (options?.merge !== true) {
      refs.clear();
    }

    for (const entry of entries) {
      refs.set(entry.ref, entry);
    }
  };

  const handleDownloadWillBegin = (params: Record<string, unknown> | undefined): void => {
    const parsed = downloadWillBeginSchema.safeParse(params ?? {});

    if (!parsed.success) {
      return;
    }

    const announced: BrowserToolDownload = {
      ...(parsed.data.guid === undefined ? {} : { guid: parsed.data.guid }),
      ...(parsed.data.suggestedFilename === undefined
        ? {}
        : { suggestedFilename: parsed.data.suggestedFilename }),
      ...(parsed.data.url === undefined ? {} : { url: parsed.data.url }),
      startedAt: Date.now(),
    };

    downloadBuffer.push(announced);

    if (downloadBuffer.length > MAX_BROWSER_TOOL_CONSOLE_MESSAGES) {
      downloadBuffer.shift();
    }

    // A guard that is still on duty for a late download learns about it now, not when the item exists.
    for (const listener of downloadListeners) {
      listener(announced);
    }
  };

  const watchDownloads = (listener: (download: BrowserToolDownload) => void): (() => void) => {
    downloadListeners.add(listener);

    return () => {
      downloadListeners.delete(listener);
    };
  };

  const takeDownloads = (): readonly BrowserToolDownload[] => {
    const seen = [...downloadBuffer];

    downloadBuffer.length = 0;

    return seen;
  };

  const takeDialog = (): BrowserToolDialog | undefined => {
    const pending = dialog;

    dialog = undefined;

    return pending;
  };

  const runPageTool = async (
    script: string,
    timeoutMs?: number
  ): Promise<BrowserToolCallResult> => {
    try {
      await attach();
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'The browser tool session is unavailable.',
        ok: false,
      };
    }

    return runScriptingPageScript({
      script,
      scriptingApi,
      tabId,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  };

  const resolveTargetArg = (
    refs: ReadonlyMap<string, BrowserToolRefEntry>,
    targetText: string
  ): { readonly description: string; readonly selector: string } | { readonly error: string } => {
    const resolved = resolveScriptingTarget(refs, targetText);

    return resolved.kind === 'error' ? { error: resolved.error } : resolved;
  };

  const listTabs = async (): Promise<readonly BrowserToolTab[] | undefined> => {
    try {
      const tabs = await tabsApi.query({});
      const parsed = browserToolTabListSchema.safeParse(tabs);

      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  const closeTab = async (id: number): Promise<BrowserToolCallResult> => {
    const remove = tabsApi.remove?.bind(tabsApi);

    if (remove === undefined) {
      return { error: 'The browser cannot close tabs through this API.', ok: false };
    }

    try {
      await remove(id);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Closing the tab failed.',
        ok: false,
      };
    }

    if (id === tabId) {
      void dispose();
    }

    return { ok: true, value: 'Closed the tab.' };
  };

  const discoverPageWebMcpTools = async (): Promise<BrowserToolCallResult> => {
    if (scriptingApi === undefined) {
      return { error: 'WebMCP discovery API is unavailable.', ok: false };
    }

    const discovery = await discoverWebMcpToolsInTab({ scriptingApi, tabId });

    if (!discovery.ok) {
      return { error: discovery.error, ok: false };
    }

    const parsed = browserToolWebMcpDiscoverySchema.safeParse(discovery.value);

    if (!parsed.success) {
      return { error: 'WebMCP discovery returned an invalid result.', ok: false };
    }

    webMcpDiscovery = parsed.data;

    return { ok: true, value: parsed.data };
  };

  const runDebuggerOnlyTool = async (
    baseName: string,
    args: Record<string, unknown>
  ): Promise<BrowserToolCallResult> => {
    if (baseName === 'browser_console_messages') {
      const parsed = browserToolConsoleMessagesArgsSchema.safeParse(args);

      if (!parsed.success) {
        return { error: 'browser_console_messages arguments were invalid.', ok: false };
      }

      const all = parsed.data.all ?? false;
      const count = all ? consoleBuffer.length : consoleMessagesSinceNavigation;
      const messages = consoleBuffer.slice(Math.max(0, consoleBuffer.length - count));

      return { ok: true, value: formatConsoleMessages(messages, parsed.data.level ?? 'info') };
    }

    if (baseName === 'browser_network_requests') {
      return { ok: true, value: formatNetworkRequests([...networkById.values()]) };
    }

    if (baseName === 'browser_network_request') {
      const parsed = browserToolNetworkRequestArgsSchema.safeParse(args);

      if (!parsed.success) {
        return { error: 'browser_network_request arguments were invalid.', ok: false };
      }

      const requests = [...networkById.values()];
      const byNumber =
        parsed.data.number === undefined ? undefined : requests[parsed.data.number - 1];
      const byId =
        parsed.data.requestId === undefined ? undefined : networkById.get(parsed.data.requestId);
      const request = byId ?? byNumber;

      if (request === undefined) {
        return {
          error:
            'No matching network request. Use kilo_browser_network_requests for the numbered list.',
          ok: false,
        };
      }

      let detail = formatNetworkRequestDetail(request);

      if (parsed.data.part === 'body') {
        try {
          const body = await send('Network.getResponseBody', { requestId: request.requestId });
          const parsedBody = networkBodySchema.safeParse(body);

          detail += parsedBody.success
            ? `\nresponse body: ${renderResponseBody(
                parsedBody.data.body,
                parsedBody.data.base64Encoded === true
              )}`
            : '\nresponse body: unavailable.';
        } catch (error) {
          detail += `\nresponse body: ${error instanceof Error ? error.message : 'unavailable'}`;
        }
      }

      return { ok: true, value: detail };
    }

    if (baseName === 'browser_handle_dialog') {
      const parsed = browserToolHandleDialogArgsSchema.safeParse(args);

      if (!parsed.success) {
        return { error: 'browser_handle_dialog needs an accept argument.', ok: false };
      }

      const pending = takeDialog();

      if (pending === undefined) {
        return { error: 'No dialog is currently open.', ok: false };
      }

      try {
        await send('Page.handleJavaScriptDialog', {
          accept: parsed.data.accept,
          ...(parsed.data.promptText === undefined ? {} : { promptText: parsed.data.promptText }),
        });
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'Answering the dialog failed.',
          ok: false,
        };
      }

      return {
        ok: true,
        value: parsed.data.accept ? 'Accepted the dialog.' : 'Dismissed the dialog.',
      };
    }

    return {
      error: `${toKiloBrowserToolName(baseName)} runs through the debugger tool handlers, not the scripting tool path.`,
      ok: false,
    };
  };

  const runCallTool = async (
    toolName: string,
    args: Record<string, unknown>,
    refs: Map<string, BrowserToolRefEntry>
  ): Promise<BrowserToolCallResult> => {
    const baseName = toolName.startsWith(KILO_BROWSER_TOOL_PREFIX)
      ? toolName.slice(KILO_BROWSER_TOOL_PREFIX.length)
      : toolName;
    const firefoxUnsupported = getFirefoxUnsupportedToolError(baseName);

    if (firefoxUnsupported !== undefined) {
      return backend === 'scripting'
        ? { error: firefoxUnsupported, ok: false }
        : runDebuggerOnlyTool(baseName, args);
    }

    switch (baseName) {
      case 'browser_click': {
        const parsed = browserToolClickArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_click needs a target and valid options.', ok: false };
        }

        const resolved = resolveTargetArg(refs, parsed.data.target);

        if ('error' in resolved) {
          return { error: resolved.error, ok: false };
        }

        return runPageTool(
          buildClickPageScript({
            button: parsed.data.button ?? 'left',
            description: parsed.data.element ?? resolved.description,
            doubleClick: parsed.data.doubleClick ?? false,
            modifiers: parsed.data.modifiers ?? [],
            selector: resolved.selector,
          })
        );
      }

      case 'browser_close': {
        return closeTab(tabId);
      }

      case 'browser_drag': {
        const parsed = browserToolDragArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_drag needs startTarget and endTarget.', ok: false };
        }

        const start = resolveTargetArg(refs, parsed.data.startTarget);

        if ('error' in start) {
          return { error: start.error, ok: false };
        }

        const end = resolveTargetArg(refs, parsed.data.endTarget);

        if ('error' in end) {
          return { error: end.error, ok: false };
        }

        return runPageTool(
          buildDragPageScript({ endSelector: end.selector, startSelector: start.selector })
        );
      }

      case 'browser_drop': {
        const parsed = browserToolDropArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_drop needs a target and data or paths.', ok: false };
        }

        const resolved = resolveTargetArg(refs, parsed.data.target);

        if ('error' in resolved) {
          return { error: resolved.error, ok: false };
        }

        return runPageTool(
          buildDropPageScript({
            data: parsed.data.data ?? {},
            paths: parsed.data.paths ?? [],
            selector: resolved.selector,
          })
        );
      }

      case 'browser_evaluate': {
        const parsed = browserToolEvaluateArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_evaluate needs a function argument.', ok: false };
        }

        let selector: string | undefined = undefined;

        if (parsed.data.target !== undefined) {
          const resolved = resolveTargetArg(refs, parsed.data.target);

          if ('error' in resolved) {
            return { error: resolved.error, ok: false };
          }

          ({ selector } = resolved);
        }

        return runPageTool(
          buildEvaluatePageScript({ functionText: parsed.data.function, selector })
        );
      }

      case 'browser_fill_form': {
        const parsed = browserToolFillFormArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_fill_form needs a fields array.', ok: false };
        }

        const fields: {
          readonly name: string;
          readonly selector: string;
          readonly type: string;
          readonly value: string | boolean;
        }[] = [];

        for (const field of parsed.data.fields) {
          const resolved = resolveTargetArg(refs, field.target);

          if ('error' in resolved) {
            return { error: resolved.error, ok: false };
          }

          const value = field.value ?? '';
          const parsedBoolean = booleanValueSchema.safeParse(value);

          fields.push({
            name: field.name,
            selector: resolved.selector,
            type: field.type,
            value: parsedBoolean.success ? parsedBoolean.data : String(value),
          });
        }

        return runPageTool(buildFillFormPageScript({ fields }));
      }

      case 'browser_find': {
        const parsed = browserToolFindArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_find arguments were invalid.', ok: false };
        }

        if ((parsed.data.text === undefined) === (parsed.data.regex === undefined)) {
          return { error: 'browser_find needs exactly one of "text" or "regex".', ok: false };
        }

        let targetSelector: string | undefined = undefined;

        if (parsed.data.target !== undefined) {
          const resolved = resolveTargetArg(refs, parsed.data.target);

          if ('error' in resolved) {
            return { error: resolved.error, ok: false };
          }

          targetSelector = resolved.selector;
        }

        const result = await runPageTool(
          buildFindPageScript({
            boxes: false,
            depth: parsed.data.depth,
            needle: parsed.data.text,
            refStart: scriptingRefCount,
            regex: parsed.data.regex,
            targetSelector,
          })
        );

        if (!result.ok) {
          return result;
        }

        const found = browserToolFindResultSchema.safeParse(result.value);

        if (!found.success) {
          return { error: 'The page returned an invalid find result.', ok: false };
        }

        scriptingRefCount = found.data.nextRef;
        registerRefs(refs, found.data.refs);

        if (found.data.total === 0) {
          return {
            ok: true,
            value:
              parsed.data.text === undefined
                ? `No matches for /${parsed.data.regex ?? ''}/.`
                : `No matches for "${parsed.data.text}".`,
          };
        }

        return {
          ok: true,
          value: `Found ${String(found.data.total)} matching line(s):\n\n${found.data.blocks.join('\n--\n')}`,
        };
      }

      case 'browser_hover': {
        const parsed = browserToolTargetArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_hover needs a target.', ok: false };
        }

        const resolved = resolveTargetArg(refs, parsed.data.target);

        if ('error' in resolved) {
          return { error: resolved.error, ok: false };
        }

        return runPageTool(buildHoverPageScript({ selector: resolved.selector }));
      }

      case 'browser_navigate': {
        const parsed = browserToolNavigateArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_navigate needs a url.', ok: false };
        }

        return runPageTool(buildNavigatePageScript({ url: parsed.data.url }));
      }

      case 'browser_navigate_back': {
        return runPageTool(buildNavigateBackPageScript());
      }

      case 'browser_press_key': {
        const parsed = browserToolPressKeyArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_press_key needs a key.', ok: false };
        }

        return runPageTool(buildPressKeyPageScript({ key: parsed.data.key }));
      }

      case 'browser_resize': {
        const parsed = browserToolResizeArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_resize needs numeric width and height.', ok: false };
        }

        if (!Number.isFinite(parsed.data.width) || !Number.isFinite(parsed.data.height)) {
          return { error: 'browser_resize needs finite width and height.', ok: false };
        }

        if (parsed.data.width <= 0 || parsed.data.height <= 0) {
          return { error: 'browser_resize needs positive width and height.', ok: false };
        }

        return runPageTool(
          buildResizePageScript({ height: parsed.data.height, width: parsed.data.width })
        );
      }

      case 'browser_select_option': {
        const parsed = browserToolSelectOptionArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_select_option needs a target and values.', ok: false };
        }

        const resolved = resolveTargetArg(refs, parsed.data.target);

        if ('error' in resolved) {
          return { error: resolved.error, ok: false };
        }

        return runPageTool(
          buildSelectOptionPageScript({
            selector: resolved.selector,
            values: parsed.data.values,
          })
        );
      }

      case 'browser_snapshot': {
        const parsed = browserToolSnapshotArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_snapshot arguments were invalid.', ok: false };
        }

        let targetSelector: string | undefined = undefined;

        if (parsed.data.target !== undefined) {
          const resolved = resolveTargetArg(refs, parsed.data.target);

          if ('error' in resolved) {
            return { error: resolved.error, ok: false };
          }

          targetSelector = resolved.selector;
        }

        const result = await runPageTool(
          buildSnapshotPageScript({
            boxes: parsed.data.boxes ?? false,
            depth: parsed.data.depth,
            refStart: scriptingRefCount,
            targetSelector,
          })
        );

        if (!result.ok) {
          return result;
        }

        const snapshot = browserToolSnapshotResultSchema.safeParse(result.value);

        if (!snapshot.success) {
          return { error: 'The page returned an invalid snapshot.', ok: false };
        }

        scriptingRefCount = snapshot.data.nextRef;
        registerRefs(refs, snapshot.data.refs, { merge: targetSelector !== undefined });

        const note =
          parsed.data.filename === undefined
            ? ''
            : `\nFilename "${parsed.data.filename}" was not written: this extension has no workspace root, so the snapshot is returned inline.`;

        return { ok: true, value: `${snapshot.data.lines.join('\n')}${note}` };
      }

      case 'browser_tabs': {
        const parsed = browserToolTabsArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_tabs arguments were invalid.', ok: false };
        }

        const tabs = await listTabs();

        if (tabs === undefined) {
          return { error: 'The browser tab API is unavailable.', ok: false };
        }

        if (parsed.data.action === 'list') {
          return { ok: true, value: formatTabList(tabs, tabId) };
        }

        if (parsed.data.action === 'new') {
          const create = tabsApi.create?.bind(tabsApi);

          if (create === undefined) {
            return { error: 'The browser cannot open a new tab through this API.', ok: false };
          }

          const created = await create(
            parsed.data.url === undefined ? {} : { url: parsed.data.url }
          );

          return {
            ok: true,
            value: `Opened tab ${String(created.id ?? '')}${parsed.data.url === undefined ? '' : ` at ${parsed.data.url}`}.`,
          };
        }

        const index =
          parsed.data.index ??
          (parsed.data.action === 'close' ? tabs.findIndex(tab => tab.id === tabId) : undefined);

        if (index === undefined) {
          return { error: `browser_tabs ${parsed.data.action} needs an index.`, ok: false };
        }

        const tab = tabs[index];

        if (tab?.id === undefined) {
          return { error: `No tab at index ${String(index)}.`, ok: false };
        }

        if (parsed.data.action === 'close') {
          const closed = await closeTab(tab.id);

          return closed.ok
            ? { ok: true, value: `Closed tab ${String(index)} (${tab.title ?? ''}).` }
            : closed;
        }

        const update = tabsApi.update?.bind(tabsApi);

        if (update === undefined) {
          return { error: 'The browser cannot select tabs through this API.', ok: false };
        }

        await update(tab.id, { active: true });

        return {
          ok: true,
          value: `Selected tab ${String(index)} (${tab.title ?? ''} - ${tab.url ?? ''}).`,
        };
      }

      case 'browser_take_screenshot': {
        const parsed = browserToolScreenshotArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_take_screenshot arguments were invalid.', ok: false };
        }

        const screenshot = await getViewportScreenshotWithTabsApi({ tabId, tabsApi });

        if (!screenshot.ok) {
          return { error: screenshot.error, ok: false };
        }

        const value = viewportScreenshotSchema.safeParse(screenshot.value);

        if (!value.success) {
          return { error: 'The screenshot API returned an invalid image.', ok: false };
        }

        const limitations: string[] = [];

        if (parsed.data.fullPage === true) {
          limitations.push('fullPage');
        }
        if (parsed.data.target !== undefined) {
          limitations.push('target (element clip)');
        }
        if (parsed.data.type !== undefined && parsed.data.type !== 'png') {
          limitations.push(`type=${parsed.data.type}`);
        }

        const note =
          limitations.length === 0
            ? 'Captured the visible viewport.'
            : `Captured the visible viewport; this browser cannot honour ${limitations.join(', ')} without a debugger protocol.`;

        return { ok: true, value: { ...value.data, note } };
      }

      case 'browser_type': {
        const parsed = browserToolTypeArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_type needs a target and text.', ok: false };
        }

        const resolved = resolveTargetArg(refs, parsed.data.target);

        if ('error' in resolved) {
          return { error: resolved.error, ok: false };
        }

        return runPageTool(
          buildTypePageScript({
            selector: resolved.selector,
            slowly: parsed.data.slowly ?? false,
            submit: parsed.data.submit ?? false,
            text: parsed.data.text,
          })
        );
      }

      case 'browser_wait_for': {
        const parsed = browserToolWaitForArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_wait_for arguments were invalid.', ok: false };
        }

        const requested = [parsed.data.text, parsed.data.textGone, parsed.data.time].filter(
          value => value !== undefined
        ).length;

        if (requested !== 1) {
          return {
            error: 'browser_wait_for needs exactly one of "time", "text" or "textGone".',
            ok: false,
          };
        }

        const waitMs =
          parsed.data.time === undefined
            ? MAX_BROWSER_TOOL_WAIT_MS
            : Math.min(Math.round(parsed.data.time * 1000), MAX_BROWSER_TOOL_WAIT_MS);

        return runPageTool(
          buildWaitForPageScript({
            text: parsed.data.text,
            textGone: parsed.data.textGone,
            waitMs,
          }),
          waitMs + 2000
        );
      }

      case 'browser_webmcp_call': {
        const parsed = browserToolWebMcpCallArgsSchema.safeParse(args);

        if (!parsed.success) {
          return { error: 'browser_webmcp_call needs a tool name.', ok: false };
        }

        if (scriptingApi === undefined) {
          return { error: 'WebMCP execution API is unavailable.', ok: false };
        }

        if (webMcpDiscovery === undefined) {
          const discovery = await discoverPageWebMcpTools();

          if (!discovery.ok) {
            return discovery;
          }
        }

        const list = webMcpDiscovery;
        const tool = list?.tools.find(candidate => candidate.name === parsed.data.name);

        if (list === undefined || tool === undefined) {
          return {
            error: `WebMCP tool "${parsed.data.name}" is not available. Call kilo_browser_webmcp_list first.`,
            ok: false,
          };
        }

        const signature = buildWebMcpDefinitionSignature(tool);
        const result = await executeWebMcpToolInTab({
          arguments: JSON.stringify(parsed.data.params ?? {}),
          definitionSignature: signature,
          documentId: list.documentId,
          scriptingApi,
          tabId,
          toolName: parsed.data.name,
        });

        return result.ok ? { ok: true, value: result.value } : { error: result.error, ok: false };
      }

      case 'browser_webmcp_list': {
        const discovery = await discoverPageWebMcpTools();

        if (!discovery.ok) {
          return discovery;
        }

        const list = browserToolWebMcpDiscoverySchema.safeParse(discovery.value);

        if (!list.success || list.data.tools.length === 0) {
          return { ok: true, value: 'No WebMCP tools are available on this page.' };
        }

        return {
          ok: true,
          value: list.data.tools
            .map(
              tool =>
                `- ${tool.name}: ${tool.title}${tool.description === '' ? '' : ` — ${tool.description}`}`
            )
            .join('\n'),
        };
      }

      default: {
        return { error: `${toolName} is not a browser tool this session can run.`, ok: false };
      }
    }
  };

  const evaluateInTab = async (code: string, timeoutMs?: number): Promise<EvalTabResult> => {
    if (disposed) {
      return { error: BROWSER_TOOL_SESSION_DISPOSED_ERROR, ok: false };
    }

    try {
      await attach();
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'The browser tool session is unavailable.',
        ok: false,
      };
    }

    if (debuggerApi === undefined) {
      if (scriptingApi === undefined) {
        return { error: 'Tab evaluation API is unavailable.', ok: false };
      }

      return evalInTabWithScripting({
        code,
        scriptingApi,
        tabId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    }

    return evaluateTabCode({
      code,
      send: (method, params) => Promise.resolve(debuggerApi.sendCommand(target, method, params)),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  };

  const getToolUnavailableError = (tool: string): string | undefined =>
    backend === 'scripting' ? getFirefoxUnsupportedToolError(tool) : undefined;

  const createCallerView = (
    callerKey: string,
    refs: Map<string, BrowserToolRefEntry>,
    guard?: BrowserToolCallGuard
  ): BrowserToolSession => {
    const throwIfCancelled = (): void => {
      if (guard?.cancelled() === true) {
        throw new Error(TAB_TAKEN_ERROR);
      }
    };

    return {
      attach,
      backend,
      bindCaller: nextKey => createCallerView(nextKey, callerRefs(nextKey), guard),
      callTool: (toolName, args) => {
        throwIfCancelled();
        return runCallTool(toolName, args ?? {}, refs);
      },
      captureViewportImage: (format, callGuard) => {
        throwIfCancelled();
        // The capture checks the same guard before each command it sends, so a take-over mid-capture stops it.
        return captureViewportImage(format, callGuard ?? guard);
      },
      childFrames: () => new Map(childFrames),
      consoleMessages: () => [...consoleBuffer],
      // A caller view owns only its ref registry: disposing it must not detach the tab's shared attachment.
      dispose: () => {
        refs.clear();
        refsByCaller.delete(callerKey);
        return Promise.resolve();
      },
      disposeCaller: key => {
        refsByCaller.get(key)?.clear();
        refsByCaller.delete(key);
      },
      downloads: () => [...downloadBuffer],
      evaluateInTab,
      getToolUnavailableError,
      isAttached: () => attached,
      networkRequests: () => [...networkById.values()],
      networkRequestsSinceLoad,
      registerRefs: (entries, options) => {
        registerRefs(refs, entries, options);
      },
      resolveTarget: targetText => {
        throwIfCancelled();
        return resolveTarget(targetText, refs);
      },
      send: (method, params, sessionId) => {
        throwIfCancelled();
        return send(method, params, sessionId);
      },
      takeDialog,
      takeDownloads,
      viewportState,
      watchDownloads,
    };
  };

  // Subscribe before any attach so a detach that lands during attach is not missed.
  debuggerApi?.onDetach.addListener(handleDetach);
  debuggerApi?.onEvent.addListener(handleEvent);
  tabsApi.onRemoved?.addListener(handleTabRemoved);

  return {
    attach,
    backend,
    bindCaller: (callerKey, guard) => createCallerView(callerKey, callerRefs(callerKey), guard),
    callTool: (toolName, args) => runCallTool(toolName, args ?? {}, defaultRefs),
    captureViewportImage,
    childFrames: () => new Map(childFrames),
    consoleMessages: () => [...consoleBuffer],
    dispose,
    disposeCaller: callerKey => {
      refsByCaller.get(callerKey)?.clear();
      refsByCaller.delete(callerKey);
    },
    downloads: () => [...downloadBuffer],
    evaluateInTab,
    getToolUnavailableError,
    isAttached: () => attached,
    networkRequests: () => [...networkById.values()],
    networkRequestsSinceLoad,
    registerRefs: (entries, options) => {
      registerRefs(defaultRefs, entries, options);
    },
    resolveTarget: targetText => resolveTarget(targetText, defaultRefs),
    send,
    takeDialog,
    takeDownloads,
    viewportState,
    watchDownloads,
  };
};
