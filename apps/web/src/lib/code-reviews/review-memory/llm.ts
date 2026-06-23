import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, Output, zodSchema, type LanguageModel } from 'ai';
import * as z from 'zod';

import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { DEFAULT_CODE_REVIEW_MODEL } from '@/lib/code-reviews/core/constants';
import { APP_URL } from '@/lib/constants';
import { FEATURE_HEADER } from '@/lib/feature-detection';
import { generateApiToken } from '@/lib/tokens';
import { findUserById } from '@/lib/user';
import type { User } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';

// Claude rejects these constraints at the provider boundary; the source Zod schema still validates output locally.
const UNSUPPORTED_WIRE_SCHEMA_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
]);

const ReviewMemoryModelConfigSchema = z.object({
  model_slug: z.string().optional(),
});

type GenerateReviewMemoryStructuredOutputInput<OUTPUT> = {
  model: LanguageModel;
  prompt: string;
  maxOutputTokens: number;
  schemaName: string;
  schema: z.ZodType<OUTPUT>;
  wireSchema?: z.ZodType;
  validate: (output: OUTPUT) => OUTPUT;
};

export async function resolveReviewMemoryActor(owner: ReviewMemoryOwner): Promise<User> {
  if (owner.type === 'org') {
    return await ensureBotUserForOrg(owner.id, 'code-review');
  }

  const user = await findUserById(owner.id);
  if (!user) throw new Error('Review Memory owner user not found');
  return user;
}

export async function resolveReviewMemoryModel(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
}): Promise<{ modelSlug: string }> {
  const agentConfig = await getAgentConfigForOwner(input.owner, 'code_review', input.platform);
  const parsed = ReviewMemoryModelConfigSchema.safeParse(agentConfig?.config);
  if (!parsed.success) {
    return { modelSlug: DEFAULT_CODE_REVIEW_MODEL };
  }

  return { modelSlug: parsed.data.model_slug || DEFAULT_CODE_REVIEW_MODEL };
}

export function createReviewMemoryGatewayProvider(input: {
  owner: ReviewMemoryOwner;
  actor: User;
  userAgent: string;
  fetch?: typeof globalThis.fetch;
}) {
  const headers: Record<string, string> = {
    'User-Agent': input.userAgent,
    [FEATURE_HEADER]: 'code-review-memory',
  };
  if (input.owner.type === 'org') {
    headers['X-KiloCode-OrganizationId'] = input.owner.id;
  }

  return createOpenAICompatible({
    name: 'kilo-gateway',
    baseURL: `${APP_URL}/api/openrouter`,
    apiKey: generateApiToken(input.actor, { internalApiUse: true }),
    headers,
    fetch: input.fetch,
    supportsStructuredOutputs: true,
    transformRequestBody: args => {
      if (args.response_format?.type !== 'json_schema') return args;
      return {
        ...args,
        provider: {
          ...args.provider,
          require_parameters: true,
        },
      };
    },
  });
}

export async function generateReviewMemoryStructuredOutput<OUTPUT>(
  input: GenerateReviewMemoryStructuredOutputInput<OUTPUT>
): Promise<{
  output: OUTPUT;
  tokensIn: number | null;
  tokensOut: number | null;
}> {
  const sourceSchema = zodSchema(input.schema);
  const providerSchema = zodSchema(input.wireSchema ?? input.schema);
  const transformedProviderSchema = structuredClone(await providerSchema.jsonSchema);
  transformReviewMemoryWireSchema(transformedProviderSchema);
  const wireSchema = jsonSchema<OUTPUT>(transformedProviderSchema, {
    validate: sourceSchema.validate,
  });
  const prompt = `${input.prompt}

Output requirements:
- Return only a JSON object matching the schema below.
- Do not include Markdown fences or explanatory text.

JSON Schema:
${JSON.stringify(transformedProviderSchema)}`;

  const result = await generateText({
    model: input.model,
    prompt,
    maxOutputTokens: input.maxOutputTokens,
    output: Output.object({
      schema: wireSchema,
      name: input.schemaName,
    }),
  });

  return {
    output: input.validate(result.output),
    tokensIn: result.usage.inputTokens ?? null,
    tokensOut: result.usage.outputTokens ?? null,
  };
}

function transformReviewMemoryWireSchema(schema: unknown): void {
  const pending: unknown[] = [schema];

  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;

    if (Array.isArray(value.oneOf)) {
      const existingAnyOf = Array.isArray(value.anyOf) ? value.anyOf : [];
      value.anyOf = [...existingAnyOf, ...value.oneOf];
      delete value.oneOf;
    }
    if (value.type === 'object') {
      value.additionalProperties = false;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (
        UNSUPPORTED_WIRE_SCHEMA_KEYWORDS.has(key) ||
        (key === 'minItems' && nestedValue !== 0 && nestedValue !== 1)
      ) {
        delete value[key];
        continue;
      }
      pending.push(nestedValue);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
