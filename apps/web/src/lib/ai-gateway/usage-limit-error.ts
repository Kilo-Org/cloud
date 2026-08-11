import { APICallError } from 'ai';
import * as z from 'zod';
import { ProxyErrorType } from '@/lib/proxy-error-types';

const usageLimitResponseSchema = z.object({
  error_type: z.literal(ProxyErrorType.usage_limit_exceeded),
  error: z.object({ message: z.string().min(1) }),
});

export function getKiloUsageLimitErrorMessage(error: unknown): string | null {
  if (!APICallError.isInstance(error) || error.statusCode !== 402 || !error.responseBody) {
    return null;
  }

  try {
    const result = usageLimitResponseSchema.safeParse(JSON.parse(error.responseBody));
    return result.success ? result.data.error.message : null;
  } catch {
    return null;
  }
}
