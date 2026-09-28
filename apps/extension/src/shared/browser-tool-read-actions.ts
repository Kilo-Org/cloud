/* eslint-disable max-lines -- One module owns the read-only browser tools; the shared helpers keep their shapes consistent. */
import { z } from 'zod';
import {
  MAX_BROWSER_TOOL_FIND_CONTEXT_LINES,
  boundBrowserToolText,
  captureBrowserAriaSnapshot,
  caughtMessage,
  describeUnsupportedFilename,
  readPageString,
  readPageText,
  readPageTimeOrigin,
  renderBrowserAriaSnapshotLine,
} from './browser-tool-snapshot';
import type { BrowserAriaSnapshotLine, BrowserToolPageSession } from './browser-tool-snapshot';
import type { EvalTabResult } from './tab-debugger';
import type { BrowserConsoleMessage, BrowserNetworkRequest } from './browser-tool-session';

/**
 * The eight upstream Playwright MCP read-only tools (`readOnlyHint: true`),
 * the whole safe-mode browser surface. Names are upstream names (no `kilo_`
 * prefix); the executor maps a model-facing `kilo_browser_*` call onto one.
 */
export const READ_BROWSER_TOOL_NAMES = [
  'browser_console_messages',
  'browser_find',
  'browser_network_request',
  'browser_network_requests',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_webmcp_list',
] as const;

export type ReadBrowserToolName = (typeof READ_BROWSER_TOOL_NAMES)[number];

const READ_BROWSER_TOOL_NAME_SET: ReadonlySet<string> = new Set(READ_BROWSER_TOOL_NAMES);
const KILO_BROWSER_TOOL_PREFIX = 'kilo_';

const toUpstreamToolName = (name: string): string =>
  name.startsWith(KILO_BROWSER_TOOL_PREFIX) ? name.slice(KILO_BROWSER_TOOL_PREFIX.length) : name;

export const isReadBrowserToolName = (name: string): name is ReadBrowserToolName =>
  READ_BROWSER_TOOL_NAME_SET.has(name);

/** Clock, pause and timeout overrides so `browser_wait_for` is testable without real waits. */
export interface BrowserReadToolOptions {
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly waitTimeoutMs?: number;
}

export interface BrowserReadActionDeps extends BrowserReadToolOptions {
  readonly session: BrowserToolPageSession;
}

export type BrowserReadActionHandler = (
  arguments_: Record<string, unknown>,
  deps: BrowserReadActionDeps
) => Promise<EvalTabResult>;

/** The screenshot value: the image the caller gates on `supportsImages`, plus its text line. */
export interface BrowserToolScreenshotValue {
  readonly dataUrl: string;
  readonly mediaType: string;
  readonly text: string;
}

/** Playwright MCP's default timeout for a text wait, in milliseconds. */
export const DEFAULT_BROWSER_TOOL_WAIT_TIMEOUT_MS = 5000;
/** Poll cadence for a text wait. */
export const BROWSER_TOOL_WAIT_POLL_INTERVAL_MS = 100;
/** `browser_wait_for` never sleeps longer than a minute, whatever `time` asks. */
export const MAX_BROWSER_TOOL_WAIT_SECONDS = 60;
/** `browser_find` reports at most this many matches. */
export const MAX_BROWSER_TOOL_FIND_MATCHES = 20;
/** Characters of `browser_network_request` `response-body` output. */
export const MAX_BROWSER_TOOL_RESPONSE_BODY_LENGTH = 20_000;

const CONSOLE_LEVELS = ['debug', 'info', 'warning', 'error'] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];
// Each level includes the more severe ones, so a message is kept when its rank is at least the requested rank.
const CONSOLE_LEVEL_RANK = {
  debug: 0,
  error: 3,
  info: 1,
  warning: 2,
} satisfies Record<ConsoleLevel, number>;

const STATIC_RESOURCE_TYPES = new Set([
  'Font',
  'Image',
  'Media',
  'Manifest',
  'Script',
  'SignedExchange',
  'Stylesheet',
  'TextTrack',
]);

const ALL_NETWORK_REQUEST_PARTS = [
  'request-headers',
  'request-body',
  'response-headers',
  'response-body',
] as const;

const browserSnapshotArgumentsSchema = z.object({
  boxes: z.boolean().optional(),
  depth: z.number().optional(),
  filename: z.string().optional(),
  target: z.string().optional(),
});
const browserFindArgumentsSchema = z.object({
  regex: z.string().optional(),
  text: z.string().optional(),
});
const browserTakeScreenshotArgumentsSchema = z.object({
  element: z.string().optional(),
  filename: z.string().optional(),
  fullPage: z.boolean().optional(),
  scale: z.enum(['css', 'device']).optional(),
  target: z.string().optional(),
  type: z.enum(['png', 'jpeg', 'webp']).optional(),
});
const browserWaitForArgumentsSchema = z.object({
  text: z.string().optional(),
  textGone: z.string().optional(),
  time: z.number().optional(),
});
const browserConsoleMessagesArgumentsSchema = z.object({
  all: z.boolean().optional(),
  filename: z.string().optional(),
  level: z.enum(CONSOLE_LEVELS).optional(),
});
const browserNetworkRequestsArgumentsSchema = z.object({
  filename: z.string().optional(),
  filter: z.string().optional(),
  static: z.boolean().optional(),
});
const browserNetworkRequestArgumentsSchema = z.object({
  filename: z.string().optional(),
  index: z.number().int().optional(),
  number: z.number().int().optional(),
  part: z.enum(ALL_NETWORK_REQUEST_PARTS).optional(),
  requestId: z.string().optional(),
});
const browserWebMcpListArgumentsSchema = z.object({});

const screenshotDataSchema = z.object({ data: z.string() });
const boxModelSchema = z.object({
  model: z
    .object({
      content: z.array(z.number()).optional(),
      height: z.number().optional(),
      width: z.number().optional(),
    })
    .optional(),
});
const elementClipSchema = z.object({
  height: z.number(),
  width: z.number(),
  // eslint-disable-next-line id-length -- CDP `clip` fields are named x and y
  x: z.number(),
  // eslint-disable-next-line id-length -- CDP `clip` fields are named x and y
  y: z.number(),
});
const responseBodySchema = z.object({
  base64Encoded: z.boolean().optional(),
  body: z.string().optional(),
});
const webMcpListResultSchema = z.object({
  tools: z.array(
    z.object({
      description: z.string().optional(),
      name: z.string().optional(),
      title: z.string().optional(),
    })
  ),
});

const fail = (error: string): EvalTabResult => ({ error, ok: false });
const done = (text: string): EvalTabResult => ({ ok: true, value: text });

const invalidArguments = (name: string, error: z.ZodError): EvalTabResult =>
  fail(
    `Invalid arguments for ${name}: ${error.issues
      .map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('; ')}.`
  );

const defaultSleep = (milliseconds: number): Promise<void> =>
  // eslint-disable-next-line promise/avoid-new -- a plain timer has no promise-returning primitive to defer to
  new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds);
  });

const getPause = (deps: BrowserReadActionDeps): ((milliseconds: number) => Promise<void>) =>
  deps.sleep ?? defaultSleep;

const getNow = (deps: BrowserReadActionDeps): (() => number) => deps.now ?? Date.now;

const getWaitTimeout = (deps: BrowserReadActionDeps): number =>
  deps.waitTimeoutMs ?? DEFAULT_BROWSER_TOOL_WAIT_TIMEOUT_MS;

const formatSeconds = (milliseconds: number): string => (milliseconds / 1000).toFixed(1);

/**
 * Playwright's `getByText` matches case-insensitively and ignores whitespace
 * differences. Both the scripting backend (`page.hasText`/`normText`) and this
 * debugger path normalize the same way, so the two backends of
 * `browser_wait_for` agree on what text is present.
 */
const normalizePageText = (value: string): string =>
  value.replaceAll(/\s+/gu, ' ').trim().toLowerCase();

const filenameNote = (filename: string | undefined): string =>
  filename === undefined ? '' : `\n\n${describeUnsupportedFilename(filename)}`;

/**
 * Poll `condition` until it is true or the deadline passes. Returns the elapsed
 * milliseconds when the condition held, undefined on timeout.
 */
const waitForCondition = async (
  deps: BrowserReadActionDeps,
  condition: () => Promise<boolean>,
  timeoutMs: number
): Promise<number | undefined> => {
  const now = getNow(deps);
  const pause = getPause(deps);
  const pollInterval = deps.pollIntervalMs ?? BROWSER_TOOL_WAIT_POLL_INTERVAL_MS;
  const start = now();

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling a page condition is inherently sequential
    if (await condition()) {
      return now() - start;
    }

    const elapsed = now() - start;

    if (elapsed >= timeoutMs) {
      return undefined;
    }

    // eslint-disable-next-line no-await-in-loop -- polling a page condition is inherently sequential
    await pause(Math.max(1, Math.min(pollInterval, timeoutMs - elapsed)));
  }
};

/**
 * CDP `Runtime.consoleAPICalled` types and `Log.entryAdded` levels mapped onto
 * the four Playwright MCP levels. `console.log()` arrives as type `log`, so it
 * ranks as `info` (the default filter must show it); only `debug`/`verbose`
 * stay at the bottom rank.
 */
const normalizeConsoleLevel = (raw: string): ConsoleLevel => {
  const lower = raw.toLowerCase();

  if (lower === 'error') {
    return 'error';
  }

  if (lower === 'warning' || lower === 'warn') {
    return 'warning';
  }

  if (lower === 'info' || lower === 'log') {
    return 'info';
  }

  return 'debug';
};

/** The current document's navigation start, or undefined when the page cannot report it. */
const readNavigationTimeOrigin = async (
  session: BrowserToolPageSession
): Promise<number | undefined> => {
  try {
    return await readPageTimeOrigin(session);
  } catch {
    // The page kept no navigation timing; fall back to the whole buffer rather than failing the read.
    return undefined;
  }
};

/**
 * Console messages since the last navigation by default. `Runtime.Timestamp` is
 * milliseconds since the epoch, and `performance.timeOrigin` is the current
 * document's navigation start on the same clock, so messages older than the
 * current document are dropped. A message without a timestamp is kept rather
 * than silently lost.
 */
const filterConsoleMessages = async (
  session: BrowserToolPageSession,
  messages: readonly BrowserConsoleMessage[],
  options: {
    readonly all: boolean;
    readonly level: ConsoleLevel;
  }
): Promise<BrowserConsoleMessage[]> => {
  const minimumRank = CONSOLE_LEVEL_RANK[options.level];
  const timeOrigin = options.all ? undefined : await readNavigationTimeOrigin(session);

  return messages.filter(message => {
    if (CONSOLE_LEVEL_RANK[normalizeConsoleLevel(message.level)] < minimumRank) {
      return false;
    }

    if (timeOrigin === undefined || message.timestamp === undefined) {
      return true;
    }

    return message.timestamp >= timeOrigin;
  });
};

const formatConsoleMessage = (message: BrowserConsoleMessage): string => {
  const level = normalizeConsoleLevel(message.level);
  const url = message.url === undefined ? '' : ` (${message.url})`;

  return `[${level}] ${message.text}${url}`;
};

const isStaticRequest = (request: BrowserNetworkRequest): boolean =>
  request.resourceType !== undefined && STATIC_RESOURCE_TYPES.has(request.resourceType);

const isSuccessfulStatus = (status: number | undefined): boolean =>
  status !== undefined && status >= 200 && status < 400;

/**
 * The status rendered in the numbered request list: an empty string while the
 * request is still pending, ` failed: ...` when it failed, otherwise the
 * status code and reason phrase.
 */
const formatLoadStatus = (request: BrowserNetworkRequest): string => {
  if (request.failure !== undefined) {
    return ` failed: ${request.failure}`;
  }

  if (request.status === undefined) {
    return '';
  }

  return ` ${String(request.status)}${request.statusText === undefined ? '' : ` ${request.statusText}`}`;
};

/** The same status for one request's detail view, where "pending" is spelled out. */
const formatDetailStatus = (request: BrowserNetworkRequest): string => {
  if (request.failure !== undefined) {
    return `failed: ${request.failure}`;
  }

  if (request.status === undefined) {
    return '(pending)';
  }

  return `${String(request.status)}${request.statusText === undefined ? '' : ` ${request.statusText}`}`;
};

const formatNetworkRequestLine = (request: BrowserNetworkRequest, position: number): string => {
  const method = request.method ?? 'GET';
  const type = request.resourceType === undefined ? '' : ` [${request.resourceType}]`;
  const status = formatLoadStatus(request);
  const mime = request.mimeType === undefined ? '' : ` (${request.mimeType})`;

  return `${String(position)}. ${method} ${request.url}${type}${status}${mime}`;
};

const formatHeaders = (headers: Readonly<Record<string, string>> | undefined): string => {
  if (headers === undefined) {
    return '(none)';
  }

  const entries = Object.entries(headers);

  return entries.length === 0
    ? '(none)'
    : entries.map(([name, value]) => `  ${name}: ${value}`).join('\n');
};

const positionOf = (
  request: BrowserNetworkRequest,
  requests: readonly BrowserNetworkRequest[]
): number => {
  const index = requests.findIndex(candidate => candidate.requestId === request.requestId);

  return index === -1 ? 0 : index + 1;
};

// eslint-disable-next-line max-params -- the four positional values keep every call site's intent obvious
const requestPartText = async (
  session: BrowserToolPageSession,
  request: BrowserNetworkRequest,
  part: (typeof ALL_NETWORK_REQUEST_PARTS)[number],
  position: number
): Promise<string> => {
  if (part === 'request-headers') {
    return formatHeaders(request.requestHeaders);
  }

  if (part === 'request-body') {
    return request.postData === undefined || request.postData === '' ? '(none)' : request.postData;
  }

  if (part === 'response-headers') {
    return formatHeaders(request.responseHeaders);
  }

  const parsed = responseBodySchema.safeParse(
    await session.send('Network.getResponseBody', { requestId: request.requestId })
  );
  const body = parsed.success ? parsed.data.body : undefined;

  if (body === undefined) {
    throw new Error(`The response body for request #${String(position)} is not available.`);
  }

  const text = parsed.success && parsed.data.base64Encoded === true ? `(base64) ${body}` : body;

  return text.length > MAX_BROWSER_TOOL_RESPONSE_BODY_LENGTH
    ? `${text.slice(0, MAX_BROWSER_TOOL_RESPONSE_BODY_LENGTH)}... (body truncated)`
    : text;
};

const formatRequestDetails = (request: BrowserNetworkRequest, position: number): string => {
  const status = formatDetailStatus(request);

  return [
    `Request #${String(position)}: ${request.method ?? 'GET'} ${request.url}`,
    `Status: ${status}`,
    `Resource type: ${request.resourceType ?? '(unknown)'}`,
    `MIME type: ${request.mimeType ?? '(unknown)'}`,
    'Request headers:',
    formatHeaders(request.requestHeaders),
    'Response headers:',
    formatHeaders(request.responseHeaders),
    `Request body: ${request.postData === undefined || request.postData === '' ? '(none)' : request.postData}`,
  ].join('\n');
};

const findableLineText = (line: BrowserAriaSnapshotLine): string => {
  if (line.textLeaf === true) {
    return line.name;
  }

  return line.name === '' ? line.role : `${line.role} ${line.name}`;
};

/**
 * Accepts a plain pattern or Playwright's `/pattern/flags` form. A plain text
 * search is case-insensitive; a regex keeps its own flags (upstream semantics).
 * The `g`/`y` flags are dropped because matching is a per-line `test`, and a
 * stateful `lastIndex` would skip every other matching line.
 */
const buildFindPattern = (query: string, { literal }: { readonly literal: boolean }): RegExp => {
  const slashWrapped = /^\/(.*)\/([dgimsuvy]*)$/su.exec(query);

  if (!literal && slashWrapped !== null && slashWrapped[1] !== undefined) {
    const flags = (slashWrapped[2] ?? '').replaceAll(/[gy]/gu, '');

    return new RegExp(slashWrapped[1], flags);
  }

  if (literal) {
    return new RegExp(query.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`), 'iu');
  }

  return new RegExp(query, 'u');
};

/** `undefined` when the query is not a valid pattern, so the tool reports an argument error. */
const compileFindPattern = (
  query: string,
  options: { readonly literal: boolean }
): RegExp | undefined => {
  try {
    return buildFindPattern(query, options);
  } catch {
    return undefined;
  }
};

const collectAncestors = (
  lines: readonly BrowserAriaSnapshotLine[],
  index: number
): BrowserAriaSnapshotLine[] => {
  const ancestors: BrowserAriaSnapshotLine[] = [];
  const match = lines[index];

  if (match === undefined) {
    return ancestors;
  }

  let { depth } = match;

  for (let cursor = index - 1; cursor >= 0 && depth > 0; cursor--) {
    const line = lines[cursor];

    if (line !== undefined) {
      const { depth: lineDepth } = line;

      if (lineDepth < depth) {
        ancestors.unshift(line);
        depth = lineDepth;
      }
    }
  }

  return ancestors;
};

const describeFindLine = (line: BrowserAriaSnapshotLine): string => {
  if (line.textLeaf === true) {
    return `text '${line.name}'`;
  }

  return line.name === '' ? line.role : `${line.role} '${line.name}'`;
};

const renderFindSnippet = (lines: readonly BrowserAriaSnapshotLine[], index: number): string => {
  const match = lines[index];

  if (match === undefined) {
    return '';
  }

  const ancestors = collectAncestors(lines, index);
  const following = lines.slice(index + 1, index + 1 + MAX_BROWSER_TOOL_FIND_CONTEXT_LINES);
  const path = [...ancestors, match].map(line => describeFindLine(line)).join(' > ');

  return `Path: ${path}\n${[...ancestors, match, ...following]
    .map(line => renderBrowserAriaSnapshotLine(line))
    .join('\n')}`;
};

const browserSnapshotHandler: BrowserReadActionHandler = async (arguments_, deps) => {
  const parsed = browserSnapshotArgumentsSchema.safeParse(arguments_);

  if (!parsed.success) {
    return invalidArguments('browser_snapshot', parsed.error);
  }

  const capture = await captureBrowserAriaSnapshot(deps.session, parsed.data);

  return done(boundBrowserToolText(`${capture.text}${filenameNote(parsed.data.filename)}`));
};

const browserFindHandler: BrowserReadActionHandler = async (arguments_, deps) => {
  const parsed = browserFindArgumentsSchema.safeParse(arguments_);

  if (!parsed.success) {
    return invalidArguments('browser_find', parsed.error);
  }

  const { regex, text } = parsed.data;

  if (text === undefined && regex === undefined) {
    return fail('Invalid arguments for browser_find: provide either text or regex.');
  }

  if (text !== undefined && regex !== undefined) {
    return fail('Invalid arguments for browser_find: provide either text or regex, not both.');
  }

  const pattern = compileFindPattern(regex ?? text ?? '', { literal: text !== undefined });

  if (pattern === undefined) {
    return fail(
      `Invalid arguments for browser_find: "${regex ?? text ?? ''}" is not a valid regular expression.`
    );
  }

  const capture = await captureBrowserAriaSnapshot(deps.session, {});
  const matches: number[] = [];

  for (const [index, line] of capture.lines.entries()) {
    if (pattern.test(findableLineText(line))) {
      matches.push(index);
    }

    if (matches.length >= MAX_BROWSER_TOOL_FIND_MATCHES) {
      break;
    }
  }

  if (matches.length === 0) {
    return done(`No matches for "${text ?? regex ?? ''}" in the current page snapshot.`);
  }

  const sections = matches.map(index => renderFindSnippet(capture.lines, index));

  return done(
    boundBrowserToolText(
      `Found ${String(matches.length)} match(es) for "${text ?? regex ?? ''}".\n\n${sections.join('\n\n')}`
    )
  );
};

const readElementClip = async (
  session: BrowserToolPageSession,
  target: string
): Promise<z.infer<typeof elementClipSchema>> => {
  const resolved = await session.resolveTarget(target);

  if (resolved === undefined) {
    throw new Error(
      `No element matched target "${target}". Take a fresh snapshot and use a ref from it.`
    );
  }

  const command =
    resolved.kind === 'ref'
      ? { backendNodeId: resolved.backendNodeId }
      : { nodeId: resolved.nodeId };
  const parsed = boxModelSchema.safeParse(await session.send('DOM.getBoxModel', command));
  const model = parsed.success ? parsed.data.model : undefined;
  const content = model?.content;

  if (model === undefined || content === undefined || content.length < 2) {
    throw new Error(`Target "${target}" has no layout box to capture.`);
  }

  return elementClipSchema.parse({
    height: model.height ?? 0,
    width: model.width ?? 0,
    // eslint-disable-next-line id-length -- CDP `clip` fields are named x and y
    x: content[0] ?? 0,
    // eslint-disable-next-line id-length -- CDP `clip` fields are named x and y
    y: content[1] ?? 0,
  });
};

const SCREENSHOT_MEDIA_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} satisfies Record<'jpeg' | 'png' | 'webp', string>;

const screenshotMediaType = (type: 'jpeg' | 'png' | 'webp'): string => SCREENSHOT_MEDIA_TYPES[type];

const inferScreenshotType = (
  type: 'jpeg' | 'png' | 'webp' | undefined,
  filename: string | undefined
): 'jpeg' | 'png' | 'webp' => {
  if (type !== undefined) {
    return type;
  }

  const extension = filename?.toLowerCase().split('.').pop();

  if (extension === 'jpg' || extension === 'jpeg') {
    return 'jpeg';
  }

  return extension === 'webp' ? 'webp' : 'png';
};

const browserTakeScreenshotHandler: BrowserReadActionHandler = async (arguments_, deps) => {
  const parsed = browserTakeScreenshotArgumentsSchema.safeParse(arguments_);

  if (!parsed.success) {
    return invalidArguments('browser_take_screenshot', parsed.error);
  }

  const { filename, fullPage, target } = parsed.data;
  const type = inferScreenshotType(parsed.data.type, filename);

  if (fullPage === true && target !== undefined && target !== '') {
    return fail(
      'Invalid arguments for browser_take_screenshot: fullPage and target cannot be combined; capture either the full page or one element.'
    );
  }

  const clip =
    target === undefined || target === '' ? undefined : await readElementClip(deps.session, target);
  const response = await deps.session.send('Page.captureScreenshot', {
    format: type,
    ...(clip === undefined ? {} : { clip: { ...clip, scale: 1 } }),
    ...(fullPage === true ? { captureBeyondViewport: true } : {}),
  });
  const shot = screenshotDataSchema.safeParse(response);

  if (!shot.success) {
    return fail('The browser did not return screenshot data.');
  }

  const mediaType = screenshotMediaType(type);
  const viewportScope = fullPage === true ? 'full page' : 'viewport';
  const scope = clip === undefined ? viewportScope : `element ${String(target)}`;
  const text = boundBrowserToolText(
    `Screenshot captured (${type}, ${scope}).${filenameNote(filename)}`
  );

  const value: BrowserToolScreenshotValue = {
    dataUrl: `data:${mediaType};base64,${shot.data.data}`,
    mediaType,
    text,
  };

  return { ok: true, value };
};

const browserWaitForHandler: BrowserReadActionHandler = async (arguments_, deps) => {
  const parsed = browserWaitForArgumentsSchema.safeParse(arguments_);

  if (!parsed.success) {
    return invalidArguments('browser_wait_for', parsed.error);
  }

  const { text, textGone, time } = parsed.data;

  if (time === undefined && text === undefined && textGone === undefined) {
    return fail('Invalid arguments for browser_wait_for: provide time, text, or textGone.');
  }

  const notes: string[] = [];

  if (time !== undefined) {
    const milliseconds = Math.min(Math.max(time, 0), MAX_BROWSER_TOOL_WAIT_SECONDS) * 1000;

    await getPause(deps)(milliseconds);
    notes.push(`Waited ${formatSeconds(milliseconds)} seconds.`);
  }

  const timeoutMs = getWaitTimeout(deps);

  if (text !== undefined) {
    const elapsed = await waitForCondition(
      deps,
      async () => {
        const pageText = await readPageText(deps.session);

        return normalizePageText(pageText).includes(normalizePageText(text));
      },
      timeoutMs
    );

    if (elapsed === undefined) {
      return fail(
        `Timed out waiting for text "${text}" after ${formatSeconds(timeoutMs)} seconds.`
      );
    }

    notes.push(`Text "${text}" appeared after ${formatSeconds(elapsed)} seconds.`);
  }

  if (textGone !== undefined) {
    const elapsed = await waitForCondition(
      deps,
      async () => {
        const pageText = await readPageText(deps.session);

        return !normalizePageText(pageText).includes(normalizePageText(textGone));
      },
      timeoutMs
    );

    if (elapsed === undefined) {
      return fail(
        `Timed out waiting for text "${textGone}" to disappear after ${formatSeconds(timeoutMs)} seconds.`
      );
    }

    notes.push(`Text "${textGone}" disappeared after ${formatSeconds(elapsed)} seconds.`);
  }

  return done(notes.join(' '));
};

const browserConsoleMessagesHandler: BrowserReadActionHandler = async (arguments_, deps) => {
  const parsed = browserConsoleMessagesArgumentsSchema.safeParse(arguments_);

  if (!parsed.success) {
    return invalidArguments('browser_console_messages', parsed.error);
  }

  const messages = await filterConsoleMessages(deps.session, deps.session.consoleMessages(), {
    all: parsed.data.all === true,
    level: parsed.data.level ?? 'info',
  });

  if (messages.length === 0) {
    return done(`No console messages.${filenameNote(parsed.data.filename)}`);
  }

  return done(
    boundBrowserToolText(
      `${messages.map(message => formatConsoleMessage(message)).join('\n')}${filenameNote(parsed.data.filename)}`
    )
  );
};

// eslint-disable-next-line require-await -- the request buffer is read synchronously; the handler interface is async
const browserNetworkRequestsHandler: BrowserReadActionHandler = async (arguments_, deps) => {
  const parsed = browserNetworkRequestsArgumentsSchema.safeParse(arguments_);

  if (!parsed.success) {
    return invalidArguments('browser_network_requests', parsed.error);
  }

  const rawFilter = parsed.data.filter;
  const filter =
    rawFilter === undefined || rawFilter === ''
      ? undefined
      : compileFindPattern(rawFilter, { literal: false });

  if (rawFilter !== undefined && rawFilter !== '' && filter === undefined) {
    return fail(
      `Invalid arguments for browser_network_requests: "${rawFilter}" is not a valid filter regular expression.`
    );
  }

  // The session bounds the list at the current page load (the last main-frame Document request).
  // Every request keeps its position in that full list, so the number printed here resolves in browser_network_request whichever filter was used.
  const requests = deps.session.networkRequestsSinceLoad();
  const shown = requests.filter(request => {
    if (
      parsed.data.static !== true &&
      isStaticRequest(request) &&
      isSuccessfulStatus(request.status)
    ) {
      return false;
    }

    return filter === undefined || filter.test(request.url);
  });

  if (shown.length === 0) {
    return done(`No network requests.${filenameNote(parsed.data.filename)}`);
  }

  return done(
    boundBrowserToolText(
      `${shown
        .map(request => formatNetworkRequestLine(request, positionOf(request, requests)))
        .join('\n')}${filenameNote(parsed.data.filename)}`
    )
  );
};

const browserNetworkRequestHandler: BrowserReadActionHandler = async (arguments_, deps) => {
  const parsed = browserNetworkRequestArgumentsSchema.safeParse(arguments_);

  if (!parsed.success) {
    return invalidArguments('browser_network_request', parsed.error);
  }

  // Numbers match browser_network_requests: both index the full since-load list, so a static request is reachable too.
  const requests = deps.session.networkRequestsSinceLoad();
  const { index, number, part, requestId } = parsed.data;
  const position = index ?? number;

  const byPosition = position === undefined ? undefined : requests[position - 1];
  const request =
    requestId === undefined
      ? byPosition
      : requests.find(candidate => candidate.requestId === requestId);

  if (request === undefined) {
    return fail(
      position === undefined
        ? `Request "${String(requestId ?? '')}" is not in the current list.`
        : `No request #${String(position)}. The list has ${String(requests.length)} request(s).`
    );
  }

  const resolvedPosition = position ?? positionOf(request, requests);
  const text =
    part === undefined
      ? formatRequestDetails(request, resolvedPosition)
      : `${part} for request #${String(resolvedPosition)}:\n${await requestPartText(deps.session, request, part, resolvedPosition)}`;

  return done(boundBrowserToolText(`${text}${filenameNote(parsed.data.filename)}`));
};

/**
 * Page-injected WebMCP discovery, following the injected page-helper contract:
 * a self-contained function string evaluated in the page and returning JSON.
 * It reads the main frame only; cross-frame discovery needs the scripting path.
 */
const DOM_WEB_MCP_LIST_FUNCTION = `(async function () {
  var ctx = document.modelContext;
  if (!ctx || typeof ctx.getTools !== 'function') { return JSON.stringify({ tools: [] }); }
  var tools = await ctx.getTools();
  if (!Array.isArray(tools)) { return JSON.stringify({ tools: [] }); }
  var out = [];
  for (var index = 0; index < tools.length && index < 128; index++) {
    var tool = tools[index] || {};
    out.push({
      description: String(tool.description || ''),
      name: String(tool.name || ''),
      title: String(tool.title || '')
    });
  }
  return JSON.stringify({ tools: out });
})()`;

const browserWebMcpListHandler: BrowserReadActionHandler = async (arguments_, deps) => {
  const parsed = browserWebMcpListArgumentsSchema.safeParse(arguments_);

  if (!parsed.success) {
    return invalidArguments('browser_webmcp_list', parsed.error);
  }

  const raw = await readPageString(deps.session, DOM_WEB_MCP_LIST_FUNCTION);
  const listed = webMcpListResultSchema.safeParse(raw === undefined ? undefined : JSON.parse(raw));

  if (!listed.success) {
    return fail('The page did not return a WebMCP tool list.');
  }

  if (listed.data.tools.length === 0) {
    return done('No WebMCP tools.');
  }

  const lines = listed.data.tools.map((tool, index) => {
    const name = tool.name ?? '(unnamed)';
    const title = tool.title === undefined || tool.title === '' ? '' : ` — ${tool.title}`;
    const description =
      tool.description === undefined || tool.description === '' ? '' : `: ${tool.description}`;

    return `${String(index + 1)}. ${name}${title}${description}`;
  });

  return done(
    boundBrowserToolText(`WebMCP tools (${String(listed.data.tools.length)}):\n${lines.join('\n')}`)
  );
};

export const BROWSER_READ_ACTION_HANDLERS = {
  browser_console_messages: browserConsoleMessagesHandler,
  browser_find: browserFindHandler,
  browser_network_request: browserNetworkRequestHandler,
  browser_network_requests: browserNetworkRequestsHandler,
  browser_snapshot: browserSnapshotHandler,
  browser_take_screenshot: browserTakeScreenshotHandler,
  browser_wait_for: browserWaitForHandler,
  browser_webmcp_list: browserWebMcpListHandler,
} satisfies Record<ReadBrowserToolName, BrowserReadActionHandler>;

/**
 * Dispatch one read-only browser tool. The session is attached first so a gone
 * or uninspectable tab reports its error for every tool, never a silent empty
 * result, and every failure becomes a tool error rather than a rejected turn.
 */
// eslint-disable-next-line max-params -- the dispatcher mirrors the executor's call shape: name, verbatim arguments, session, overrides
export const runReadBrowserTool = async (
  name: string,
  arguments_: Record<string, unknown>,
  session: BrowserToolPageSession,
  options: BrowserReadToolOptions = {}
): Promise<EvalTabResult> => {
  const upstreamName = toUpstreamToolName(name);

  if (!isReadBrowserToolName(upstreamName)) {
    return fail(`Unknown read-only browser tool: ${name}.`);
  }

  try {
    await session.attach();

    return await BROWSER_READ_ACTION_HANDLERS[upstreamName](arguments_, { ...options, session });
  } catch (error) {
    return fail(
      boundBrowserToolText(caughtMessage(error instanceof Error ? error : String(error)))
    );
  }
};
