import { logToFile } from './utils.js';
import type {
  Session,
  SessionCommandResponse,
  TextPartInput,
} from '../../src/shared/kilo-types.js';

// Re-export types that callers may need
export type { Session, SessionCommandResponse };

/**
 * Message part structure for sending messages.
 * Uses TextPartInput from kilo types for compatibility.
 */
export type MessagePart = TextPartInput;

/**
 * Options for creating a session.
 */
export type CreateSessionOptions = {
  /** Parent session ID for branching */
  parentID?: string;
  /** Session title */
  title?: string;
};

/**
 * Options for sending a prompt.
 */
export type SendPromptOptions = {
  /** The session ID to send the prompt to */
  sessionId: string;
  /** Message ID - kilo will use this ID for the message */
  messageId?: string;
  /** The prompt text (shorthand for parts with single text) */
  prompt?: string;
  /** Full parts array (takes precedence over prompt) */
  parts?: MessagePart[];
  /** Agent mode (e.g., 'code', 'architect', 'ask') */
  agent?: string;
  /** Model configuration */
  model?: { providerID?: string; modelID: string };
  /** Don't wait for AI reply - just queue the message */
  noReply?: boolean;
  /** Custom system prompt override */
  system?: string;
  /** Enable/disable specific tools */
  tools?: Record<string, boolean>;
};

/**
 * Options for aborting a session.
 */
export type AbortSessionOptions = {
  sessionId: string;
};

/**
 * Options for sending a command.
 */
export type SendCommandOptions = {
  sessionId: string;
  command: string;
  args?: string;
};

/**
 * Permission response type.
 */
export type PermissionResponse = 'always' | 'once' | 'reject';

/**
 * Client for interacting with a kilo serve instance.
 */
export type KiloClient = {
  /** List all sessions */
  listSessions: () => Promise<Session[]>;
  /** Create a new session */
  createSession: (opts?: CreateSessionOptions) => Promise<Session>;
  /** Get a session by ID */
  getSession: (sessionId: string) => Promise<Session>;
  /** Send a prompt asynchronously (returns immediately, results via SSE) */
  sendPromptAsync: (opts: SendPromptOptions) => Promise<void>;
  /** Abort a running session */
  abortSession: (opts: AbortSessionOptions) => Promise<boolean>;
  /** Check server health */
  checkHealth: () => Promise<{ healthy: boolean; version: string }>;
  /** Send a command (slash command) to a session */
  sendCommand: (opts: SendCommandOptions) => Promise<SessionCommandResponse>;
  /** Answer a permission request */
  answerPermission: (permissionId: string, response: PermissionResponse) => Promise<boolean>;
  /** Answer a question */
  answerQuestion: (questionId: string, answers: string[]) => Promise<boolean>;
  /** Reject a question */
  rejectQuestion: (questionId: string) => Promise<boolean>;
};

/**
 * Create a client for interacting with a kilo serve instance.
 */
export function createKiloClient(baseUrl: string): KiloClient {
  /**
   * Make HTTP request and return Response.
   * Shared by requestJson and requestNoContent.
   */
  async function makeRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${baseUrl}${path}`;
    logToFile(`kilo-client ${method} ${path}`);

    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`kilo API error: ${response.status} ${response.statusText} - ${text}`);
    }

    return response;
  }

  /**
   * Make HTTP request expecting JSON response.
   */
  async function requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await makeRequest(method, path, body);
    return response.json() as Promise<T>;
  }

  /**
   * Make HTTP request expecting no content (204).
   */
  async function requestNoContent(method: string, path: string, body?: unknown): Promise<void> {
    await makeRequest(method, path, body);
  }

  return {
    checkHealth: () => requestJson<{ healthy: boolean; version: string }>('GET', '/global/health'),

    listSessions: () => requestJson<Session[]>('GET', '/session'),

    createSession: (opts?: CreateSessionOptions) =>
      requestJson<Session>('POST', '/session', {
        parentID: opts?.parentID,
        title: opts?.title,
      }),

    getSession: (sessionId: string) => requestJson<Session>('GET', `/session/${sessionId}`),

    sendPromptAsync: async (opts: SendPromptOptions) => {
      // Build parts array from either parts or prompt
      const parts: MessagePart[] =
        opts.parts ?? (opts.prompt ? [{ type: 'text', text: opts.prompt }] : []);

      if (parts.length === 0) {
        throw new Error('sendPromptAsync requires either parts or prompt');
      }

      await requestNoContent('POST', `/session/${opts.sessionId}/prompt_async`, {
        parts,
        messageID: opts.messageId,
        agent: opts.agent,
        model: opts.model
          ? {
              providerID: opts.model.providerID ?? 'kilo',
              modelID: opts.model.modelID,
            }
          : undefined,
        noReply: opts.noReply,
        system: opts.system,
        tools: opts.tools,
      });
    },

    abortSession: (opts: AbortSessionOptions) =>
      requestJson<boolean>('POST', `/session/${opts.sessionId}/abort`),

    sendCommand: async (opts: SendCommandOptions) => {
      // Commands are sent via POST /session/:sessionId/command
      return requestJson<SessionCommandResponse>('POST', `/session/${opts.sessionId}/command`, {
        command: opts.command,
        args: opts.args,
      });
    },

    answerPermission: async (permissionId: string, response: PermissionResponse) => {
      // Permission replies go to POST /permission/:permissionId/reply
      await requestNoContent('POST', `/permission/${permissionId}/reply`, { response });
      return true;
    },

    answerQuestion: async (questionId: string, answers: string[]) => {
      // Question answers go to POST /question/:questionId/reply
      await requestNoContent('POST', `/question/${questionId}/reply`, { answers });
      return true;
    },

    rejectQuestion: async (questionId: string) => {
      // Question rejections go to POST /question/:questionId/reject
      await requestNoContent('POST', `/question/${questionId}/reject`, {});
      return true;
    },
  };
}
