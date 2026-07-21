import { z } from 'zod';

// Use z.string() for session IDs (not the strict sessionIdSchema from ws-protocol)
// because the CLI's remote-protocol.ts uses z.string() — the strict ses_ format
// is enforced by the per-session SessionIngestDO path, not the UserConnectionDO path.

// -- CLI → DO (CLIOutbound) ---------------------------------------------------

// Identity of the CLI process (kilo remote spawner) attached to this WebSocket.
// Newer CLIs include this on every heartbeat; legacy CLIs that predate the
// `kilo remote` spawner omit it entirely. The DO persists the latest value
// in the WebSocket attachment and uses it for `getConnectedInstances()`.
const instanceSchema = z.object({
  name: z.string().min(1).max(64),
  projectName: z.string().min(1).max(64),
  version: z.string().max(32).optional(),
});

export type Instance = z.infer<typeof instanceSchema>;

export const CLIOutboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heartbeat'),
    // Absent on CLI builds older than the protocolVersion field itself — treat
    // a missing value as a legacy CLI with no negotiated wire protocol.
    protocolVersion: z.string().optional(),
    // Per-connection capabilities advertised by the CLI. Absent on CLIs that
    // predate the field — treated as a legacy CLI with no opt-in features
    // (e.g. attachment uploads from the mobile viewer).
    capabilities: z.object({ attachments: z.boolean().optional() }).optional(),
    // Optional identity of the spawning CLI process. Absent on legacy CLIs
    // (which are not spawned by `kilo remote`). When present, the DO
    // persists it in the WebSocket attachment and exposes it via
    // `getConnectedInstances()`.
    instance: instanceSchema.optional(),
    sessions: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        title: z.string(),
        gitUrl: z.string().optional(),
        gitBranch: z.string().optional(),
        parentSessionId: z.string().optional(),
        // Platform the session is running on (e.g. "darwin", "linux", "vscode").
        // Optional for backward compatibility with legacy CLIs.
        platform: z.string().max(32).optional(),
      })
    ),
  }),
  z.object({
    type: z.literal('event'),
    sessionId: z.string(),
    parentSessionId: z.string().optional(),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
]);

// -- DO → CLI (CLIInbound) ----------------------------------------------------

export const CLIInboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('command'),
    id: z.string(),
    command: z.string(),
    sessionId: z.string().optional(),
    data: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('system'),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('heartbeat_ack'),
  }),
]);

// -- Web UI → DO (WebOutbound) ------------------------------------------------

export const WebOutboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('command'),
    id: z.string(),
    sessionId: z.string().optional(),
    connectionId: z.string().optional(),
    command: z.string(),
    data: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('ping'),
    nonce: z.string(),
  }),
]);

// -- V2 session system events -------------------------------------------------

export const SessionStatusSchema = z.enum(['idle', 'busy', 'question', 'permission', 'retry']);

export const SessionEventV2RowSchema = z.object({
  source: z.literal('v2'),
  sessionId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string().nullable(),
  createdOnPlatform: z.string().nullable(),
  organizationId: z.string().nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  status: SessionStatusSchema.nullable(),
  statusUpdatedAt: z.string().nullable(),
});

export const SessionRowEventPayloadSchema = z.object({
  source: z.literal('v2'),
  session: SessionEventV2RowSchema,
  changedAt: z.string(),
});

// Temporary rollout compatibility: remove the lightweight branch after all web clients consume full session rows.
export const SessionStatusUpdatedPayloadSchema = z.union([
  z.object({
    source: z.literal('v2'),
    session: SessionEventV2RowSchema,
    previousStatus: SessionStatusSchema.nullable(),
    status: SessionStatusSchema.nullable(),
    statusUpdatedAt: z.string().nullable(),
    changedAt: z.string(),
  }),
  z.object({
    source: z.literal('v2'),
    sessionId: z.string(),
    previousStatus: SessionStatusSchema.nullable(),
    status: SessionStatusSchema.nullable(),
    statusUpdatedAt: z.string().nullable(),
    updatedAt: z.string().optional(),
    changedAt: z.string(),
  }),
]);

export const SessionDeletedPayloadSchema = z.object({
  source: z.literal('v2'),
  sessionId: z.string(),
  parentSessionId: z.string().nullable(),
  organizationId: z.string().nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  createdOnPlatform: z.string().nullable(),
  deletedAt: z.string(),
});

export const SessionEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.created'), data: SessionRowEventPayloadSchema }),
  z.object({ type: z.literal('session.updated'), data: SessionRowEventPayloadSchema }),
  z.object({ type: z.literal('session.status.updated'), data: SessionStatusUpdatedPayloadSchema }),
  z.object({ type: z.literal('session.deleted'), data: SessionDeletedPayloadSchema }),
]);

// -- DO → Web UI (WebInbound) -------------------------------------------------

export const WebInboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    sessionId: z.string(),
    parentSessionId: z.string().optional(),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('system'),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('pong'),
    nonce: z.string(),
  }),
]);

// -- Inferred types -----------------------------------------------------------

export type CLIOutboundMessage = z.infer<typeof CLIOutboundMessageSchema>;
export type CLIInboundMessage = z.infer<typeof CLIInboundMessageSchema>;
export type WebOutboundMessage = z.infer<typeof WebOutboundMessageSchema>;
export type WebInboundMessage = z.infer<typeof WebInboundMessageSchema>;
export type SessionEventV2Row = z.infer<typeof SessionEventV2RowSchema>;
export type SessionRowEventPayload = z.infer<typeof SessionRowEventPayloadSchema>;
export type SessionStatusUpdatedPayload = z.infer<typeof SessionStatusUpdatedPayloadSchema>;
export type SessionDeletedPayload = z.infer<typeof SessionDeletedPayloadSchema>;
export type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;
