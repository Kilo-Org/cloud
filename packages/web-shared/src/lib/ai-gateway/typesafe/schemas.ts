import type {
  EntryType,
  Question,
  Questions,
  SystemOneRequestPayload,
  SystemOneResult,
} from '@typesafe-ai/sdk';
import { z } from 'zod';
import { providerPrivacySchema } from '../provider-privacy';

export const TYPESAFE_MODEL = 'typesafe/jev-1.13';

/** OpenRouter models whose output modality is `decisions`. */
const SYSTEM_ONE_MODELS = [
  TYPESAFE_MODEL,
  '~typesafe/jev-latest',
  'inception/mercury-decide:free',
  'jaredpalmer/kev-4b',
  'respan/span-01',
  'respan/span-01-lite',
  'respan/span-01-lite:free',
  'togethercomputer/tev1-4b-experimental',
  'upstage/solar-decide',
] as const;

type SystemOneModel = (typeof SYSTEM_ONE_MODELS)[number];

/** The OpenRouter provider slug that serves each System One model. */
export const SYSTEM_ONE_MODEL_PROVIDERS: Readonly<Record<SystemOneModel, string>> = {
  [TYPESAFE_MODEL]: 'typesafe',
  '~typesafe/jev-latest': 'typesafe',
  'inception/mercury-decide:free': 'inception',
  'jaredpalmer/kev-4b': 'siliconflow',
  'respan/span-01': 'respan',
  'respan/span-01-lite': 'respan',
  'respan/span-01-lite:free': 'respan',
  'togethercomputer/tev1-4b-experimental': 'together',
  'upstage/solar-decide': 'upstage',
};

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
    .enum([...SYSTEM_ONE_MODELS, 'jev-1.13'])
    .default(TYPESAFE_MODEL)
    .transform(model => (model === 'jev-1.13' ? TYPESAFE_MODEL : model)),
  state: entrySchema,
  provider: providerPrivacySchema.optional(),
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
