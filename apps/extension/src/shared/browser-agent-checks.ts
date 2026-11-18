/* eslint-disable max-lines -- One policy module owns grant classes, origin matching, sensitive classification, tokens and masking helpers. */
import { z } from 'zod';

/**
 * What an agent caller may do with an origin. The CLI holds the matching
 * `browser` permission patterns (`read:<origin>`, `act:<origin>`,
 * `navigate:<origin>`) and sends the granted pairs on every call; the
 * extension never decides a grant on its own.
 */
export type BrowserGrantClass = 'read' | 'act' | 'navigate';

/** A file upload always needs a human-approved step token. */
export const isUploadTool = (toolName: string): boolean => toolName === 'browser_file_upload';

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
 * The act tools whose page action can start a download: a click, a dropped or
 * dragged item, a key press (Enter on a focused link), and the two tools that
 * run model-authored code. A tab action, a resize or a dialog answer cannot,
 * so they pay no guard window.
 */
const DOWNLOAD_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_drag',
  'browser_drop',
  'browser_evaluate',
  'browser_press_key',
  'browser_run_code_unsafe',
]);

export const canStartDownload = (toolName: string): boolean => DOWNLOAD_CAPABLE_TOOLS.has(toolName);

/**
 * A refusal for a download-capable call when neither guard can run: the
 * optional `downloads` permission is missing and the tab's target cannot
 * intercept responses either. The switch re-requests the permission, so the
 * message names the one action that fixes it.
 */
export const DOWNLOAD_PERMISSION_MISSING_ERROR =
  'The browser cannot cancel downloads for this agent call: the optional Downloads permission is not granted (blocked). Turn "Allow local agents" off and on again to grant it, then retry.';

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

/** The two tools that run model-authored page code (D11: they need the `act` grant). */
export const isScriptTool = (toolName: string): boolean =>
  toolName === 'browser_evaluate' || toolName === 'browser_run_code_unsafe';
/** A CSS selector that names more than one element: a call that cannot run must not ask for permission. */
export const ambiguousSelectorError = (matches: number): string =>
  `The selector matches ${String(matches)} elements. Use a snapshot ref or a selector that matches one element.`;

export const ORIGIN_CHANGED_ERROR =
  'The page redirected to a different origin than the one this navigation was approved for.';

/** Sensitive reasons, kept short and free of page content so they are safe to show a model. */
export const SENSITIVE_REASON = {
  cardFormSubmit: 'submitting a form with payment fields',
  download: 'downloading a file',
  fileUpload: 'uploading a file',
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

const STEP_TOKEN_TTL_MS = 60_000;

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

export interface StepTokenIssue extends StepTokenBinding {
  readonly reason: string;
}

export interface StepTokenStore {
  /** Issues a single-use token bound to one call; the clock is the store's, not the caller's. */
  readonly issue: (input: StepTokenIssue) => string;
  /** Consumes a token: true only when it names the same call and has not expired. */
  readonly consume: (token: string, binding: StepTokenBinding) => boolean;
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
    StepTokenBinding & { readonly expiresAt: number; readonly reason: string }
  >();

  const prune = (): void => {
    const time = now();

    for (const [token, stored] of tokens) {
      if (stored.expiresAt <= time) {
        tokens.delete(token);
      }
    }
  };

  return {
    consume: (token, binding) => {
      prune();

      const stored = tokens.get(token);

      if (stored === undefined) {
        return false;
      }

      // A token is single use: even a mismatch burns it, so a replay cannot probe for a valid binding.
      tokens.delete(token);

      return stepTokenBindingMatches(stored, binding);
    },
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
      });

      return token;
    },
    size: () => {
      prune();

      return tokens.size;
    },
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
