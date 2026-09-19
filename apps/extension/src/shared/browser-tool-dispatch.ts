import { BROWSER_TOOL_CONTRACT, KILO_BROWSER_TOOL_PREFIX } from './browser-tool-contract';
import type { BrowserToolContractEntry } from './browser-tool-contract';
import {
  INTERACT_BROWSER_TOOL_NAMES,
  runInteractBrowserTool,
} from './browser-tool-interact-actions';
import { PAGE_BROWSER_TOOL_NAMES, runPageBrowserTool } from './browser-tool-page-actions';
import type {
  BrowserToolPageActionOptions,
  BrowserToolPageActionSession,
  BrowserToolPageTabsApi,
} from './browser-tool-page-actions';
import { READ_BROWSER_TOOL_NAMES, runReadBrowserTool } from './browser-tool-read-actions';
import type { BrowserReadToolOptions } from './browser-tool-read-actions';
import type { BrowserToolPageSession } from './browser-tool-snapshot';
import type { BrowserToolInteractSession } from './browser-tool-interact-actions';
import type { BrowserToolSession } from './browser-tool-session';
import type { EvalTabResult } from './tab-debugger';
import { z } from 'zod';

/**
 * The session slice the dispatch hands to every handler family: the read
 * tools' page session, the page/lifecycle tools' session (dialog, dispose,
 * file chooser), the session's own platform gate and the backend selector
 * with its `callTool` entry point. The family handlers speak the debugger
 * protocol, so on the scripting backend they are unreachable; `backend` /
 * `callTool` let the dispatch route there instead. A full `BrowserToolSession`
 * from the session module factory satisfies it structurally, so the
 * background can pass the factory product unchanged.
 */
export type BrowserToolDispatchSession = BrowserToolPageSession &
  BrowserToolInteractSession &
  BrowserToolPageActionSession &
  Pick<BrowserToolSession, 'backend' | 'callTool' | 'getToolUnavailableError'>;

/**
 * Per-call options the dispatch forwards to the handler families: the agent's
 * target tab and the tabs API for the page/lifecycle tools, the read tools'
 * clock override, and the WebMCP runtime hooks for the two WebMCP tools.
 */
export interface BrowserToolDispatchOptions {
  readonly now?: () => number;
  readonly tabId?: number;
  readonly tabsApi?: BrowserToolPageTabsApi;
  readonly webMcpDiscover?: BrowserToolPageActionOptions['webMcpDiscover'];
  readonly webMcpExecute?: BrowserToolPageActionOptions['webMcpExecute'];
}

/**
 * One upstream browser tool's handler: verbatim arguments, the session and
 * the dispatch options. Every handler resolves to an `EvalTabResult` — the
 * families never reject; the dispatch additionally nets unexpected throws.
 */
export type BrowserToolHandler = (
  args: Record<string, unknown>,
  session: BrowserToolDispatchSession,
  options: BrowserToolDispatchOptions
) => Promise<EvalTabResult>;

const dispatchArgumentsSchema = z.record(z.string(), z.unknown());

const toUpstreamToolName = (name: string): string =>
  name.startsWith(KILO_BROWSER_TOOL_PREFIX) ? name.slice(KILO_BROWSER_TOOL_PREFIX.length) : name;

const readToolOptions = (options: BrowserToolDispatchOptions): BrowserReadToolOptions =>
  options.now === undefined ? {} : { now: options.now };

const pageToolOptions = (options: BrowserToolDispatchOptions): BrowserToolPageActionOptions => ({
  ...(options.now === undefined ? {} : { now: options.now }),
  ...(options.tabId === undefined ? {} : { tabId: options.tabId }),
  ...(options.tabsApi === undefined ? {} : { tabsApi: options.tabsApi }),
  ...(options.webMcpDiscover === undefined ? {} : { webMcpDiscover: options.webMcpDiscover }),
  ...(options.webMcpExecute === undefined ? {} : { webMcpExecute: options.webMcpExecute }),
});

const readEntries: [string, BrowserToolHandler][] = READ_BROWSER_TOOL_NAMES.map(name => [
  name,
  (args, session, options) => runReadBrowserTool(name, args, session, readToolOptions(options)),
]);

const interactEntries: [string, BrowserToolHandler][] = INTERACT_BROWSER_TOOL_NAMES.map(name => [
  name,
  (args, session) => runInteractBrowserTool(name, args, session),
]);

const pageEntries: [string, BrowserToolHandler][] = PAGE_BROWSER_TOOL_NAMES.map(name => [
  name,
  (args, session, options) => runPageBrowserTool(name, args, session, pageToolOptions(options)),
]);

/**
 * One handler per upstream `browser_*` tool, keyed by the upstream name. The
 * read, interact and page families each contribute their tools; the page
 * family's cross-frame `browser_webmcp_list` overrides the read family's
 * main-frame variant, which is what collapses 8 + 8 + 11 family entries onto
 * the contract's 26 tools.
 */
export const BROWSER_TOOL_HANDLERS: Record<string, BrowserToolHandler> = Object.fromEntries([
  ...readEntries,
  ...interactEntries,
  ...pageEntries,
]);

export interface BrowserToolHandlerCoverage {
  /** Contract tools no handler implements. */
  readonly contractToolsWithoutHandler: readonly string[];
  /** Handlers no contract entry names. */
  readonly handlersWithoutContract: readonly string[];
}

/** Coverage both ways: every contract entry has a handler and no handler lacks one. */
export const getBrowserToolHandlerCoverage = (): BrowserToolHandlerCoverage => {
  const contractNames = BROWSER_TOOL_CONTRACT.map(entry => entry.name);
  const handlerNames = Object.keys(BROWSER_TOOL_HANDLERS);

  return {
    contractToolsWithoutHandler: contractNames.filter(name => !(name in BROWSER_TOOL_HANDLERS)),
    handlersWithoutContract: handlerNames.filter(name => !contractNames.includes(name)),
  };
};

/**
 * Throws when the dispatch registry and the generated contract drifted apart,
 * so a contract change without a handler (or the reverse) fails loudly.
 */
export const assertBrowserToolHandlerCoverage = (): void => {
  const coverage = getBrowserToolHandlerCoverage();

  if (
    coverage.contractToolsWithoutHandler.length === 0 &&
    coverage.handlersWithoutContract.length === 0
  ) {
    return;
  }

  throw new Error(
    `Browser tool handler coverage is incomplete. Contract tools without a handler: ${
      coverage.contractToolsWithoutHandler.join(', ') || '(none)'
    }. Handlers without a contract entry: ${coverage.handlersWithoutContract.join(', ') || '(none)'}.`
  );
};

/**
 * Validates verbatim tool arguments against the generated contract schema:
 * every required field present and — the upstream schemas all set
 * `additionalProperties: false` — no unknown fields. The handler families
 * parse value types and per-tool rules themselves; this gate is what stops a
 * tool from bypassing the contract.
 */
const validateBrowserToolArguments = (
  toolName: string,
  entry: BrowserToolContractEntry,
  args: Record<string, unknown>
): string | undefined => {
  const problems: string[] = [];

  for (const field of entry.inputSchema.required ?? []) {
    if (!Object.hasOwn(args, field)) {
      problems.push(`missing required argument "${field}"`);
    }
  }

  if (!entry.inputSchema.additionalProperties) {
    for (const field of Object.keys(args)) {
      if (!Object.hasOwn(entry.inputSchema.properties, field)) {
        problems.push(`unknown argument "${field}"`);
      }
    }
  }

  return problems.length === 0
    ? undefined
    : `Invalid arguments for ${toolName}: ${problems.join('; ')}.`;
};

const contractEntryFor = (upstreamName: string): BrowserToolContractEntry | undefined =>
  BROWSER_TOOL_CONTRACT.find(entry => entry.name === upstreamName);

export interface RunKiloBrowserToolInput {
  /** The model's verbatim tool arguments; absent arguments are treated as `{}`. */
  readonly arguments?: unknown;
  readonly options?: BrowserToolDispatchOptions | undefined;
  /** A session from the browser-tool session module factory. */
  readonly session: BrowserToolDispatchSession;
  /** The model-facing `kilo_browser_*` name, or the upstream `browser_*` one. */
  readonly toolName: string;
}

/**
 * Dispatches one browser tool: looks the handler up in the registry, gates on
 * the session's platform availability, validates the arguments against the
 * contract schema and runs the handler. Returns `{ ok: true, value }` or
 * `{ ok: false, error }` — a missing handler, a validation failure naming the
 * tool and the offending field, or a thrown handler error are all tool
 * errors, never a rejection.
 */
export const runKiloBrowserTool = async ({
  arguments: args,
  options,
  session,
  toolName,
}: RunKiloBrowserToolInput): Promise<EvalTabResult> => {
  const upstreamName = toUpstreamToolName(toolName);
  const handler = BROWSER_TOOL_HANDLERS[upstreamName];
  const entry = contractEntryFor(upstreamName);

  if (handler === undefined || entry === undefined) {
    return { error: `Unknown browser tool: ${toolName}.`, ok: false };
  }

  const unavailableError = session.getToolUnavailableError(toolName);

  if (unavailableError !== undefined) {
    return { error: unavailableError, ok: false };
  }

  const parsedArgs = dispatchArgumentsSchema.safeParse(args ?? {});

  if (!parsedArgs.success) {
    return { error: `Invalid arguments for ${toolName}: arguments must be an object.`, ok: false };
  }

  const validationError = validateBrowserToolArguments(toolName, entry, parsedArgs.data);

  if (validationError !== undefined) {
    return { error: validationError, ok: false };
  }

  try {
    /*
     * The family handlers drive `session.send`, whose scripting backend throws
     * unconditionally (Firefox exposes no debugger protocol). Where the session
     * factory selected the scripting backend, the only reachable
     * implementation of the expressible tools is `session.callTool`, so the
     * contract-validated arguments go there. The platform gate above has
     * already refused the tools Firefox cannot express.
     */
    if (session.backend === 'scripting') {
      return await session.callTool(toolName, parsedArgs.data);
    }

    return await handler(parsedArgs.data, session, options ?? {});
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : `Kilo browser tool failed: ${String(error)}`,
      ok: false,
    };
  }
};
