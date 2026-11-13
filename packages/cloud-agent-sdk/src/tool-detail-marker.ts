import { z } from 'zod';
import type { Part } from './types';

/**
 * Client side of the Cloud Agent tool display projection
 * (`services/cloud-agent-next/src/shared/tool-display-projection.ts`).
 *
 * History pages and replay can carry completed tools as bounded previews.
 * A preview has a `cloudDetail` marker. The marker is a lookup hint for the
 * separately authorized detail read, never permission to read it.
 */
export type ToolDisplayMode = 'full' | 'preview';

export const TOOL_DETAIL_MARKER_FIELD = 'cloudDetail';

export const toolDetailMarkerSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  omitted: z.array(z.string()),
  omittedCount: z.number().int().nonnegative(),
  omittedBytes: z.number().int().nonnegative(),
  summary: z.object({ paths: z.array(z.string()).optional() }).optional(),
});
export type ToolDetailMarker = z.infer<typeof toolDetailMarkerSchema>;

/** Returns the preview marker of a tool part, or `undefined` for complete data. */
export function readToolDetailMarker(part: unknown): ToolDetailMarker | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const parsed = toolDetailMarkerSchema.safeParse(Reflect.get(part, TOOL_DETAIL_MARKER_FIELD));
  return parsed.success ? parsed.data : undefined;
}

function settledToolIdentity(part: Part): string | undefined {
  if (part.type !== 'tool' || part.state.status !== 'completed') return undefined;
  return JSON.stringify([part.callID, part.state.time.start, part.state.time.end]);
}

/**
 * True when `incoming` is a preview of the same settled tool call that
 * `existing` already holds in full. Slim replay must not replace richer data
 * for the same call; a different or newer call, or any complete update, does.
 */
export function isPreviewOfStoredTool(existing: Part, incoming: Part): boolean {
  if (readToolDetailMarker(incoming) === undefined || readToolDetailMarker(existing) !== undefined)
    return false;
  const identity = settledToolIdentity(incoming);
  return identity !== undefined && identity === settledToolIdentity(existing);
}
