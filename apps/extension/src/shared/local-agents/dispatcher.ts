/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import type { LocalAgentBrowserBridge } from './browser-bridge';
import { LocalAgentRpcError, LOCAL_AGENT_ERROR_CODES } from './jsonrpc';
import type { JsonRpcParams, JsonRpcResult } from './jsonrpc';
import type { LocalAgentControllerRegistry } from './registry';

/*
 * Method dispatch for protocol v1. Session bookkeeping lives in the registry
 * (the panel's connected-agents list); everything that touches a tab, a lease
 * or the agent gate goes through the browser bridge, so one session handle
 * reaches exactly the tabs its own session group holds.
 */

export type LocalAgentDispatcher = {
  handle(controllerId: string, method: string, params: JsonRpcParams): Promise<JsonRpcResult>;
};

const sessionOpenSchema = z.object({
  cliVersion: z.string(),
  cwd: z.string(),
  sessionId: z.string().min(1),
  title: z.string(),
});

const sessionHandleSchema = z.object({ sessionHandle: z.uuid() });

const toolCallSessionSchema = z.object({ sessionHandle: z.string().min(1) });

const invalidParams = (message: string): LocalAgentRpcError =>
  new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.invalidParams, message);

export const createLocalAgentDispatcher = ({
  bridge,
  registry,
}: {
  bridge: LocalAgentBrowserBridge;
  registry: LocalAgentControllerRegistry;
}): LocalAgentDispatcher => {
  /** A session handle is usable only by the controller that opened it. */
  const ownedBy = async (controllerId: string, sessionHandle: string): Promise<void> => {
    if ((await registry.sessionOwner(sessionHandle)) !== controllerId) {
      throw invalidParams('Unknown session handle.');
    }
  };

  return {
    handle: async (controllerId, method, params) => {
      if (method === 'session.open') {
        const input = sessionOpenSchema.safeParse(params);

        if (!input.success) {
          throw invalidParams('Invalid session.open parameters.');
        }

        const { sessionHandle } = await registry.openSession(controllerId, input.data);

        try {
          await bridge.openSession({ controllerId, sessionHandle, title: input.data.title });
        } catch (error) {
          // No half-open session in the panel's list when the browser cannot take one.
          await registry.closeSession(controllerId, sessionHandle);
          throw error;
        }

        return { sessionHandle };
      }

      if (method === 'session.close') {
        const input = sessionHandleSchema.safeParse(params);

        if (!input.success) {
          throw invalidParams('Invalid session.close parameters.');
        }

        await ownedBy(controllerId, input.data.sessionHandle);

        if (!(await registry.closeSession(controllerId, input.data.sessionHandle))) {
          throw invalidParams('Unknown session handle.');
        }

        await bridge.closeSession({ controllerId, sessionHandle: input.data.sessionHandle });

        return {};
      }

      if (method === 'session.adopt' || method === 'session.shareActiveTab') {
        const input = sessionHandleSchema.safeParse(params);

        if (!input.success) {
          throw invalidParams(`Invalid ${method} parameters.`);
        }

        const ref = { controllerId, sessionHandle: input.data.sessionHandle };

        await ownedBy(controllerId, ref.sessionHandle);

        return method === 'session.adopt' ? bridge.adopt(ref) : bridge.shareActiveTab(ref);
      }

      if (method === 'tools.list') {
        return bridge.listTools();
      }

      if (method === 'tools.call') {
        const input = toolCallSessionSchema.safeParse(params);

        if (!input.success) {
          throw invalidParams('Invalid tools.call parameters.');
        }

        await ownedBy(controllerId, input.data.sessionHandle);

        return bridge.callTool(controllerId, params);
      }

      if (method === 'upload.begin' || method === 'upload.chunk' || method === 'upload.end') {
        // The extension's browser_file_upload uses the page's own file chooser; the hub upload path is not served.
        throw new LocalAgentRpcError(
          LOCAL_AGENT_ERROR_CODES.unsupportedInBrowser,
          'File upload transfer is not supported by this browser.'
        );
      }

      throw new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.methodNotFound, 'Unknown method.');
    },
  };
};
