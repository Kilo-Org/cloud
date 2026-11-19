/* eslint-disable max-lines, typescript-eslint/consistent-type-definitions -- One bridge owns session, call and content translation; AGENTS.md prefers type over interface. */
import { z } from 'zod';
import {
  AGENT_TAB_OUTSIDE_GROUP_ERROR,
  DOWNLOAD_PERMISSION_MISSING_ERROR,
  DOWNLOAD_STEP_TAB_GONE_ERROR,
  authorizedGrantsSchema,
  NEEDS_PERMISSION_ERROR,
  ORIGIN_CHANGED_ERROR,
} from '../browser-agent-checks';
import type { BrowserCaller } from '../browser-caller';
import { TAB_BUSY_ERROR, TAB_TAKEN_ERROR } from '../browser-caller';
import { navigateDestinationCheck, tabsNewDestinationCheck } from '../browser-agent-gate';
import type { BrowserRuntime } from '../browser-runtime';
import { BROWSER_TOOL_CONTRACT } from '../browser-tool-contract';
import { boundBrowserToolText } from '../browser-tool-snapshot';
import type { EvalTabResult } from '../tab-debugger';
import { BROWSER_TOOL_CONTRACT_SHA } from './envelope';
import { LocalAgentRpcError, LOCAL_AGENT_ERROR_CODES } from './jsonrpc';
import type { JsonRpcParams, JsonRpcResult } from './jsonrpc';

/*
 * The bridge between the local-agents transport (`tools.*`, `session.*`) and
 * the browser runtime. One hub session becomes one runtime session: the
 * runtime supplies the caller identity, the tab group (D9/D12), the lease and
 * the agent gate; this module only translates shapes and codes.
 */

/** The runtime slice the bridge drives, so a test can fake one object. */
export type LocalAgentBrowserRuntime = Pick<
  BrowserRuntime,
  | 'adoptEnded'
  | 'closeSession'
  | 'disposeCaller'
  | 'disposeTab'
  | 'listSessions'
  | 'openSession'
  | 'openSessionTab'
  | 'releaseCaller'
  | 'releaseTab'
  | 'runTool'
  | 'shareActiveTab'
  | 'tabInfo'
>;

export type LocalAgentBrowserSessionRef = {
  readonly controllerId: string;
  readonly sessionHandle: string;
};

export type LocalAgentBrowserSessionOpen = LocalAgentBrowserSessionRef & {
  readonly title: string;
};

export type LocalAgentBrowserBridge = {
  /** `/browser adopt`: the newest ended group becomes this session's group. */
  adopt(input: LocalAgentBrowserSessionRef): Promise<JsonRpcResult>;
  /** One `tools.call` through the runtime, with the CLI's grants and step tokens. */
  callTool(controllerId: string, params: JsonRpcParams): Promise<JsonRpcResult>;
  /** `session.close`: the group turns grey and stays adoptable, the lease goes. */
  closeSession(input: LocalAgentBrowserSessionRef): Promise<void>;
  /** Stop all, switch off, disconnect and connection loss end every session they revoke. */
  endSessions(input: readonly LocalAgentBrowserSessionRef[]): Promise<void>;
  listTools(): Promise<JsonRpcResult>;
  /** `session.open`: the runtime learns the session and its title; no tab yet. */
  openSession(input: LocalAgentBrowserSessionOpen): Promise<void>;
  /** `/browser share`: moves the active tab (or the named one) into the group. */
  shareActiveTab(input: LocalAgentBrowserSessionRef): Promise<JsonRpcResult>;
};

const unavailableError = (): LocalAgentRpcError =>
  new LocalAgentRpcError(
    LOCAL_AGENT_ERROR_CODES.browserUnavailable,
    'The browser is not available right now.'
  );

/**
 * The background without a tabs API (no browser to drive). Session bookkeeping
 * still works, so the panel can list and stop agents; every tool call reports
 * `browser_unavailable`, the CLI's setup hint.
 */
export const createUnavailableBrowserBridge = (): LocalAgentBrowserBridge => ({
  adopt: () => Promise.resolve({}),
  callTool: () => {
    throw unavailableError();
  },
  closeSession: () => Promise.resolve(),
  endSessions: () => Promise.resolve(),
  listTools: () => {
    throw unavailableError();
  },
  openSession: () => Promise.resolve(),
  shareActiveTab: () => {
    throw unavailableError();
  },
});

const toolCallSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
  authorized: authorizedGrantsSchema,
  name: z.string().min(1),
  sensitive: z.array(z.string()).optional(),
  sessionHandle: z.string().min(1),
});

const screenshotSchema = z.object({
  dataUrl: z.string(),
  mediaType: z.string(),
  text: z.string(),
});

const base64DataUrlSchema = z.string().regex(/^data:[^,]*;base64,/u);

const argumentStringSchema = z.string().min(1);

const NO_TAB_ERROR = 'This session has no tab yet. Navigate to a page first.';
const NO_DESTINATION_ERROR =
  'A navigate needs an http(s) URL to open this session\u2019s first tab.';
/** Enough recently stopped handles to answer a CLI that raced its own revoke, and nothing more. */
const ENDED_SESSION_LIMIT = 256;
const ENDED_SESSION_TTL_MS = 10 * 60_000;
const NO_ACTIVE_TAB_ERROR = 'The browser has no active tab to share.';
const SESSION_NOT_OPEN_ERROR = 'This agent session is not open.';
const SESSION_STOPPED_ERROR = 'The user stopped this agent session.';

const sessionCaller = ({
  controllerId,
  sessionHandle,
}: LocalAgentBrowserSessionRef): BrowserCaller => ({
  controllerId,
  kind: 'agent',
  sessionHandle,
});

/** The text half of an MCP `CallToolResult`, bounded like every other tool text. */
const textContent = (text: string): JsonRpcResult => ({
  content: [{ text: boundBrowserToolText(text), type: 'text' }],
});

const textValueSchema = z.string();

/** The `_meta` a tool result may carry: withheld-frame lists travel here, not in the model's text. */
const metaSchema = z.record(z.string(), z.unknown());

/**
 * One runtime result as MCP content. A screenshot leaves as an image plus its
 * text line; every other value is the text the tool already produced, and an
 * object value is its JSON so the model sees the same shape the panel does.
 */
const contentOf = (result: Extract<EvalTabResult, { readonly ok: true }>): JsonRpcResult => {
  const { value } = result;
  const text = textValueSchema.safeParse(value);

  if (text.success) {
    return textContent(text.data);
  }

  const screenshot = screenshotSchema.safeParse(value);

  if (screenshot.success) {
    const dataUrl = base64DataUrlSchema.safeParse(screenshot.data.dataUrl);
    const data = dataUrl.success
      ? screenshot.data.dataUrl.slice(dataUrl.data.indexOf(',') + 1)
      : '';

    return {
      content: [
        { data, mimeType: screenshot.data.mediaType, type: 'image' },
        { text: boundBrowserToolText(screenshot.data.text), type: 'text' },
      ],
    };
  }

  if (value === undefined) {
    return textContent(result.description ?? 'Done.');
  }

  return textContent(JSON.stringify(value));
};

/**
 * The navigate a tab-opening call runs. A tab opened *at* the destination would
 * let Chrome start a download the gate never saw, so the url always loads
 * through this guarded navigate on the tab that already exists.
 */
const navigateOf = (
  parsed: z.infer<typeof toolCallSchema>,
  url: string
): z.infer<typeof toolCallSchema> => ({ ...parsed, arguments: { url }, name: 'browser_navigate' });

export const createRuntimeBrowserBridge = ({
  activeTabId,
  now,
  runtime,
}: {
  /**
   * The browser's active tab in the last focused window. The session targets it
   * when it belongs to the group, so `browser_tabs select` reads back naturally.
   */
  readonly activeTabId?: (() => Promise<number | undefined>) | undefined;
  /** The clock the stopped-handle memory expires against; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /**
   * Resolved per call: the service worker builds the runtime on the first agent
   * request instead of on every boot.
   */
  readonly runtime: () => LocalAgentBrowserRuntime;
}): LocalAgentBrowserBridge => {
  const clock = now ?? (() => Date.now());
  /**
   * Sessions the user, a switch-off or a disconnect ended: a late call is
   * `user_stopped`, not a page effect. Bounded by age and size — handles are
   * never reused, so nothing else would ever reclaim them.
   */
  const ended = new Map<string, number>();

  const pruneEnded = (): void => {
    const expiredBefore = clock() - ENDED_SESSION_TTL_MS;

    for (const [handle, stoppedAt] of ended) {
      if (stoppedAt < expiredBefore) {
        ended.delete(handle);
      }
    }

    while (ended.size > ENDED_SESSION_LIMIT) {
      const oldest = ended.keys().next().value;

      if (oldest === undefined) {
        return;
      }

      ended.delete(oldest);
    }
  };

  const markEnded = (sessionHandle: string): void => {
    ended.set(sessionHandle, clock());
    pruneEnded();
  };

  const isEnded = (sessionHandle: string): boolean => {
    pruneEnded();

    return ended.has(sessionHandle);
  };

  const liveSession = (sessionHandle: string) =>
    runtime()
      .listSessions()
      .find(session => session.sessionHandle === sessionHandle && !session.ended);

  const assertLive = (sessionHandle: string): void => {
    if (liveSession(sessionHandle) !== undefined) {
      return;
    }

    throw isEnded(sessionHandle)
      ? new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.userStopped, SESSION_STOPPED_ERROR)
      : new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, SESSION_NOT_OPEN_ERROR);
  };

  /** The tab one call runs on: the active tab when the session owns it, else the newest group tab. */
  const targetTab = async (sessionHandle: string): Promise<number | undefined> => {
    const session = liveSession(sessionHandle);
    const tabs = session?.tabs ?? [];

    // A session with no tab reads nothing: its first tab is one it opens for itself, never the user's.
    if (tabs.length === 0) {
      return undefined;
    }

    const active = activeTabId === undefined ? undefined : await activeTabId();

    if (active !== undefined && tabs.includes(active)) {
      return active;
    }

    return tabs.at(-1);
  };

  const closeOne = async (input: LocalAgentBrowserSessionRef): Promise<void> => {
    markEnded(input.sessionHandle);
    // A closed session owes no approval: the tab it opened is the next session's to adopt.
    await runtime().closeSession({ sessionHandle: input.sessionHandle });
    // The lease and the caller's refs go with the session; the ended group keeps its tabs.
    runtime().disposeCaller(sessionCaller(input));
  };

  /** One tool call on a tab the session already has, mapped onto results and protocol errors. */
  const runOnTab = async (
    parsed: z.infer<typeof toolCallSchema>,
    input: LocalAgentBrowserSessionRef,
    tab: {
      /** The call the model made, when this one is an equivalent the transport runs for it. */
      readonly step?: { readonly arguments: unknown; readonly toolName: string } | undefined;
      /** The tab the call runs on. */
      readonly tabId: number;
    }
  ): Promise<JsonRpcResult> => {
    const { step, tabId } = tab;
    const caller = sessionCaller(input);
    const outcome = await runtime()
      .runTool({
        agent: {
          authorized: parsed.authorized,
          ...(parsed.sensitive === undefined ? {} : { sensitive: parsed.sensitive }),
        },
        arguments: parsed.arguments,
        caller,
        ...(step === undefined ? {} : { step }),
        tabId,
        toolName: parsed.name,
      })
      // Turn end: this call's lease goes, its refs stay, and the session's other tabs keep theirs.
      .finally(() => {
        runtime().releaseTab({ caller, tabId });
      });

    // Stop all may have ended the session while the call ran: its page effects are not reported as a live result.
    if (ended.has(input.sessionHandle)) {
      throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.userStopped, SESSION_STOPPED_ERROR);
    }

    if (outcome.kind === 'needs_permission') {
      throw new LocalAgentRpcError(
        LOCAL_AGENT_ERROR_CODES.needsPermission,
        // The runtime's text names the step to repeat or the file it could not delete; the model reads it.
        outcome.result.ok ? NEEDS_PERMISSION_ERROR : outcome.result.error,
        {
          items: outcome.items,
          // The step the approval is for: the call itself, or the click that started a file a later call reports.
          ...(outcome.step === undefined ? {} : { step: outcome.step }),
          ...(outcome.stepToken === undefined ? {} : { stepToken: outcome.stepToken }),
          // The page already ran: the CLI asks a human and must not replay the call.
          ...(outcome.afterAction === true ? { afterAction: true } : {}),
        }
      );
    }

    if (outcome.kind === 'origin_changed') {
      throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.originChanged, ORIGIN_CHANGED_ERROR, {
        from: outcome.from,
        to: outcome.to,
      });
    }

    if (outcome.kind === 'needs_take_over') {
      // An agent never takes a tab; a held tab is a `tab_busy` after the wait.
      throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.tabBusy, TAB_BUSY_ERROR);
    }

    if (outcome.result.ok) {
      const content = contentOf(outcome.result);

      return outcome.withheldFrames === undefined
        ? content
        : { ...content, _meta: { withheldFrames: [...outcome.withheldFrames] } };
    }

    // Retryable and refusal states carry their own protocol code so the CLI can act on them.
    switch (outcome.result.error) {
      case TAB_BUSY_ERROR: {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.tabBusy, outcome.result.error);
      }
      case TAB_TAKEN_ERROR: {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.tabTaken, outcome.result.error);
      }
      case AGENT_TAB_OUTSIDE_GROUP_ERROR:
      case DOWNLOAD_PERMISSION_MISSING_ERROR:
      case DOWNLOAD_STEP_TAB_GONE_ERROR: {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, outcome.result.error);
      }
      default: {
        return {
          content: [{ text: boundBrowserToolText(outcome.result.error), type: 'text' }],
          isError: true,
        };
      }
    }
  };

  /**
   * The first call of a session with no tab. `browser_navigate` opens its own
   * tab on `about:blank` and then runs through the gate; `browser_tabs new`
   * opens the tab it was asked for directly. Everything else is refused.
   */
  const callOnOwnTab = async (
    parsed: z.infer<typeof toolCallSchema>,
    input: LocalAgentBrowserSessionRef
  ): Promise<JsonRpcResult> => {
    if (parsed.name === 'browser_tabs') {
      const action = argumentStringSchema.safeParse(parsed.arguments['action']);

      if (!action.success || action.data !== 'new') {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, NO_TAB_ERROR);
      }

      // The page tools gate `new` on the destination origin; with no tab to gate on, that check runs here — and a destination no grant can name is refused rather than opened.
      const check = tabsNewDestinationCheck(parsed.arguments, parsed.authorized);

      if (check.kind === 'blocked') {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, check.error);
      }

      if (check.kind === 'needs_permission') {
        throw new LocalAgentRpcError(
          LOCAL_AGENT_ERROR_CODES.needsPermission,
          NEEDS_PERMISSION_ERROR,
          { items: [check.item] }
        );
      }

      const url = argumentStringSchema.safeParse(parsed.arguments['url']);
      const opened = await runtime().openSessionTab({ sessionHandle: input.sessionHandle });

      if (opened === undefined) {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, NO_TAB_ERROR);
      }

      // A tab opened *at* the destination would let Chrome start a download the gate never saw.
      // The url therefore loads through the guarded navigate path; a refused navigate leaves the tab in the session, as an after-action refusal must.
      // The step override keeps the refusal, and the token it issues, bound to the `browser_tabs` call the model repeats.
      const destination = url.success && url.data !== '' ? url.data : undefined;

      const navigated =
        destination === undefined
          ? undefined
          : await runOnTab(navigateOf(parsed, destination), input, {
              step: { arguments: parsed.arguments, toolName: 'browser_tabs' },
              tabId: opened.tabId,
            });

      const info = await runtime().tabInfo(opened.tabId);
      const payload = textContent(
        JSON.stringify({
          selected: true,
          tabId: opened.tabId,
          title: info?.title ?? opened.title,
          // Chrome withholds the url of an `about:blank` tab without the `tabs` permission, so an empty one falls back.
          url: info?.url === undefined || info.url === '' ? opened.url : info.url,
        })
      );

      if (navigated === undefined) {
        return payload;
      }

      // A tab that never loaded its page is the navigation's own answer: its error text is what the model must read.
      if (navigated['isError'] === true) {
        return navigated;
      }

      const meta = metaSchema.safeParse(navigated['_meta']);

      return meta.success ? { ...payload, _meta: meta.data } : payload;
    }

    if (parsed.name !== 'browser_navigate') {
      throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, NO_TAB_ERROR);
    }

    const url = argumentStringSchema.safeParse(parsed.arguments['url']);

    if (!url.success) {
      throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, NO_DESTINATION_ERROR);
    }

    // The gate's navigate check runs first: a refused navigation must not leave a tab behind.
    const check = navigateDestinationCheck(parsed.arguments, parsed.authorized);

    if (check.kind === 'blocked') {
      throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, check.error);
    }

    if (check.kind === 'needs_permission') {
      throw new LocalAgentRpcError(
        LOCAL_AGENT_ERROR_CODES.needsPermission,
        NEEDS_PERMISSION_ERROR,
        { items: [check.item] }
      );
    }

    // The tab opens blank and is grouped first, then the call navigates it under the download guard.
    // A tab opened at the destination would let Chrome start a download before the gate ran, and an attachment never loads a document.
    const opened = await runtime().openSessionTab({ sessionHandle: input.sessionHandle });

    if (opened === undefined) {
      throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, NO_TAB_ERROR);
    }

    return runOnTab(parsed, input, { tabId: opened.tabId });
  };

  return {
    adopt: async input => {
      ended.delete(input.sessionHandle);
      await runtime().adoptEnded({ sessionHandle: input.sessionHandle });

      return {};
    },

    callTool: async (controllerId, params) => {
      const parsed = toolCallSchema.safeParse(params);

      if (!parsed.success) {
        throw new LocalAgentRpcError(
          LOCAL_AGENT_ERROR_CODES.invalidParams,
          'Invalid tools.call parameters.'
        );
      }

      const input = { controllerId, sessionHandle: parsed.data.sessionHandle };

      assertLive(input.sessionHandle);

      const existing = await targetTab(input.sessionHandle);

      // An agent gets its own tab rather than taking the user's; only the two tools that can start one do.
      if (existing === undefined) {
        return callOnOwnTab(parsed.data, input);
      }

      // A repeat of a refused `browser_tabs new` carries its token, and the runtime drives the tab that step opened.
      return runOnTab(parsed.data, input, { tabId: existing });
    },

    closeSession: closeOne,

    endSessions: async sessions => {
      await Promise.all(sessions.map(session => closeOne(session)));
    },

    listTools: () =>
      Promise.resolve({
        contractSha: BROWSER_TOOL_CONTRACT_SHA,
        tools: BROWSER_TOOL_CONTRACT.map(tool => ({
          inputSchema: tool.inputSchema,
          name: tool.name,
          readOnly: tool.readOnly,
        })),
      }),

    openSession: async input => {
      ended.delete(input.sessionHandle);
      await runtime().openSession({
        controllerId: input.controllerId,
        sessionHandle: input.sessionHandle,
        title: input.title,
      });
    },

    shareActiveTab: async input => {
      assertLive(input.sessionHandle);

      const shared = await runtime().shareActiveTab({ sessionHandle: input.sessionHandle });

      if (shared.tabId === 0) {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, NO_ACTIVE_TAB_ERROR);
      }

      return {
        tabId: shared.tabId,
        ...(shared.groupId === undefined ? {} : { groupId: shared.groupId }),
      };
    },
  };
};
