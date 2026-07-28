import * as z from 'zod';

const exitSessionResponseSchema = z.object({}).strict();

export type ExitSessionParseResult = { ok: true } | { ok: false; reason: 'invalid' };

export function parseExitSessionResponse(raw: unknown): ExitSessionParseResult {
  return exitSessionResponseSchema.safeParse(raw).success
    ? { ok: true }
    : { ok: false, reason: 'invalid' };
}
