import type { ExecutionSession } from '../types.js';

export type {
  Session,
  AssistantMessage,
  Part,
  TextPartInput,
  FilePartInput,
  SessionCommandResponse,
} from '../shared/kilo-types.js';

export interface KiloClientOptions {
  session: ExecutionSession;
  port: number;
  /** Request timeout in seconds (default: 10) */
  timeoutSeconds?: number;
}

export interface HealthResponse {
  healthy: boolean;
  version: string;
}

export interface CreateSessionOptions {
  parentId?: string;
  title?: string;
}

export interface PromptOptions {
  messageId?: string;
  model?: { providerID?: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  /** Custom system prompt override */
  system?: string;
  /** Enable/disable specific tools (e.g., { "read": true, "write": false }) */
  tools?: Record<string, boolean>;
}

export interface CommandOptions {
  messageId?: string;
  agent?: string;
  /** Model ID string (e.g., "anthropic/claude-sonnet-4-20250514") */
  model?: string;
}

export interface SummarizeOptions {
  providerID?: string;
  modelID: string;
}

export type PermissionResponse = 'once' | 'always' | 'reject';
