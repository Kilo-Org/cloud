import * as z from 'zod';

const tokenResponseSchema = z.object({ token: z.string().min(1) });
const emailCodeResponseSchema = z.object({ success: z.literal(true) });
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
