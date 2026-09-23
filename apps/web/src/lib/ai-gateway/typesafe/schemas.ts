import type {
  EntryType,
  Question,
  Questions,
  SystemOneRequestPayload,
  SystemOneResult,
} from '@typesafe-ai/sdk';
import { z } from 'zod';

export const TYPESAFE_MODEL = 'typesafe/jev-1.13';

const entrySchema = z.union([
  z.string(),
  z.record(z.string(), z.json()),
  z.array(z.json()),
  z.null(),
]) satisfies z.ZodType<EntryType>;

const questionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: entrySchema.optional(),
    criteria: z
      .object({ true: entrySchema.optional(), false: entrySchema.optional() })
      .nullable()
      .optional(),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: entrySchema.optional(),
    criteria: z.record(z.string(), entrySchema),
  }),
  z.object({
    type: z.literal('score'),
    instructions: entrySchema.optional(),
    criteria: z.tuple([entrySchema, entrySchema]).rest(entrySchema),
  }),
]) satisfies z.ZodType<Question>;

export const systemOneRequestSchema = z.object({
  model: z
    .enum([TYPESAFE_MODEL, 'jev-1.13'])
    .default(TYPESAFE_MODEL)
    .transform(() => TYPESAFE_MODEL),
  state: entrySchema,
  questions: z
    .record(z.string(), questionSchema)
    .refine(questions => Object.keys(questions).length > 0, 'At least one question is required'),
}) satisfies z.ZodType<SystemOneRequestPayload>;

type OpenRouterSystemOneResult = SystemOneResult<Questions> & {
  id: string;
  provider?: string;
  usage: SystemOneResult<Questions>['usage'] & { cost: number };
};

const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);

export const systemOneResponseSchema = z.looseObject({
  id: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().optional(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion('type', [
      z.looseObject({ type: z.literal('noul'), noul: probability }),
      z.looseObject({
        type: z.literal('choice'),
        choice: z.string(),
        confidence: probability,
        probabilities,
      }),
      z.looseObject({
        type: z.literal('score'),
        score: z.number().nonnegative(),
        confidence: probability,
        probabilities,
        legend: z.record(z.string(), entrySchema),
      }),
    ])
  ),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
  }),
}) satisfies z.ZodType<OpenRouterSystemOneResult>;
