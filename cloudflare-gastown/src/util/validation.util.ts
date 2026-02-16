import { validator } from 'hono/validator';
import type { Context, Env } from 'hono';
import type { ZodTypeAny } from 'zod';

export function zodJsonValidator<T extends ZodTypeAny>(
  schema: T,
  opts?: { errorMessage?: string }
) {
  const errorMessage = opts?.errorMessage ?? 'Invalid request body';

  return validator('json', (value, c: Context<Env>) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return c.json(
        {
          success: false as const,
          error: errorMessage,
          issues: parsed.error.issues,
        },
        400
      );
    }
    return parsed.data;
  });
}
