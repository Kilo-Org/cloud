import { z } from 'zod';

// ── Agent roles (mirrors worker types) ──────────────────────────────────

export const AgentRole = z.enum(['mayor', 'polecat', 'refinery', 'witness']);
export type AgentRole = z.infer<typeof AgentRole>;

// ── Control server request/response schemas ─────────────────────────────

export const StartAgentRequest = z.object({
  agentId: z.string(),
  rigId: z.string(),
  townId: z.string(),
  role: AgentRole,
  name: z.string(),
  identity: z.string(),
  prompt: z.string(),
  model: z.string(),
  systemPrompt: z.string(),
  gitUrl: z.string(),
  branch: z.string(),
  defaultBranch: z.string(),
  envVars: z.record(z.string(), z.string()).optional(),
});
export type StartAgentRequest = z.infer<typeof StartAgentRequest>;

export const MergeRequest = z.object({
  rigId: z.string(),
  branch: z.string(),
  targetBranch: z.string(),
  gitUrl: z.string(),
  entryId: z.string(),
  beadId: z.string(),
  agentId: z.string(),
  callbackUrl: z.string().optional(),
  envVars: z.record(z.string(), z.string()).optional(),
});
export type MergeRequest = z.infer<typeof MergeRequest>;

export type MergeResult = {
  status: 'merged' | 'conflict';
  message: string;
  commitSha?: string;
};

export const StopAgentRequest = z.object({
  signal: z.enum(['SIGTERM', 'SIGKILL']).optional(),
});
export type StopAgentRequest = z.infer<typeof StopAgentRequest>;

export const SendMessageRequest = z.object({
  prompt: z.string(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

// ── Agent lifecycle ─────────────────────────────────────────────────────

export const AgentStatus = z.enum(['starting', 'running', 'stopping', 'exited', 'failed']);
export type AgentStatus = z.infer<typeof AgentStatus>;

// Kept for backward compat — external callers (DO, heartbeat) still reference this name.
export const ProcessStatus = AgentStatus;
export type ProcessStatus = AgentStatus;

/**
 * Tracks a managed agent: a kilo serve session backed by an SSE subscription.
 * Replaces the old AgentProcess (raw child process + stdin pipe).
 */
export type ManagedAgent = {
  agentId: string;
  rigId: string;
  townId: string;
  role: AgentRole;
  name: string;
  status: AgentStatus;
  /** Port of the kilo serve instance this agent's session lives on */
  serverPort: number;
  /** Session ID within the kilo serve instance */
  sessionId: string;
  /** Working directory (git worktree) */
  workdir: string;
  startedAt: string;
  lastActivityAt: string;
  /** Last known active tool calls (populated from SSE events) */
  activeTools: string[];
  /** Total messages sent to this agent */
  messageCount: number;
  /** Exit reason if status is 'exited' or 'failed' */
  exitReason: string | null;
  /** Gastown worker API URL for completion callbacks */
  gastownApiUrl: string | null;
  /** Agent-scoped JWT for authenticating callbacks to the Gastown worker */
  gastownSessionToken: string | null;
  /** Override the default completion callback URL (for agents not backed by a Rig DO) */
  completionCallbackUrl: string | null;
};

export type AgentStatusResponse = {
  agentId: string;
  status: AgentStatus;
  serverPort: number;
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  activeTools: string[];
  messageCount: number;
  exitReason: string | null;
};

export type HealthResponse = {
  status: 'ok' | 'degraded';
  agents: number;
  servers: number;
  uptime: number;
};

// ── Kilo serve instance ─────────────────────────────────────────────────

export type KiloServerInstance = {
  /** Port the kilo serve process is listening on */
  port: number;
  /** Working directory (project root) the server was started in */
  workdir: string;
  /** The Bun subprocess handle */
  process: import('bun').Subprocess;
  /** Agent IDs with sessions on this server */
  sessionIds: Set<string>;
  /** Tracks whether the server is healthy (responded to /global/health) */
  healthy: boolean;
};

// ── Kilo serve API response schemas ──────────────────────────────────────

/** POST /session, GET /session/:id */
export const KiloSession = z.object({
  id: z.string(),
  title: z.string().optional(),
});
export type KiloSession = z.infer<typeof KiloSession>;

/** GET /global/health */
export const KiloHealthResponse = z.object({
  healthy: z.boolean(),
  version: z.string(),
});
export type KiloHealthResponse = z.infer<typeof KiloHealthResponse>;

// ── SSE events ──────────────────────────────────────────────────────────

/**
 * Known kilo serve SSE event types as a Zod discriminated union.
 *
 * Each variant carries a `sessionID` so consumers can filter events by
 * session when multiple sessions share a single kilo serve instance.
 */

const SSESessionEvent = z.object({
  type: z.enum(['session.completed', 'session.idle', 'session.updated']),
  properties: z
    .object({
      sessionID: z.string(),
    })
    .passthrough(),
});

const SSEMessageEvent = z.object({
  type: z.enum(['message.created', 'message.completed', 'message.updated', 'message_part.updated']),
  properties: z
    .object({
      sessionID: z.string(),
    })
    .passthrough(),
});

const SSEAssistantEvent = z.object({
  type: z.enum(['assistant.completed']),
  properties: z
    .object({
      sessionID: z.string(),
    })
    .passthrough(),
});

const SSEErrorEvent = z.object({
  type: z.enum(['payment_required', 'insufficient_funds', 'error']),
  properties: z
    .object({
      sessionID: z.string().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
});

const SSEServerEvent = z.object({
  type: z.enum(['server.connected', 'server.heartbeat']),
  properties: z.record(z.string(), z.unknown()).optional(),
});

/** Catch-all for events we haven't explicitly modeled yet. */
const SSEUnknownEvent = z.object({
  type: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Try to parse SSE event data against known schemas. Falls through to
 * the unknown-event catch-all if none match.
 */
export function parseSSEEventData(raw: unknown): KiloSSEEventData {
  for (const schema of [
    SSESessionEvent,
    SSEMessageEvent,
    SSEAssistantEvent,
    SSEErrorEvent,
    SSEServerEvent,
  ] as const) {
    const result = schema.safeParse(raw);
    if (result.success) return result.data;
  }
  return SSEUnknownEvent.parse(raw);
}

export type KiloSSEEventData =
  | z.infer<typeof SSESessionEvent>
  | z.infer<typeof SSEMessageEvent>
  | z.infer<typeof SSEAssistantEvent>
  | z.infer<typeof SSEErrorEvent>
  | z.infer<typeof SSEServerEvent>
  | z.infer<typeof SSEUnknownEvent>;

/**
 * Parsed SSE event: the event name plus its Zod-validated data payload.
 */
export type KiloSSEEvent = {
  event: string;
  data: KiloSSEEventData;
};

// ── Git manager ─────────────────────────────────────────────────────────

export type CloneOptions = {
  rigId: string;
  gitUrl: string;
  defaultBranch: string;
};

export type WorktreeOptions = {
  rigId: string;
  branch: string;
};

// ── Heartbeat ───────────────────────────────────────────────────────────

export type HeartbeatPayload = {
  agentId: string;
  rigId: string;
  townId: string;
  status: AgentStatus;
  timestamp: string;
};

// ── Stream ticket (for WebSocket streaming) ─────────────────────────────

export type StreamTicketResponse = {
  ticket: string;
  expiresAt: string;
};
