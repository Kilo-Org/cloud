import * as z from 'zod';

const exitCliResponseSchema = z.object({}).strict();

export type ExitCliParseResult = { ok: true } | { ok: false; reason: 'invalid' };

export function parseExitCliResponse(raw: unknown): ExitCliParseResult {
  return exitCliResponseSchema.safeParse(raw).success
    ? { ok: true }
    : { ok: false, reason: 'invalid' };
}
