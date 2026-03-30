import { z } from 'zod';

// Use z.string() for session IDs (not the strict sessionIdSchema from ws-protocol)
// because the CLI's remote-protocol.ts uses z.string() — the strict ses_ format
// is enforced by the per-session SessionIngestDO path, not the UserConnectionDO path.

// -- CLI → DO (CLIOutbound) ---------------------------------------------------

export const CLIOutboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heartbeat'),
    sessions: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        title: z.string(),
        gitUrl: z.string().optional(),
        gitBranch: z.string().optional(),
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
    data: z.unknown(),
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
    data: z.unknown(),
  }),
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
]);

// -- Inferred types -----------------------------------------------------------

export type CLIOutboundMessage = z.infer<typeof CLIOutboundMessageSchema>;
export type CLIInboundMessage = z.infer<typeof CLIInboundMessageSchema>;
export type WebOutboundMessage = z.infer<typeof WebOutboundMessageSchema>;
export type WebInboundMessage = z.infer<typeof WebInboundMessageSchema>;
