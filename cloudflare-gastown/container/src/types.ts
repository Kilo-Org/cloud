import { z } from 'zod';

// ── Agent roles (mirrors worker types) ──────────────────────────────────

export const AgentRole = z.enum(['mayor', 'polecat', 'refinery', 'triage']);
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
  /** Lightweight model for title generation, explore subagent, etc. */
  smallModel: z.string().optional(),
  systemPrompt: z.string().optional(),
  gitUrl: z.string(),
  branch: z.string(),
  defaultBranch: z.string(),
  envVars: z.record(z.string(), z.string()).optional(),
  /** Platform integration ID for resolving fresh git credentials at startup */
  platformIntegrationId: z.string().optional(),
  /** Git ref to branch from (e.g. convoy feature branch). Falls back to HEAD if absent. */
  startPoint: z.string().optional(),
  /** Skip repo clone — use a lightweight git-init-only workspace (for reasoning-only agents like triage). */
  lightweight: z.boolean().optional(),
  /** Organization ID — set for org-owned towns so agents bill to the correct team. */
  organizationId: z.string().optional(),
  /** Rig list for mayor agents — used to set up browse worktrees on fresh containers. */
  rigs: z
    .array(
      z.object({
        rigId: z.string(),
        gitUrl: z.string(),
        defaultBranch: z.string(),
        platformIntegrationId: z.string().optional(),
      })
    )
    .optional(),
});
export type StartAgentRequest = z.infer<typeof StartAgentRequest>;

export const MergeRequest = z.object({
  townId: z.string().min(1),
  rigId: z.string().min(1),
  branch: z.string().min(1),
  targetBranch: z.string().min(1),
  gitUrl: z.string().min(1),
  entryId: z.string().min(1),
  beadId: z.string().min(1),
  agentId: z.string().min(1),
  callbackUrl: z.string().optional(),
  envVars: z.record(z.string(), z.string()).optional(),
});
export type MergeRequest = z.infer<typeof MergeRequest>;

export type MergeResult = {
  status: 'accepted' | 'merged' | 'conflict';
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

export const UpdateAgentModelRequest = z.object({
  model: z.string().min(1),
  smallModel: z.string().optional(),
  /** Pre-formatted conversation history to inject into the new session prompt. */
  conversationHistory: z.string().optional(),
});
export type UpdateAgentModelRequest = z.infer<typeof UpdateAgentModelRequest>;

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
  /** Event type of the most recent SDK event (e.g. 'message_part.updated') */
  lastEventType: string | null;
  /** ISO 8601 timestamp of the most recent SDK event */
  lastEventAt: string | null;
  /** Last known active tool calls (populated from SSE events) */
  activeTools: string[];
  /** Total messages sent to this agent */
  messageCount: number;
  /** Exit reason if status is 'exited' or 'failed' */
  exitReason: string | null;
  /** Gastown worker API URL for completion callbacks */
  gastownApiUrl: string | null;
  /** Container-scoped JWT (shared by all agents, refreshed by alarm). */
  gastownContainerToken: string | null;
  /** Legacy per-agent JWT for authenticating callbacks to the Gastown worker. */
  gastownSessionToken: string | null;
  /** Override the default completion callback URL (for agents not backed by a Rig DO) */
  completionCallbackUrl: string | null;
  /** Model ID used for this agent's sessions (e.g. "anthropic/claude-sonnet-4.6") */
  model: string | null;
  /** Full env dict from buildAgentEnv, stored so model hot-swap can replay it. */
  startupEnv: Record<string, string>;
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
  process: import('bun').Subprocess; // eslint-disable-line @typescript-eslint/consistent-type-imports
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
  /** Optional start point for the new branch (e.g. 'origin/main' or a feature branch ref). */
  startPoint?: string;
  /** Default branch name, used as fallback start point (e.g. 'main'). */
  defaultBranch?: string;
};

// ── Repo setup (proactive clone + browse worktree) ──────────────────────

export const SetupRepoRequest = z.object({
  rigId: z.string().min(1),
  gitUrl: z.string().min(1),
  defaultBranch: z.string().min(1),
  envVars: z.record(z.string(), z.string()).optional(),
  /** Platform integration ID for resolving git credentials when no token is in envVars */
  platformIntegrationId: z.string().optional(),
});
export type SetupRepoRequest = z.infer<typeof SetupRepoRequest>;

// ── Heartbeat ───────────────────────────────────────────────────────────

export type HeartbeatPayload = {
  agentId: string;
  rigId: string;
  townId: string;
  status: AgentStatus;
  timestamp: string;
  // SDK activity watermark
  lastEventType: string | null;
  lastEventAt: string | null;
  activeTools: string[];
  messageCount: number;
};

// ── Stream ticket (for WebSocket streaming) ─────────────────────────────

export type StreamTicketResponse = {
  ticket: string;
  expiresAt: string;
};
