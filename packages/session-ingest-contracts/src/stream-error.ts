import { z } from 'zod';

/**
 * WebSocket protocol error codes for the cloud-agent streaming feature.
 *
 * This is the canonical wire contract. The Worker produces these codes on the
 * `/stream` endpoint (`services/cloud-agent-next/src/websocket/types.ts`), the
 * web app and the cloud-agent SDK both parse them back with `isStreamError`.
 * A new code must be added here exactly once.
 */
export const STREAM_ERROR_CODES = [
  'WS_PROTOCOL_ERROR',
  'WS_AUTH_ERROR',
  'WS_SESSION_NOT_FOUND',
  'WS_EXECUTION_NOT_FOUND',
  'WS_DUPLICATE_CONNECTION',
  'WS_INTERNAL_ERROR',
] as const;

export type StreamErrorCode = (typeof STREAM_ERROR_CODES)[number];

export const streamErrorSchema = z.object({
  type: z.literal('error'),
  code: z.enum(STREAM_ERROR_CODES),
  message: z.string(),
});

export type StreamError = z.infer<typeof streamErrorSchema>;

/** Whether an untrusted WebSocket frame carries a stream error. */
export function isStreamError(data: unknown): data is StreamError {
  return streamErrorSchema.safeParse(data).success;
}
