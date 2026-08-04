import * as z from 'zod';

const tokenResponseSchema = z.object({ token: z.string().min(1) });
const emailCodeResponseSchema = z.object({
  success: z.literal(true),
  challengeId: z.string().uuid().optional(),
});
const errorResponseSchema = z.object({ error: z.string() });

export function parseTokenResponse(value: unknown) {
  const result = tokenResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseEmailCodeResponse(value: unknown) {
  const result = emailCodeResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseAuthErrorCode(value: unknown): string | undefined {
  const result = errorResponseSchema.safeParse(value);
  return result.success ? result.data.error : undefined;
}

export type ChallengeEntry = { email: string; challengeId: string };

export function buildChallengeEntry(
  parsed: NonNullable<ReturnType<typeof parseEmailCodeResponse>>,
  email: string
): ChallengeEntry | null {
  if (parsed.challengeId) {
    return { email, challengeId: parsed.challengeId };
  }
  return null;
}

export function selectChallengeId(
  entry: ChallengeEntry | null,
  email: string
): string | undefined {
  return entry?.email === email ? entry.challengeId : undefined;
}
