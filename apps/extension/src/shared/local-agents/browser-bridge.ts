/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import {
  AGENT_TAB_OUTSIDE_GROUP_ERROR,
  authorizedGrantsSchema,
  NEEDS_PERMISSION_ERROR,
  ORIGIN_CHANGED_ERROR,
} from '../browser-agent-checks';
import type { BrowserCaller } from '../browser-caller';
import { TAB_BUSY_ERROR, TAB_TAKEN_ERROR } from '../browser-caller';
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
  | 'listSessions'
  | 'openSession'
  | 'releaseCaller'
  | 'runTool'
  | 'shareActiveTab'
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

const unavailable = (): never => {
  throw new LocalAgentRpcError(
    LOCAL_AGENT_ERROR_CODES.browserUnavailable,
    'The browser is not available right now.'
  );
};

/**
 * The background without a tabs API (no browser to drive). Session bookkeeping
 * still works, so the panel can list and stop agents; every tool call reports
 * `browser_unavailable`, the CLI's setup hint.
 */
export const createUnavailableBrowserBridge = (): LocalAgentBrowserBridge => ({
  adopt: () => Promise.resolve({}),
  callTool: () => {
    throw unavailable();
  },
  closeSession: () => Promise.resolve(),
  endSessions: () => Promise.resolve(),
  listTools: () => {
    throw unavailable();
  },
  openSession: () => Promise.resolve(),
  shareActiveTab: () => {
    throw unavailable();
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

const NO_TAB_ERROR =
  'The agent session has no tab yet. Open one, or share the active tab with /browser share.';
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

/**
 * One runtime result as MCP content. A screenshot leaves as an image plus its
 * text line; every other value is the text the tool already produced, and an
 * object value is its JSON so the model sees the same shape the panel does.
 */
const contentOf = (result: Extract<EvalTabResult, { readonly ok: true }>): JsonRpcResult => {
  const value = result.value;

  if (typeof value === 'string') {
    return textContent(value);
  }

  const screenshot = screenshotSchema.safeParse(value);

  if (screenshot.success) {
    const dataUrl = base64DataUrlSchema.safeParse(screenshot.data.dataUrl);
    const data = dataUrl.success ? screenshot.data.dataUrl.slice(dataUrl.data.indexOf(',') + 1) : '';

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

export const createRuntimeBrowserBridge = ({
  activeTabId,
  runtime,
}: {
  /**
   * The browser's active tab in the last focused window. The session targets it
   * when it belongs to the group, so `browser_tabs select` reads back naturally.
   */
  readonly activeTabId?: (() => Promise<number | undefined>) | undefined;
  /**
   * Resolved per call: the service worker builds the runtime on the first agent
   * request instead of on every boot.
   */
  readonly runtime: () => LocalAgentBrowserRuntime;
}): LocalAgentBrowserBridge => {
  /* Sessions the user, a switch-off or a disconnect ended: a late call is `user_stopped`, not a page effect. */
  const ended = new Set<string>();

  const liveSession = (sessionHandle: string) =>
    runtime()
      .listSessions()
      .find(session => session.sessionHandle === sessionHandle && !session.ended);

  const assertLive = (sessionHandle: string): void => {
    if (liveSession(sessionHandle) !== undefined) {
      return;
    }

    throw ended.has(sessionHandle)
      ? new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.userStopped, SESSION_STOPPED_ERROR)
      : new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, SESSION_NOT_OPEN_ERROR);
  };

  /** The tab one call runs on: the active tab when the session owns it, else the newest group tab. */
  const targetTab = async (sessionHandle: string): Promise<number | undefined> => {
    const session = liveSession(sessionHandle);
    const tabs = session?.tabs ?? [];
    const active = activeTabId === undefined ? undefined : await activeTabId();

    if (active !== undefined && tabs.includes(active)) {
      return active;
    }

    return tabs.at(-1);
  };

  const closeOne = async (input: LocalAgentBrowserSessionRef): Promise<void> => {
    ended.add(input.sessionHandle);
    await runtime().closeSession({ sessionHandle: input.sessionHandle });
    // The lease and the caller's refs go with the session; the ended group keeps its tabs.
    runtime().disposeCaller(sessionCaller(input));
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

      const { sessionHandle } = parsed.data;
      const input = { controllerId, sessionHandle };

      assertLive(sessionHandle);

      const tabId = await targetTab(sessionHandle);

      if (tabId === undefined) {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, NO_TAB_ERROR);
      }

      const caller = sessionCaller(input);
      let outcome;

      try {
        outcome = await runtime().runTool({
          agent: {
            authorized: parsed.data.authorized,
            ...(parsed.data.sensitive === undefined ? {} : { sensitive: parsed.data.sensitive }),
          },
          arguments: parsed.data.arguments,
          caller,
          tabId,
          toolName: parsed.data.name,
        });
      } finally {
        // Turn end: the next call re-takes the tab, so the user and the panel are never locked out between calls.
        runtime().releaseCaller(caller);
      }

      // Stop all may have ended the session while the call ran: its page effects are not reported as a live result.
      if (ended.has(sessionHandle)) {
        throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.userStopped, SESSION_STOPPED_ERROR);
      }

      if (outcome.kind === 'needs_permission') {
        throw new LocalAgentRpcError(
          LOCAL_AGENT_ERROR_CODES.needsPermission,
          NEEDS_PERMISSION_ERROR,
          {
            items: outcome.items,
            ...(outcome.stepToken === undefined ? {} : { stepToken: outcome.stepToken }),
          }
        );
      }

      if (outcome.kind === 'origin_changed') {
        throw new LocalAgentRpcError(
          LOCAL_AGENT_ERROR_CODES.originChanged,
          ORIGIN_CHANGED_ERROR,
          { from: outcome.from, to: outcome.to }
        );
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
        case AGENT_TAB_OUTSIDE_GROUP_ERROR: {
          throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.blocked, outcome.result.error);
        }
        default: {
          return {
            content: [{ text: boundBrowserToolText(outcome.result.error), type: 'text' }],
            isError: true,
          };
        }
      }
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
