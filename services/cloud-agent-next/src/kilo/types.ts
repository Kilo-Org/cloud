import type { ExecutionSession } from '../types.js';

// ---------------------------------------------------------------------------
// Kilo API types (subset needed by worker-side code)
// Previously imported from shared/kilo-types.ts which has been deleted.
// ---------------------------------------------------------------------------

export type Session = {
  id: string;
  parentID?: string;
  title?: string;
  [key: string]: unknown;
};

export type TextPartInput = {
  type: 'text';
  text: string;
};

export type FilePartInput = {
  type: 'file';
  data: string;
  mimeType: string;
};

export type SessionCommandResponse = unknown;

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

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
  /** Thinking/reasoning effort variant (e.g., "high", "max", "low") */
  variant?: string;
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
