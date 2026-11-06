import { z } from 'zod';
import { invalidRequestResponse } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { providerPrivacySchema } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';

const MAX_REQUEST_DEPTH = 128;

export const gatewayModelSchema = z.string().trim().min(1);

export const gatewayProviderSchema = z.looseObject({
  ...providerPrivacySchema.shape,
  only: z.array(z.string()).nullish(),
  ignore: z.array(z.string()).nullish(),
  order: z.array(z.string()).nullish(),
  sort: z.union([z.string(), z.looseObject({})]).nullish(),
});

export function validateRequestBody<T extends z.ZodType>(body: unknown, schema: T) {
  const pending = [{ value: body, depth: 0 }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || entry.value === null || typeof entry.value !== 'object') continue;
    if (entry.depth > MAX_REQUEST_DEPTH) {
      return {
        success: false,
        response: invalidRequestResponse(
          `Request body exceeds the maximum nesting depth of ${MAX_REQUEST_DEPTH}.`
        ),
      } as const;
    }
    for (const value of Object.values(entry.value)) {
      if (value !== null && typeof value === 'object') {
        pending.push({ value, depth: entry.depth + 1 });
      }
    }
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    const path = result.error.issues[0]?.path.reduce<string>(
      (path, key) =>
        typeof key === 'number' ? `${path}[${key}]` : `${path ? `${path}.` : ''}${String(key)}`,
      ''
    );
    return {
      success: false,
      response: invalidRequestResponse(
        path ? `Invalid request field "${path}".` : 'Invalid request body.'
      ),
    } as const;
  }
  return { success: true, data: result.data } as const;
}
