/* eslint-disable max-lines -- One policy module owns grant classes, origin matching, sensitive classification, tokens and masking helpers. */
import { z } from 'zod';

/**
 * What an agent caller may do with an origin. The CLI holds the matching
 * `browser` permission patterns (`read:<origin>`, `act:<origin>`,
 * `navigate:<origin>`) and sends the granted pairs on every call; the
 * extension never decides a grant on its own.
 */
export type BrowserGrantClass = 'read' | 'act' | 'navigate';

/** One entry of a `browser_drop`'s `paths`: a local file the page may read, so never an empty string. */
export const dropPathsSchema = z.array(z.string().min(1));

/** A `browser_drop`'s `target`: the ref or selector the files are dropped onto, never an empty string. */
export const dropTargetSchema = z.string().min(1);

/**
 * The arguments `browser_webmcp_call` takes: a tool name and its params. Strict,
 * because a key this tool has no room for — the vendored contract's `frame` — is
 * refused here rather than dropped by a handler that reads the keys it knows.
 */
export const webMcpCallArgumentsSchema = z.strictObject({
  name: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The tool error for arguments `browser_webmcp_call` does not take. A caller
 * that sends a key the tool has no room for is told which key: an argument
 * dropped in silence is a call that does something other than what was asked.
 */
export const webMcpCallArgumentError = (error: z.ZodError): string => {
  const unrecognizedKeys = error.issues.flatMap(issue =>
    issue.code === 'unrecognized_keys' ? issue.keys : []
  );

  if (unrecognizedKeys.length > 0) {
    const keys = unrecognizedKeys.map(key => `"${key}"`).join(', ');

    return `browser_webmcp_call does not take ${keys}; it takes a tool name and its params.`;
  }

  if (error.issues.some(issue => issue.path[0] === 'name')) {
    return 'browser_webmcp_call needs a tool name.';
  }

  return 'browser_webmcp_call arguments were invalid.';
};

/**
 * Whether a call hands local file contents to the page: `browser_file_upload` does, and so
 * does `browser_drop` when its `paths` lists at least one local file. A drop that carries
 * only `data`, or an empty or malformed `paths`, names no file and is not an upload.
 */
export const isUploadCall = (toolName: string, args: Record<string, unknown> = {}): boolean => {
  if (toolName === 'browser_file_upload') {
    return true;
  }

  const paths = dropPathsSchema.safeParse(args['paths']);

  return toolName === 'browser_drop' && paths.success && paths.data.length > 0;
};

export interface BrowserGrant {
  readonly class: BrowserGrantClass;
  readonly origin: string;
}

const grantClassSchema = z.enum(['read', 'act', 'navigate']);

/** Validates the `authorized` array a `tools.call` carries, dropping malformed entries. */
export const authorizedGrantsSchema = z.array(
  z.object({ class: grantClassSchema, origin: z.string().min(1) })
);

/** The browser tools grouped by the grant each one needs. Every contract tool appears exactly once. */
const READ_TOOL_NAMES: readonly string[] = [
  'browser_console_messages',
  'browser_find',
  'browser_network_request',
  'browser_network_requests',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_webmcp_list',
];

const NAVIGATE_TOOL_NAMES: readonly string[] = ['browser_navigate', 'browser_navigate_back'];

/**
 * Everything that changes the page or the browser, including the two tools
 * that run model-authored code: `browser_evaluate` and
 * `browser_run_code_unsafe` need the `act` grant (D11).
 */
const ACT_TOOL_NAMES: readonly string[] = [
  'browser_click',
  'browser_close',
  'browser_drag',
  'browser_drop',
  'browser_evaluate',
  'browser_file_upload',
  'browser_fill_form',
  'browser_handle_dialog',
  'browser_hover',
  'browser_press_key',
  'browser_resize',
  'browser_run_code_unsafe',
  'browser_select_option',
  'browser_tabs',
  'browser_type',
  'browser_webmcp_call',
];

const CLASS_BY_TOOL: ReadonlyMap<string, BrowserGrantClass> = new Map([
  ...READ_TOOL_NAMES.map((name): [string, BrowserGrantClass] => [name, 'read']),
  ...NAVIGATE_TOOL_NAMES.map((name): [string, BrowserGrantClass] => [name, 'navigate']),
  ...ACT_TOOL_NAMES.map((name): [string, BrowserGrantClass] => [name, 'act']),
]);

/** The grant one browser tool needs; an unknown tool is treated as `act`, the strictest class. */
export const toolGrantClass = (toolName: string): BrowserGrantClass =>
  CLASS_BY_TOOL.get(toolName) ?? 'act';

/**
 * Every tool whose page action can start a download: a click, a dropped or
 * dragged item, a key press (Enter on a focused link), a form filled or
 * submitted, the two tools that run model-authored code, an answer to a JS
 * dialog — the click that opened it returns at once, and its handler resumes in
 * the answer — and a load the page did not ask a human for: a navigate to an
 * attachment URL, a back/forward to one, or a tab opened at a URL that answers
 * with a file.
 */
const DOWNLOAD_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_drag',
  'browser_drop',
  'browser_evaluate',
  // Fills each field through the page's own `input`/`change` handler, and clicks a checkbox or radio into place.
  'browser_fill_form',
  // The dialog's owner resumes in this call: the click that opened it has already answered.
  'browser_handle_dialog',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_press_key',
  'browser_reload',
  'browser_run_code_unsafe',
  // Dispatches `change` on the element, and an export-style handler can answer with an attachment.
  'browser_select_option',
  'browser_tabs',
  // `submit` presses Enter on the filled field, and typing alone fires the page's `input` handler.
  'browser_type',
  // Runs page-registered code, which can start a download like any other page action.
  'browser_webmcp_call',
]);

/** `browser_tabs` opens a page only for `new`; list, select and close touch no document. */
export const canStartDownload = (toolName: string, args: Record<string, unknown> = {}): boolean => {
  if (toolName === 'browser_tabs') {
    return args['action'] === 'new';
  }

  return DOWNLOAD_CAPABLE_TOOLS.has(toolName);
};

/**
 * The one guard a call runs, chosen once from the browser and the live optional
 * `downloads` permission — never two at a time, because each one decides the
 * same item and the later one would only overrule the earlier. The one file an
 * approval buys is exempted by the guard's own exempt predicate, so a guard that
 * has none decides every file of the call alike.
 * - `hold`: `chrome.downloads.onDeterminingFilename` exists, so the item is held before its file exists.
 * - `intercept`: Chrome without the permission, so the response that would become a file is failed.
 * - `legacy`: neither the event nor a permission to hold with (`downloadsApi` is `undefined` only on a browser
 *   whose `chrome.downloads` cannot be read), so the item is cancelled after it starts.
 * - `none`: this call cannot start a download, or this browser offers no guard it can arm for it.
 *
 * `holdsDownloads` is whether this browser has the event at all, which is what the hold object exists for; a hold
 * without the permission cannot answer it, so the permission picks `intercept` there and never `hold`.
 */
export type DownloadTier =
  /** `onDeterminingFilename` holds the item before its file exists. */
  | 'hold'
  /** The response that would become a file is failed, because the permission to hold it is not granted. */
  | 'intercept'
  /** The item is cancelled after it starts: a browser with neither the event nor the permission. */
  | 'legacy'
  /** This call cannot start a download, or this browser offers no guard it can arm for it. */
  | 'none';

export const downloadTierOf = ({
  canDownload,
  canIntercept,
  hasHold,
  hasPermission,
  legacyGuardCanExempt,
}: {
  /** Whether this call is an agent call that can start a download at all. */
  readonly canDownload: boolean;
  /** Whether this tab can pause a response at all: a debugger backend, so Chrome and not Firefox. */
  readonly canIntercept: boolean;
  /** Whether the browser raises `onDeterminingFilename`, so a hold can decide an item. */
  readonly hasHold: boolean;
  /** Whether the optional `downloads` permission is granted right now. */
  readonly hasPermission: boolean;
  /**
   * Whether the legacy guard has something to decide: an unapproved call to refuse, a step approval whose retry it still
   * guards, or an approval that names a file to exempt. It is false only for an approval whose refusal named no file.
   */
  readonly legacyGuardCanExempt: boolean;
}): DownloadTier => {
  if (!canDownload) {
    return 'none';
  }

  if (!hasPermission) {
    // Without the permission the hold's event does not exist: the response is the only thing left to fail.
    return canIntercept ? 'intercept' : 'none';
  }

  if (!hasHold) {
    return legacyGuardCanExempt ? 'legacy' : 'none';
  }

  return 'hold';
};

/**
 * The tab an approved download step opened is gone, so there is no tab to
 * repeat that step on. Opening a fresh one would download the file again
 * without the approval the human gave.
 */
export const DOWNLOAD_STEP_TAB_GONE_ERROR =
  'The tab that step opened is gone. Take a fresh snapshot and try again (blocked).';

/**
 * A report for a download the browser started where nothing could hold it: the
 * optional `downloads` permission is missing, so `onDeterminingFilename` does
 * not exist. On Chrome the response interceptor still stops an http(s)
 * attachment, so this text is only reached by a `blob:`, `data:` or
 * `<a download>` file no network response can fail. The step ran and the file
 * may exist, so the text names both and the one action that guards the next.
 */
export const DOWNLOAD_PERMISSION_MISSING_ERROR =
  'A download may have been saved: the optional Downloads permission is not granted, so the download guard could not watch it. Turn "Allow local agents" off and on again to grant it, then retry.';

/**
 * The refusal for an http(s) download the response interceptor stopped: the file
 * is named, and the approval is named as the thing the Downloads permission
 * makes possible. Without that permission a step token cannot be redeemed, so no
 * approval is offered — the text asks for the grant instead.
 */
export const downloadStoppedWithoutPermissionError = (filename: string): string =>
  `The download of ${filename} was stopped before it was saved. Granting the optional Downloads permission lets this download be approved and repeated.`;

/**
 * The line for the files one call started besides the file its approval bought:
 * one click can start several, and the approval names exactly one of them. The
 * call did what the human approved, so these are named as stopped — a refusal
 * would read as "the approved file never landed".
 */
export const alsoStoppedDownloadsText = (filenames: readonly string[]): string => {
  const names = [...new Set(filenames)].join(', ');

  return `${names}: the download was stopped before it was saved — each file needs its own approval, and the permission covers one download at a time.`;
};

/**
 * The refusal for an approval that could not produce its file: Chrome's own
 * multiple-downloads limiter blocks the approved repeat, so the browser creates
 * no item at all. The approval is still unspent — a second human approval must
 * not be needed for a file Chrome silently swallowed — and the text names the
 * browser setting that unblocks it.
 */
export const DOWNLOAD_BLOCKED_BY_BROWSER_ERROR =
  'The browser blocked this download. The user can allow automatic downloads for this site in Chrome, then repeat the step.';

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' } as const;

const parseUrl = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/**
 * `scheme://host[:port]` for an http(s) or file URL, `undefined` for anything
 * else (browser-internal pages and extension pages never receive a grant).
 * Default ports are dropped so `https://a.com:443/` and `https://a.com/` agree.
 */
export const toBrowserOrigin = (url: string | undefined): string | undefined => {
  if (url === undefined || url === '') {
    return undefined;
  }

  if (url.startsWith('file://')) {
    return 'file://';
  }

  const parsed = parseUrl(url);

  if (parsed === undefined) {
    return undefined;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }

  const port =
    parsed.port === '' || parsed.port === DEFAULT_PORTS[parsed.protocol] ? '' : `:${parsed.port}`;

  return `${parsed.protocol}//${parsed.hostname}${port}`;
};

/**
 * One glob segment (`*`) match, used for both origin wildcards and path
 * prefixes. The CLI writes concrete origins; wildcards exist for the
 * localhost family and for a future `*` grant.
 */
export const originPatternMatches = (pattern: string, value: string): boolean => {
  if (!pattern.includes('*')) {
    return pattern === value;
  }

  const escaped = pattern
    .split('*')
    .map(part => part.replaceAll(/[$()+.?[\\\]^{|}]/gu, String.raw`\$&`))
    .join('.*');

  return new RegExp(`^${escaped}$`, 'u').test(value);
};

/** True when the client sent this exact class/origin pair (or a covering wildcard). */
export const isOriginGranted = (
  authorized: readonly BrowserGrant[],
  grantClass: BrowserGrantClass,
  origin: string
): boolean =>
  authorized.some(
    candidate => candidate.class === grantClass && originPatternMatches(candidate.origin, origin)
  );

export interface BrowserPermissionItem {
  readonly class: 'read' | 'act' | 'navigate' | 'sensitive';
  readonly origin: string;
  /** The request targeted a frame, not the tab's top-level document. */
  readonly frame?: boolean;
  /** Why the step is sensitive: a short, model-safe reason. */
  readonly reason?: string;
}

/** The structured refusal the transport maps to JSON-RPC -32010. */
export interface BrowserNeedsPermission {
  readonly items: readonly BrowserPermissionItem[];
  readonly kind: 'needs_permission';
  /**
   * The step whose repeat needs the approval, when it is not simply this call:
   * a late download is reported by the next call, so the CLI must bind the
   * token to the click that started it, not to the call carrying the news.
   */
  readonly step?: { readonly argumentsHash: string; readonly tool: string };
  /** Present for sensitive steps: the token the CLI retries with once a human approves. */
  readonly stepToken?: string;
}

/** The structured refusal the transport maps to JSON-RPC -32012. */
export interface BrowserOriginChanged {
  readonly from: string;
  readonly kind: 'origin_changed';
  readonly to: string;
}

/** The tool error text a refused call carries when the bridge is not in the loop (E2E, panel). */
export const NEEDS_PERMISSION_ERROR =
  'The browser action needs permission for this origin. Nothing was changed.';

/**
 * The D9 refusal: an agent reached for a tab outside its session's group. The
 * bridge maps it onto `blocked` (-32011); the message names the fix.
 */
export const AGENT_TAB_OUTSIDE_GROUP_ERROR =
  'This tab is not in the agent session\u2019s tab group (blocked). Share it first or pick a tab in the group.';

/**
 * The extension cannot run Playwright code: a snippet would have to be compiled
 * in the extension, and the MV3 script policy of Chrome and Firefox forbids
 * evaluating strings there. The bridge maps it onto `unsupported_in_browser`
 * (-32005) before the gate runs.
 */
export const RUN_CODE_UNSUPPORTED_ERROR =
  'browser_run_code_unsafe is not available: the Kilo extension cannot run Playwright code in Chrome or Firefox. Run a JavaScript function in the page with browser_evaluate instead.';

/**
 * The pinned tools no backend can run here. The vendored contract keeps them —
 * its SHA-256 is of the upstream `tools/list` and the handshake compares that —
 * but a listing must not offer a tool whose every call is refused above.
 */
export const UNSERVED_BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'browser_run_code_unsafe',
]);

/** The two tools that run model-authored page code (D11: they need the `act` grant). */
export const isScriptTool = (toolName: string): boolean =>
  toolName === 'browser_evaluate' || toolName === 'browser_run_code_unsafe';
/** A CSS selector that names more than one element: a call that cannot run must not ask for permission. */
export const ambiguousSelectorError = (matches: number): string =>
  `The selector matches ${String(matches)} elements. Use a snapshot ref or a selector that matches one element.`;

// Callers name the snapshot tool differently (the side panel prefixes `kilo_`), so the hint names none.
export const FRESH_SNAPSHOT_HINT =
  'Take a new page snapshot and use a ref from it, or pass a unique CSS selector.';

/** A ref no snapshot registered, or one whose element is gone: every backend answers it with this one error. */
export const STALE_REF_ERROR = `The element reference is stale or unknown. ${FRESH_SNAPSHOT_HINT}`;

const BROWSER_REF_PATTERN = /^(?:ref=)?(?:f\d+)?e\d+$/u;

/** Whether a target names a snapshot ref (`e12`, `ref=e12`, `f1e12`) rather than a CSS selector. */
export const looksLikeBrowserRef = (target: string): boolean =>
  BROWSER_REF_PATTERN.test(target.trim());

export const ORIGIN_CHANGED_ERROR =
  'The page redirected to a different origin than the one this navigation was approved for.';

/** Sensitive reasons, kept short and free of page content so they are safe to show a model. */
export const SENSITIVE_REASON = {
  cardFormSubmit: 'submitting a form with payment fields',
  download: 'downloading a file',
  fileUpload: 'uploading a file',
  frameUnverified: 'acting in a frame whose page could not be inspected',
  oauthConsent: 'acting on an OAuth consent page',
  oneTimeCode: 'typing a one-time code',
  password: 'typing a password',
  paymentField: 'typing into a payment field',
  script: 'a page script can reach a sensitive field',
  scriptUnverified: 'a page script could reach a field that could not be inspected',
  unknownField: 'typing into a field that could not be inspected',
} as const;

/** The tool families whose act calls can be sensitive; read-only tools never are. */
export const SENSITIVE_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_drag',
  'browser_drop',
  'browser_evaluate',
  'browser_fill_form',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_press_key',
  'browser_run_code_unsafe',
  'browser_type',
]);

const OAUTH_CONSENT_ROUTES: readonly {
  readonly host: string;
  readonly pathPrefixes: readonly string[];
}[] = [
  { host: 'accounts.google.com', pathPrefixes: ['/o/oauth2', '/signin/oauth'] },
  { host: 'appleid.apple.com', pathPrefixes: ['/auth/authorize'] },
  { host: 'auth.atlassian.com', pathPrefixes: ['/oauth/authorize'] },
  { host: 'bitbucket.org', pathPrefixes: ['/site/oauth2/authorize'] },
  { host: 'discord.com', pathPrefixes: ['/oauth2/authorize'] },
  { host: 'github.com', pathPrefixes: ['/login/oauth/authorize', '/login/device'] },
  { host: 'gitlab.com', pathPrefixes: ['/oauth/authorize'] },
  { host: 'login.live.com', pathPrefixes: ['/oauth20_authorize.srf'] },
  { host: 'login.microsoftonline.com', pathPrefixes: ['/oauth2'] },
  { host: 'slack.com', pathPrefixes: ['/oauth/authorize'] },
  { host: 'www.facebook.com', pathPrefixes: ['/dialog/oauth'] },
];

/**
 * True on an OAuth consent screen. `login.microsoftonline.com` puts the tenant
 * id in the path (`/<tenant>/oauth2/v2.0/authorize`), so its prefix is matched
 * anywhere after the host; every other host matches from the path start.
 */
export const isOAuthConsentUrl = (url: string | undefined): boolean => {
  if (url === undefined) {
    return false;
  }

  const parsed = parseUrl(url);

  if (parsed === undefined) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  return OAUTH_CONSENT_ROUTES.some(route => {
    if (host !== route.host) {
      return false;
    }

    return route.host === 'login.microsoftonline.com'
      ? route.pathPrefixes.some(prefix => path.includes(prefix))
      : route.pathPrefixes.some(prefix => path.startsWith(prefix));
  });
};

export interface BrowserSensitiveField {
  /** The element's role in the page, used only for the reason text. */
  readonly kind: 'one-time-code' | 'password' | 'payment';
}

/**
 * One form-field probe finding: the sensitive inputs (password, one-time
 * code, payment) and whether a submit control sits in a form holding payment
 * fields. The injected expression returns this shape; `kind` drives the
 * refusal reason.
 */
export interface BrowserSensitiveProbe {
  readonly fields: readonly BrowserSensitiveField[];
  readonly paymentFormSubmit: boolean;
}

const AUTOFILL_SENSITIVE_PREFIXES: readonly string[] = ['cc-'];
const ONE_TIME_CODE_AUTOCOMPLETE = 'one-time-code';

const autocompleteKind = (token: string): BrowserSensitiveField['kind'] | undefined => {
  if (token === ONE_TIME_CODE_AUTOCOMPLETE) {
    return 'one-time-code';
  }

  return AUTOFILL_SENSITIVE_PREFIXES.some(prefix => token.startsWith(prefix))
    ? 'payment'
    : undefined;
};

/**
 * Classifies a form control from its `type`/`autocomplete` attribute values.
 * Payment fields are `cc-*` autocomplete tokens or a `cc-*`/`card` name, which
 * is what real checkout forms that omit autocomplete expose.
 */
export const classifyFormField = (input: {
  readonly autocomplete?: string | undefined;
  readonly name?: string | undefined;
  readonly type?: string | undefined;
}): BrowserSensitiveField['kind'] | undefined => {
  if (input.type?.toLowerCase() === 'password') {
    return 'password';
  }

  const tokens = (input.autocomplete ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .filter(token => token !== '');

  for (const token of tokens) {
    const kind = autocompleteKind(token);

    if (kind !== undefined) {
      return kind;
    }
  }

  const name = (input.name ?? '').toLowerCase();

  return /(?:^|[-_])(?:cc|card)(?:[-_]|$)/u.test(name) || name === 'cardnumber'
    ? 'payment'
    : undefined;
};

export const sensitiveReasonForField = (kind: BrowserSensitiveField['kind']): string => {
  switch (kind) {
    case 'one-time-code': {
      return SENSITIVE_REASON.oneTimeCode;
    }
    case 'password': {
      return SENSITIVE_REASON.password;
    }
    case 'payment': {
      return SENSITIVE_REASON.paymentField;
    }
  }
};

/** How long a step token, and the one file its need names, lives. */
export const STEP_TOKEN_TTL_MS = 60_000;

/** What a step token binds: the tab, the element, the tool, and the exact arguments. */
export interface StepTokenBinding {
  readonly argumentHash: string;
  readonly element?: string | undefined;
  readonly origin: string;
  /** The agent session the approval belongs to: another session's token never applies. */
  readonly session: string;
  readonly tabId: number;
  readonly toolName: string;
}

/**
 * The one download a step's approval buys: the tab it was on and the url of the file it started.
 *
 * `page` covers any download of that page — a repeat that regenerates its link (`?click=2`) is the same file the
 * human approved. `exact` covers one url alone: it is what a refusal arms when the call's own requests named none of
 * the stopped files, so the file the step meant is unknown and only the file the browser named may pass.
 */
export type StepTokenNeed =
  | { readonly kind: 'exact'; readonly tabId: number; readonly url: string }
  | { readonly kind: 'page'; readonly tabId: number; readonly url: string };

export interface StepTokenIssue extends StepTokenBinding {
  /** The download this approval is for, when the step was refused for one: the call keeps that file alone. */
  readonly need?: StepTokenNeed | undefined;
  readonly reason: string;
}

/** What consuming a token answered: whether it named the call, the file its approval buys, and what it approved. */
export interface StepTokenTake {
  readonly need?: StepTokenNeed | undefined;
  readonly ok: boolean;
  /** The reason the token was issued for, so a caller can tell the step an approval buys from a download's file. */
  readonly reason?: string | undefined;
}

export interface StepTokenStore {
  /** Issues a single-use token bound to one call; the clock is the store's, not the caller's. */
  readonly issue: (input: StepTokenIssue) => string;
  /**
   * Consumes a token and answers what it carried. The need lives exactly as long as the token — a human may take
   * Minutes to approve — so it is never tied to a download record the browser's own pruning removes. The bindings are
   * the finite set of calls this token may legitimately name, so a caller can offer the one it recomputed beside the
   * one the token was issued under.
   */
  readonly take: (token: string, bindings: readonly StepTokenBinding[]) => StepTokenTake;
  readonly size: () => number;
}

/**
 * A stable, dependency-free hash of a tool call's arguments: object keys are
 * sorted, so `{a,b}` and `{b,a}` hash alike. The token binds the model's exact
 * arguments, so a retry with different values needs a fresh approval.
 */
const canonicalArgumentSchema = z.record(z.string(), z.unknown());

/**
 * The plain-object form of a `tools.call`'s arguments, the shape the gate's
 * preflight branches on; anything else (a scalar, an array, absent) is empty.
 */
export const parseToolArguments = (args: unknown): Record<string, unknown> => {
  const parsed = canonicalArgumentSchema.safeParse(args);

  return parsed.success ? parsed.data : {};
};

/**
 * The canonical text of a call's arguments, hashed to the name a step token
 * binds. The form, which a CLI must reproduce to read `step.argumentsHash`:
 *
 * - An array is `[` + its items in order, each canonical, joined by `,` + `]`.
 * - A plain object is `{` + its keys sorted by UTF-16 code unit (`toSorted()`)
 *   written as `"key":value` joined by `,` + `}` — key order never matters.
 * - Every other value is `JSON.stringify(value) ?? 'null'`, so a string keeps
 *   its JSON quotes, `undefined` becomes `null`, and absent arguments hash as
 *   `null`.
 *
 * The hash starts at `2_166_136_261` and walks the canonical text once per
 * UTF-16 index (`index < text.length`): at each index it XORs
 * `text.codePointAt(index) ?? 0` and multiplies by `16_777_619`. An astral
 * character therefore contributes its full code point at its first index and
 * its low surrogate at the second, which a plain code-unit fold would not. The
 * result is `hex:length`: the hash in unpadded lowercase hexadecimal, a colon,
 * and the canonical text's length counted in UTF-16 code units.
 */
export const hashBrowserToolArguments = (args: unknown): string => {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonical(item)).join(',')}]`;
    }

    const record = canonicalArgumentSchema.safeParse(value);

    if (!record.success) {
      return JSON.stringify(value) ?? 'null';
    }

    const keys = Object.keys(record.data).toSorted();

    return `{${keys
      .map(key => `${JSON.stringify(key)}:${canonical(record.data[key])}`)
      .join(',')}}`;
  };
  const text = canonical(args);
  // FNV-1a, kept in one 32-bit lane on purpose: the hash guards a local token, not a signature.
  // Decimal 2_166_136_261 and 16_777_619 are the standard 0x811C9DC5 offset basis and 0x01000193 prime.
  let hash = 2_166_136_261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }

  return `${hash.toString(16)}:${String(text.length)}`;
};

export const stepTokenBindingMatches = (
  stored: StepTokenBinding & { readonly expiresAt: number; readonly reason: string },
  binding: StepTokenBinding
): boolean =>
  stored.session === binding.session &&
  stored.tabId === binding.tabId &&
  stored.toolName === binding.toolName &&
  stored.argumentHash === binding.argumentHash &&
  (stored.element ?? '') === (binding.element ?? '') &&
  stored.origin === binding.origin;

/**
 * The session's sensitive approvals. A token is single use and lives 60 s;
 * an expired token is dropped on read so the store cannot grow without bound
 * after a session stops retrying.
 */
export const createStepTokenStore = ({
  now = Date.now,
  random = () => crypto.randomUUID(),
}: {
  readonly now?: () => number;
  readonly random?: () => string;
} = {}): StepTokenStore => {
  const tokens = new Map<
    string,
    StepTokenBinding & {
      readonly expiresAt: number;
      readonly need?: StepTokenNeed | undefined;
      readonly reason: string;
    }
  >();

  const prune = (): void => {
    const time = now();

    for (const [token, stored] of tokens) {
      if (stored.expiresAt <= time) {
        tokens.delete(token);
      }
    }
  };

  const take: StepTokenStore['take'] = (token, bindings) => {
    prune();

    const stored = tokens.get(token);

    if (stored === undefined) {
      return { ok: false };
    }

    // A token is single use: unless one of the named bindings matches, it is burnt and gone. A replay presenting it
    // Again can therefore never probe for a valid binding.
    tokens.delete(token);

    if (!bindings.some(binding => stepTokenBindingMatches(stored, binding))) {
      return { ok: false };
    }

    return {
      ok: true,
      reason: stored.reason,
      ...(stored.need === undefined ? {} : { need: stored.need }),
    };
  };

  return {
    issue: input => {
      prune();

      const token = random();

      tokens.set(token, {
        argumentHash: input.argumentHash,
        element: input.element,
        expiresAt: now() + STEP_TOKEN_TTL_MS,
        origin: input.origin,
        reason: input.reason,
        session: input.session,
        tabId: input.tabId,
        toolName: input.toolName,
        ...(input.need === undefined ? {} : { need: input.need }),
      });

      return token;
    },
    size: () => {
      prune();

      return tokens.size;
    },
    take,
  };
};

/** Replaces a sensitive field's value wherever it leaked into tool text. */
export const MASKED_VALUE = '[masked]';

export const maskSensitiveValues = (text: string, values: readonly string[]): string =>
  values.reduce((masked, value) => {
    if (value === '') {
      return masked;
    }

    return masked.split(value).join(MASKED_VALUE);
  }, text);

/** The snapshot line shape the masking and hidden-text filters touch. */
export interface AgentSnapshotLine {
  /** Rendered verbatim after the ref, e.g. `[origin withheld: https://example.com]`. */
  readonly attributes?: string;
  readonly depth: number;
  readonly name: string;
  readonly ref?: string;
  readonly role: string;
  readonly textLeaf?: boolean;
}

/**
 * Turns one snapshot line into the agent's view of it: a password/payment
 * field's accessible name becomes `[masked]`, and a text leaf whose exact text
 * the page hid is dropped. Returns `undefined` when the line must disappear.
 */
export const applyAgentSnapshotLine = (
  line: AgentSnapshotLine,
  options: {
    readonly hiddenText: ReadonlySet<string>;
    readonly sensitiveValues: ReadonlySet<string>;
  }
): AgentSnapshotLine | undefined => {
  if (line.textLeaf === true) {
    if (options.hiddenText.has(line.name.trim())) {
      return undefined;
    }

    return options.sensitiveValues.has(line.name.trim()) ? { ...line, name: MASKED_VALUE } : line;
  }

  // A hidden element's own accessible name is hidden text too.
  if (line.name !== '' && options.hiddenText.has(line.name.trim())) {
    return undefined;
  }

  if (options.sensitiveValues.has(line.name.trim())) {
    return { ...line, name: MASKED_VALUE };
  }

  return line;
};
