/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import { LocalAgentRpcError, LOCAL_AGENT_ERROR_CODES } from './jsonrpc';
import type { JsonRpcParams, JsonRpcResult } from './jsonrpc';
import type { LocalAgentControllerRegistry } from './registry';

/*
 * Method dispatch for protocol v1. The browser runtime implements `tools.*`
 * later; everything except session bookkeeping already answers with the error
 * the CLI turns into its setup hint, so no caller hangs.
 */

export type LocalAgentBrowserTools = {
  list(): Promise<JsonRpcResult>;
  call(params: JsonRpcParams): Promise<JsonRpcResult>;
};

export type LocalAgentDispatcher = {
  handle(controllerId: string, method: string, params: JsonRpcParams): Promise<JsonRpcResult>;
};

const sessionOpenSchema = z.object({
  cliVersion: z.string(),
  cwd: z.string(),
  sessionId: z.string().min(1),
  title: z.string(),
});

const sessionCloseSchema = z.object({ sessionHandle: z.uuid() });

/**
 * Injected by the background wiring until the browser runtime replaces it:
 * `tools.list` and `tools.call` report `browser_unavailable`, which is the
 * signal for the CLI's one-time "extension connected" notice.
 */
const unavailableBrowser = () =>
  new LocalAgentRpcError(
    LOCAL_AGENT_ERROR_CODES.browserUnavailable,
    'The browser is not available right now.'
  );

export const createUnavailableBrowserTools = (): LocalAgentBrowserTools => ({
  call: (): Promise<JsonRpcResult> => {
    throw unavailableBrowser();
  },
  list: (): Promise<JsonRpcResult> => {
    throw unavailableBrowser();
  },
});

const unavailable = (): never => {
  throw unavailableBrowser();
};

export const createLocalAgentDispatcher = ({
  registry,
  tools,
}: {
  registry: LocalAgentControllerRegistry;
  tools: LocalAgentBrowserTools;
}): LocalAgentDispatcher => ({
  handle: async (controllerId, method, params) => {
    if (method === 'session.open') {
      const input = sessionOpenSchema.safeParse(params);

      if (!input.success) {
        throw new LocalAgentRpcError(
          LOCAL_AGENT_ERROR_CODES.invalidParams,
          'Invalid session.open parameters.'
        );
      }

      return registry.openSession(controllerId, input.data);
    }

    if (method === 'session.close') {
      const input = sessionCloseSchema.safeParse(params);

      if (!input.success) {
        throw new LocalAgentRpcError(
          LOCAL_AGENT_ERROR_CODES.invalidParams,
          'Invalid session.close parameters.'
        );
      }

      if (!(await registry.closeSession(controllerId, input.data.sessionHandle))) {
        throw new LocalAgentRpcError(
          LOCAL_AGENT_ERROR_CODES.invalidParams,
          'Unknown session handle.'
        );
      }

      return {};
    }

    if (method === 'tools.list') {
      return tools.list();
    }

    if (method === 'tools.call') {
      return tools.call(params);
    }

    if (
      method === 'session.adopt' ||
      method === 'session.shareActiveTab' ||
      method === 'upload.begin' ||
      method === 'upload.chunk' ||
      method === 'upload.end'
    ) {
      return unavailable();
    }

    throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.methodNotFound, 'Unknown method.');
  },
});
