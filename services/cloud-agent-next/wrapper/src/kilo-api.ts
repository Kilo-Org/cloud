/**
 * Adapter between the wrapper and the @kilocode/sdk client.
 *
 * Provides a stable `WrapperKiloClient` interface that all wrapper modules use.
 * Session and event subscription methods use the v1 SDK client (passed in from
 * main.ts, which uses createKilo() from the root @kilocode/sdk). Methods only
 * available in the v2 API (permission reply, question reply/reject, commit
 * message) use a v2 client created internally from the same server URL.
 */

import type { KiloClient as SDKClient } from '@kilocode/sdk';
import { createKiloClient as createV2Client } from '@kilocode/sdk/v2';
import { logToFile } from './utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KiloServerHandle = {
  url: string;
  close: () => void;
};

/**
 * Permission response type.
 */
export type PermissionResponse = 'always' | 'once' | 'reject';

/**
 * The wrapper's unified kilo client interface.
 * All wrapper modules depend on this type rather than the raw SDK client.
 */
export type WrapperKiloClient = {
  createSession: (opts?: { title?: string }) => Promise<{ id: string }>;
  getSession: (sessionId: string) => Promise<{ id: string }>;
  sendPromptAsync: (opts: {
    sessionId: string;
    messageId?: string;
    parts?: Array<{ type: string; text: string }>;
    prompt?: string;
    variant?: string;
    agent?: string;
    model?: { providerID?: string; modelID: string };
    system?: string;
    tools?: Record<string, boolean>;
  }) => Promise<void>;
  abortSession: (opts: { sessionId: string }) => Promise<boolean>;
  sendCommand: (opts: { sessionId: string; command: string; args?: string }) => Promise<unknown>;
  answerPermission: (permissionId: string, response: PermissionResponse) => Promise<boolean>;
  answerQuestion: (questionId: string, answers: string[][]) => Promise<boolean>;
  rejectQuestion: (questionId: string) => Promise<boolean>;
  getSessionStatuses: () => Promise<Record<string, { type: string; [key: string]: unknown }>>;
  getQuestions: () => Promise<
    Array<{ id: string; sessionID: string; tool?: { messageID: string; callID: string } }>
  >;
  getPermissions: () => Promise<
    Array<{
      id: string;
      sessionID: string;
      permission: string;
      patterns: string[];
      metadata: Record<string, unknown>;
      always: string[];
      tool?: { messageID: string; callID: string };
    }>
  >;
  generateCommitMessage: (opts: { path: string }) => Promise<{ message: string }>;

  /** The underlying SDK client — used directly by connection.ts for event subscription */
  readonly sdkClient: SDKClient;
  /** The in-process server URL — for diagnostics */
  readonly serverUrl: string;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a WrapperKiloClient. Session/event operations use the v1 sdkClient
 * (from createKilo()). Permission/question/commitMessage operations use a v2
 * client created from the same server URL, since those APIs are only available
 * in the v2 SDK.
 */
export function createWrapperKiloClient(
  sdkClient: SDKClient,
  serverUrl: string
): WrapperKiloClient {
  logToFile(`creating wrapper kilo client for ${serverUrl}`);
  const v2Client = createV2Client({ baseUrl: serverUrl });

  return {
    sdkClient,
    serverUrl,

    createSession: async opts => {
      const result = await sdkClient.session.create({
        body: { title: opts?.title },
      });
      if (!result.data) {
        throw new Error('Session create returned no data');
      }
      return { id: result.data.id };
    },

    getSession: async sessionId => {
      const result = await sdkClient.session.get({
        path: { id: sessionId },
      });
      if (!result.data) {
        throw new Error(`Session get returned no data for ${sessionId}`);
      }
      return { id: result.data.id };
    },

    sendPromptAsync: async opts => {
      const textParts: Array<{ type: 'text'; text: string }> = (
        opts.parts ?? (opts.prompt ? [{ type: 'text', text: opts.prompt }] : [])
      ).map(p => ({ type: 'text' as const, text: p.text }));
      // Use v2 client — it supports `variant` (thinking effort); v1 SDK omits it.
      await v2Client.session.promptAsync({
        sessionID: opts.sessionId,
        ...(opts.messageId !== undefined ? { messageID: opts.messageId } : {}),
        parts: textParts,
        ...(opts.variant ? { variant: opts.variant } : {}),
        ...(opts.model
          ? {
              model: {
                providerID: opts.model.providerID ?? 'kilo',
                modelID: opts.model.modelID,
              },
            }
          : {}),
        ...(opts.system ? { system: opts.system } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
      });
    },

    abortSession: async opts => {
      await sdkClient.session.abort({ path: { id: opts.sessionId } });
      return true;
    },

    sendCommand: async opts => {
      const result = await sdkClient.session.command({
        path: { id: opts.sessionId },
        body: {
          command: opts.command,
          arguments: opts.args ?? '',
        },
      });
      return result.data;
    },

    answerPermission: async (permissionId, response) => {
      await v2Client.permission.reply({ requestID: permissionId, reply: response });
      return true;
    },

    answerQuestion: async (questionId, answers) => {
      await v2Client.question.reply({ requestID: questionId, answers });
      return true;
    },

    rejectQuestion: async questionId => {
      await v2Client.question.reject({ requestID: questionId });
      return true;
    },

    getSessionStatuses: async () => {
      const result = await v2Client.session.status();
      return (result.data ?? {}) as Record<string, { type: string; [key: string]: unknown }>;
    },

    getQuestions: async () => {
      const result = await v2Client.question.list();
      return (result.data ?? []) as Array<{
        id: string;
        sessionID: string;
        tool?: { messageID: string; callID: string };
      }>;
    },

    getPermissions: async () => {
      const result = await v2Client.permission.list();
      return (result.data ?? []) as Array<{
        id: string;
        sessionID: string;
        permission: string;
        patterns: string[];
        metadata: Record<string, unknown>;
        always: string[];
        tool?: { messageID: string; callID: string };
      }>;
    },

    generateCommitMessage: async opts => {
      const result = await v2Client.commitMessage.generate({ path: opts.path });
      return result.data ?? { message: '' };
    },
  };
}
