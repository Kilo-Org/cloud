import { z } from 'zod';
import {
  kilo2ConversationSourceSchema,
  kilo2MessageSchema,
  sessionIdSchema,
} from '@kilocode/session-ingest-contracts';
import { cloudMessagePartSchema } from './cloud-conversation-schemas';
import { readKilo2Messages } from './kilo2-source-messages';
import type { Part } from './types';
import { readToolDetailMarker } from './tool-detail-marker';

export {
  isPreviewOfStoredTool,
  readToolDetailMarker,
  TOOL_DETAIL_MARKER_FIELD,
  toolDetailMarkerSchema,
  type ToolDetailMarker,
  type ToolDisplayMode,
} from './tool-detail-marker';

const nativeId = z.string().min(1).max(256);

export const cloudToolPartDetailInputSchema = z.object({
  sessionId: z.string().pipe(z.templateLiteral(['workspace_', z.uuid()])),
  kiloSessionId: sessionIdSchema.optional(),
  messageId: nativeId,
  partId: nativeId,
  callId: nativeId.optional(),
});
export type CloudToolPartDetailInput = z.infer<typeof cloudToolPartDetailInputSchema>;

export const cloudToolPartDetailWireSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('found'),
    source: z.union([z.object({ version: z.literal('v1') }), kilo2ConversationSourceSchema]),
    revision: z.number().int().nonnegative(),
    part: z.unknown().optional(),
    message: z.unknown().optional(),
    parentID: z.string().optional(),
  }),
  z.object({ kind: z.literal('not_found') }),
  z.object({ kind: z.literal('too_large'), bytes: z.number().int().nonnegative() }),
]);
export type CloudToolPartDetailWire = z.infer<typeof cloudToolPartDetailWireSchema>;

/** Detail request for a preview part, or `undefined` when the part is complete. */
export function toolPartDetailRequest(
  part: Part
): Omit<CloudToolPartDetailInput, 'sessionId' | 'kiloSessionId'> | undefined {
  if (part.type !== 'tool' || readToolDetailMarker(part) === undefined) return undefined;
  return { messageId: part.messageID, partId: part.id, callId: part.callID };
}

export type ToolPartDetailResult =
  | { kind: 'found'; revision: number; part: Part }
  | { kind: 'not_found' }
  | { kind: 'too_large'; bytes: number };

/**
 * Converts a detail response into the complete display part for `preview`.
 * Native v2 details are projected with the same conversion as history pages,
 * so the complete part keeps the preview's identity. A response for a
 * different part is treated as absent.
 */
export function readToolPartDetail(wire: unknown, preview: Part): ToolPartDetailResult {
  const detail = cloudToolPartDetailWireSchema.parse(wire);
  if (detail.kind !== 'found') return detail;
  let part: Part | undefined;
  if (detail.source.version === 'v1') {
    const parsed = cloudMessagePartSchema.safeParse(detail.part);
    part = parsed.success ? parsed.data : undefined;
  } else {
    const message = kilo2MessageSchema.safeParse(detail.message);
    if (message.success)
      part = readKilo2Messages(detail.source.session, [message.data])[0]?.parts.find(
        item => item.id === preview.id
      );
  }
  if (
    part === undefined ||
    part.type !== 'tool' ||
    part.id !== preview.id ||
    part.messageID !== preview.messageID ||
    part.sessionID !== preview.sessionID ||
    readToolDetailMarker(part) !== undefined
  )
    return { kind: 'not_found' };
  return { kind: 'found', revision: detail.revision, part };
}
