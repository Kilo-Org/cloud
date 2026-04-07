/**
 * Shared types for the DO ↔ Wrapper HTTP protocol.
 *
 * These types are the single source of truth for request/response shapes
 * exchanged between the Worker/DO side (`src/kilo/wrapper-client.ts`) and
 * the wrapper side (`wrapper/src/server.ts`).
 */

// ---------------------------------------------------------------------------
// Execution Binding — connection auth for streaming events back to the DO
// ---------------------------------------------------------------------------

export type ExecutionBinding = {
  /** Execution ID — presence triggers per-execution setup in shared-sandbox mode */
  executionId?: string;
  /** WebSocket URL to DO's ingest endpoint */
  ingestUrl: string;
  /** Token for ingest WS authentication (typically the executionId) */
  ingestToken: string;
  /** Kilocode auth token forwarded for wrapper-side operations */
  workerAuthToken: string;
};

// ---------------------------------------------------------------------------
// Prompt / Command payloads
// ---------------------------------------------------------------------------

export type PromptPayload = {
  prompt?: string;
  parts?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  model?: { providerID?: string; modelID: string };
  variant?: string;
  agent?: string;
  messageId?: string;
  system?: string;
  tools?: Record<string, boolean>;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  execution?: ExecutionBinding;
  /** Upstream branch for auto-commit target */
  upstreamBranch?: string;
};

export type CommandPayload = {
  command: string;
  args?: string;
  execution?: ExecutionBinding;
};
