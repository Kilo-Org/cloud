import * as z from 'zod';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

export const NormalizedClassifierInputSchema = z.object({
  apiKind: z.enum(['chat_completions', 'responses', 'messages']),
  requestedModel: z.string(),
  systemPromptPrefix: z.string().nullable(),
  userPromptPrefix: z.string().nullable(),
  latestUserPromptPrefix: z.string().nullable().optional(),
  messageCount: z.number().int().nonnegative().nullable(),
  hasTools: z.boolean(),
  stream: z.boolean(),
  providerHints: z.object({
    provider: JsonValueSchema,
    providerOptions: JsonValueSchema,
  }),
});
export type NormalizedClassifierInput = z.infer<typeof NormalizedClassifierInputSchema>;
