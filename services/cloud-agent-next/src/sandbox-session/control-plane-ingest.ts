import { z } from 'zod';
import { kiloEventSessionId } from '../shared/kilo-event.js';
import {
  containedKiloSessionIdSchema,
  type CloudAgentChildSessionLineage,
} from '@kilocode/session-ingest-contracts';

const childSessionInfoSchema = z.object({
  id: containedKiloSessionIdSchema,
  parentID: containedKiloSessionIdSchema,
  directory: z.string().min(1),
});

export function childSessionLineage(
  info: unknown,
  directory: string
): CloudAgentChildSessionLineage | undefined {
  const parsed = childSessionInfoSchema.safeParse(info);
  if (
    !parsed.success ||
    parsed.data.id === parsed.data.parentID ||
    parsed.data.directory !== directory
  )
    return undefined;
  return { sessionId: parsed.data.id, parentSessionId: parsed.data.parentID };
}

export function ingestKiloSessionId(
  _type: string,
  properties: Record<string, unknown>
): string | undefined {
  return kiloEventSessionId(properties);
}
