import * as z from 'zod';

// ---------------------------------------------------------------------------
// Wire-level envelope
// ---------------------------------------------------------------------------

export const cloudAgentEventSchema = z.object({
  eventId: z.number(),
  executionId: z.string().nullable(),
  sessionId: z.string(),
  streamEventType: z.string(),
  timestamp: z.string(),
  data: z.unknown(),
});
export type CloudAgentEvent = z.infer<typeof cloudAgentEventSchema>;

export const streamErrorSchema = z.object({
  type: z.literal('error'),
  code: z.enum([
    'WS_PROTOCOL_ERROR',
    'WS_AUTH_ERROR',
    'WS_SESSION_NOT_FOUND',
    'WS_EXECUTION_NOT_FOUND',
    'WS_DUPLICATE_CONNECTION',
    'WS_INTERNAL_ERROR',
  ]),
  message: z.string(),
});
export type StreamError = z.infer<typeof streamErrorSchema>;

// ---------------------------------------------------------------------------
// Session / cloud status discriminated unions
// ---------------------------------------------------------------------------

export const sessionStatusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('busy') }),
  z.object({ type: z.literal('idle') }),
  z.object({
    type: z.literal('retry'),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
  }),
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const cloudStatusSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('preparing'),
    step: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('ready') }),
  z.object({
    type: z.literal('finalizing'),
    step: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type CloudStatus = z.infer<typeof cloudStatusSchema>;

// ---------------------------------------------------------------------------
// Question / permission payloads
// ---------------------------------------------------------------------------

export const questionPayloadSchema = z
  .object({
    requestId: z.string(),
    callId: z.string().optional(),
    questions: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
export type QuestionState = z.infer<typeof questionPayloadSchema>;

export const permissionPayloadSchema = z
  .object({
    requestId: z.string(),
    callId: z.string().optional(),
    permission: z.string(),
    patterns: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    always: z.array(z.string()).optional().default([]),
  })
  .passthrough();
export type PermissionState = z.infer<typeof permissionPayloadSchema>;

// ---------------------------------------------------------------------------
// WebSocket inbound message (CLI live transport)
// ---------------------------------------------------------------------------

export const webInboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    sessionId: z.string(),
    parentSessionId: z.string().optional(),
    event: z.string(),
    data: z.unknown(),
  }),
  z.object({ type: z.literal('system'), event: z.string(), data: z.unknown() }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
]);
export type WebInboundMessage = z.infer<typeof webInboundMessageSchema>;

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export const heartbeatDataSchema = z.object({
  connectionId: z.string(),
  sessions: z.array(
    z
      .object({
        id: z.string(),
        status: z.string(),
        title: z.string(),
      })
      .passthrough()
  ),
});
export type HeartbeatData = z.infer<typeof heartbeatDataSchema>;

// ---------------------------------------------------------------------------
// Kilocode payload
// ---------------------------------------------------------------------------

export const kilocodePayloadSchema = z.object({
  type: z.string(),
  properties: z.unknown(),
});
export type KilocodePayload = z.infer<typeof kilocodePayloadSchema>;

// ---------------------------------------------------------------------------
// Per-event-type data schemas (normalizeInnerEvent)
// ---------------------------------------------------------------------------

export const messageUpdatedDataSchema = z.object({
  info: z.object({ id: z.string(), sessionID: z.string() }).passthrough(),
});
export type MessageUpdatedData = z.infer<typeof messageUpdatedDataSchema>;

export const messagePartUpdatedDataSchema = z.object({
  part: z.object({ id: z.string(), sessionID: z.string(), messageID: z.string() }).passthrough(),
});
export type MessagePartUpdatedData = z.infer<typeof messagePartUpdatedDataSchema>;

export const messagePartDeltaDataSchema = z.object({
  sessionID: z.string(),
  messageID: z.string(),
  partID: z.string(),
  field: z.string(),
  delta: z.string(),
});
export type MessagePartDeltaData = z.infer<typeof messagePartDeltaDataSchema>;

export const messagePartRemovedDataSchema = z.object({
  sessionID: z.string(),
  messageID: z.string(),
  partID: z.string(),
});
export type MessagePartRemovedData = z.infer<typeof messagePartRemovedDataSchema>;

export const sessionStatusDataSchema = z.object({
  sessionID: z.string(),
  status: sessionStatusSchema,
});
export type SessionStatusData = z.infer<typeof sessionStatusDataSchema>;

export const sessionCreatedDataSchema = z.object({
  info: z.object({ id: z.string() }).passthrough(),
});
export type SessionCreatedData = z.infer<typeof sessionCreatedDataSchema>;

export const sessionUpdatedDataSchema = z.object({
  info: z.object({ id: z.string() }).passthrough(),
});
export type SessionUpdatedData = z.infer<typeof sessionUpdatedDataSchema>;

export const sessionErrorDataSchema = z
  .object({
    error: z.unknown().optional(),
    sessionID: z.unknown().optional(),
  })
  .passthrough();
export type SessionErrorData = z.infer<typeof sessionErrorDataSchema>;

export const sessionIdleDataSchema = z
  .object({
    sessionID: z.unknown(),
  })
  .passthrough();
export type SessionIdleData = z.infer<typeof sessionIdleDataSchema>;

export const sessionTurnCloseDataSchema = z
  .object({
    sessionID: z.string().optional().catch(undefined),
    reason: z.string().optional().catch(undefined),
  })
  .passthrough();
export type SessionTurnCloseData = z.infer<typeof sessionTurnCloseDataSchema>;

export const questionAskedDataSchema = z.object({
  id: z.string(),
  tool: z.object({ callID: z.string() }).optional(),
  questions: z.array(z.unknown()).optional().catch(undefined),
});
export type QuestionAskedData = z.infer<typeof questionAskedDataSchema>;

export const questionRepliedDataSchema = z.object({
  requestID: z.string(),
});
export type QuestionRepliedData = z.infer<typeof questionRepliedDataSchema>;

export const questionRejectedDataSchema = z.object({
  requestID: z.string(),
});
export type QuestionRejectedData = z.infer<typeof questionRejectedDataSchema>;

export const permissionAskedDataSchema = z.object({
  id: z.string().min(1),
  permission: z.string(),
  tool: z.object({ callID: z.string() }).optional(),
  patterns: z.array(z.string()).catch([]),
  metadata: z.record(z.string(), z.unknown()).catch({}),
  always: z.array(z.string()).catch([]),
});
export type PermissionAskedData = z.infer<typeof permissionAskedDataSchema>;

export const permissionRepliedDataSchema = z.object({
  requestID: z.string(),
});
export type PermissionRepliedData = z.infer<typeof permissionRepliedDataSchema>;

export const completeDataSchema = z
  .object({
    currentBranch: z.string().optional().catch(undefined),
  })
  .passthrough();
export type CompleteData = z.infer<typeof completeDataSchema>;

export const interruptedDataSchema = z.unknown();
export type InterruptedData = z.infer<typeof interruptedDataSchema>;

export const errorDataSchema = z
  .object({
    fatal: z.boolean().optional(),
  })
  .passthrough();
export type ErrorData = z.infer<typeof errorDataSchema>;

export const wrapperDisconnectedDataSchema = z.unknown();
export type WrapperDisconnectedData = z.infer<typeof wrapperDisconnectedDataSchema>;

export const preparingDataSchema = z.object({
  step: z.string(),
  message: z.string(),
});
export type PreparingData = z.infer<typeof preparingDataSchema>;

export const autocommitStartedDataSchema = z.object({
  messageId: z.string(),
  message: z.string().optional(),
});
export type AutocommitStartedData = z.infer<typeof autocommitStartedDataSchema>;

export const autocommitCompletedDataSchema = z.object({
  messageId: z.string(),
  success: z.boolean().catch(false),
  message: z.string().optional(),
  skipped: z.boolean().optional(),
  commitHash: z.string().optional(),
  commitMessage: z.string().optional(),
});
export type AutocommitCompletedData = z.infer<typeof autocommitCompletedDataSchema>;

export const cloudStatusDataSchema = z.object({
  cloudStatus: cloudStatusSchema,
});
export type CloudStatusData = z.infer<typeof cloudStatusDataSchema>;

export const connectedDataSchema = z.object({
  sessionStatus: sessionStatusSchema.optional().catch(undefined),
  cloudStatus: cloudStatusSchema.optional().catch(undefined),
});
export type ConnectedData = z.infer<typeof connectedDataSchema>;

// ---------------------------------------------------------------------------
// Session snapshot (historical transport / replay)
// ---------------------------------------------------------------------------

export const sessionSnapshotSchema = z.object({
  info: z.object({ id: z.unknown() }).passthrough(),
  messages: z.array(
    z.object({
      info: z.object({ id: z.string() }).passthrough(),
      parts: z.array(z.object({ id: z.string() }).passthrough()),
    })
  ),
});
export type SessionSnapshotData = z.infer<typeof sessionSnapshotSchema>;

// ---------------------------------------------------------------------------
// Error shape (session-manager tRPC error extraction)
// ---------------------------------------------------------------------------

export const errorShapeSchema = z
  .object({
    data: z
      .object({
        code: z.string().optional(),
        httpStatus: z.number().optional(),
      })
      .passthrough()
      .optional(),
    shape: z
      .object({
        code: z.string().optional(),
        data: z
          .object({
            httpStatus: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ErrorShape = z.infer<typeof errorShapeSchema>;
