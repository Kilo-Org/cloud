import * as z from 'zod';

export const ServedModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

export function parseOpenAiServedModelIds(response: unknown): Set<string> | null {
  const parsed = ServedModelsSchema.safeParse(response);
  return parsed.success ? new Set(parsed.data.data.map(model => model.id)) : null;
}

export function sanitizeOpenRouterModels(response: unknown): unknown {
  if (
    !response ||
    typeof response !== 'object' ||
    !('data' in response) ||
    !Array.isArray(response.data)
  ) {
    return response;
  }
  return {
    ...response,
    data: response.data.map((model: unknown) => {
      if (!model || typeof model !== 'object' || !('enkrypt' in model)) return model;
      const sanitized: Record<string, unknown> = { ...model };
      delete sanitized.enkrypt;
      return sanitized;
    }),
  };
}
