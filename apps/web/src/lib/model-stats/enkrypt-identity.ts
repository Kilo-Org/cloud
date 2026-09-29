import { EnkryptScoreSchema } from '@kilocode/db/schema-types';
import type { EnkryptScore } from '@kilocode/db/schema-types';
import * as z from 'zod';
import {
  CUSTOM_LLM_PREFIX,
  KILO_AUTO_MODEL_PREFIX,
  KILOCLAW_KILO_PROVIDER_PREFIX,
  KILOCODE_KILO_PROVIDER_PREFIX,
} from '../ai-gateway/model-utils';
import { EnkryptSyncError } from './enkrypt-errors';

export type EnkryptIdentity = Pick<EnkryptScore, 'model_name' | 'provider' | 'source'>;

export type EnkryptModelMapping = {
  identity: EnkryptIdentity;
  modelId: string;
};

export type EnkryptCatalogModel = {
  id: string;
  openrouterId: string;
  isActive: boolean | null;
  isStealth: boolean;
};

export const ENKRYPT_MODEL_MAPPINGS: readonly EnkryptModelMapping[] = [
  {
    identity: { model_name: 'gpt-oss-120b', provider: 'fireworks', source: 'OpenAI' },
    modelId: 'openai/gpt-oss-120b',
  },
  {
    identity: { model_name: 'glm-4.5', provider: 'novita', source: 'zai-org' },
    modelId: 'z-ai/glm-4.5',
  },
  {
    identity: { model_name: 'Qwen3-8B', provider: 'openai_compatible', source: 'qwen' },
    modelId: 'qwen/qwen3-8b',
  },
  {
    identity: { model_name: 'muse-spark-1.1', provider: 'openai_compatible', source: 'Meta' },
    modelId: 'meta/muse-spark-1.1',
  },
  {
    identity: { model_name: 'gpt-5-mini', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/gpt-5-mini',
  },
  {
    identity: { model_name: 'granite-4.0-h-micro', provider: 'openai_compatible', source: 'IBM' },
    modelId: 'ibm-granite/granite-4.0-h-micro',
  },
  {
    identity: { model_name: 'gpt-oss-safeguard-20b', provider: 'groq', source: 'openai' },
    modelId: 'openai/gpt-oss-safeguard-20b',
  },
  {
    identity: { model_name: 'minimax-m2', provider: 'novita', source: 'minimax' },
    modelId: 'minimax/minimax-m2',
  },
  {
    identity: { model_name: 'gpt-5.1', provider: 'openai', source: '' },
    modelId: 'openai/gpt-5.1',
  },
  {
    identity: { model_name: 'gpt-5.2', provider: 'openai', source: '' },
    modelId: 'openai/gpt-5.2',
  },
  {
    identity: { model_name: 'qwen3.5-27b', provider: 'novita', source: 'qwen' },
    modelId: 'qwen/qwen3.5-27b',
  },
  {
    identity: { model_name: 'qwen3.5-397b-a17b', provider: 'novita', source: 'qwen' },
    modelId: 'qwen/qwen3.5-397b-a17b',
  },
  {
    identity: { model_name: 'deepseek-v4-flash', provider: 'novita', source: 'deepseek' },
    modelId: 'deepseek/deepseek-v4-flash',
  },
  {
    identity: { model_name: 'grok-4.3', provider: 'xai', source: 'xai' },
    modelId: 'x-ai/grok-4.3',
  },
  {
    identity: { model_name: 'claude-fable-5', provider: 'anthropic', source: 'anthropic' },
    modelId: 'anthropic/claude-fable-5',
  },
  {
    identity: { model_name: 'claude-sonnet-5', provider: 'anthropic', source: 'anthropic' },
    modelId: 'anthropic/claude-sonnet-5',
  },
  {
    identity: { model_name: 'gpt-oss-20b', provider: 'fireworks', source: 'OpenAI' },
    modelId: 'openai/gpt-oss-20b',
  },
  {
    identity: { model_name: 'gpt-5-nano', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/gpt-5-nano',
  },
  {
    identity: { model_name: 'kimi-k2-thinking', provider: 'novita', source: 'moonshotai' },
    modelId: 'moonshotai/kimi-k2-thinking',
  },
  {
    identity: { model_name: 'qwen3.5-35b-a3b', provider: 'novita', source: 'qwen' },
    modelId: 'qwen/qwen3.5-35b-a3b',
  },
  {
    identity: { model_name: 'glm-5-turbo', provider: 'openrouter', source: 'zai-org' },
    modelId: 'z-ai/glm-5-turbo',
  },
  {
    identity: { model_name: 'deepseek-v4-pro', provider: 'novita', source: 'deepseek' },
    modelId: 'deepseek/deepseek-v4-pro',
  },
  {
    identity: { model_name: 'gpt-5.6-luna', provider: 'openai', source: 'openai' },
    modelId: 'openai/gpt-5.6-luna',
  },
  {
    identity: { model_name: 'gpt-5', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/gpt-5',
  },
  {
    identity: { model_name: 'glm-5.1', provider: 'novita', source: 'zai-org' },
    modelId: 'z-ai/glm-5.1',
  },
  {
    identity: { model_name: 'gpt-5.5', provider: 'openai', source: '' },
    modelId: 'openai/gpt-5.5',
  },
  {
    identity: { model_name: 'gpt-5.6-sol', provider: 'openai', source: 'openai' },
    modelId: 'openai/gpt-5.6-sol',
  },
  {
    identity: { model_name: 'command-r-plus-08-2024', provider: 'cohere', source: 'Cohere' },
    modelId: 'cohere/command-r-plus-08-2024',
  },
  {
    identity: { model_name: 'kimi-k2.5', provider: 'novita', source: 'moonshotai' },
    modelId: 'moonshotai/kimi-k2.5',
  },
  {
    identity: { model_name: 'gpt-5.6-terra', provider: 'openai', source: 'openai' },
    modelId: 'openai/gpt-5.6-terra',
  },
  {
    identity: { model_name: 'command-r7b-12-2024', provider: 'cohere', source: 'Cohere' },
    modelId: 'cohere/command-r7b-12-2024',
  },
  {
    identity: { model_name: 'deepseek-r1-0528', provider: 'fireworks', source: 'accounts' },
    modelId: 'deepseek/deepseek-r1-0528',
  },
  {
    identity: { model_name: 'qwen3.5-122b-a10b', provider: 'novita', source: 'qwen' },
    modelId: 'qwen/qwen3.5-122b-a10b',
  },
  {
    identity: { model_name: 'hy3', provider: 'novita', source: 'tencent' },
    modelId: 'tencent/hy3',
  },
  {
    identity: { model_name: 'qwen3-vl-235b-a22b-instruct', provider: 'novita', source: 'qwen' },
    modelId: 'qwen/qwen3-vl-235b-a22b-instruct',
  },
  {
    identity: { model_name: 'minimax-m2.7', provider: 'novita', source: 'minimax' },
    modelId: 'minimax/minimax-m2.7',
  },
  {
    identity: { model_name: 'gpt-4.1-mini', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/gpt-4.1-mini',
  },
  {
    identity: { model_name: 'gpt-4o-2024-08-06', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/gpt-4o-2024-08-06',
  },
  {
    identity: { model_name: 'gpt-4o-mini', provider: 'OpenAI', source: 'OpenAI' },
    modelId: 'openai/gpt-4o-mini',
  },
  {
    identity: { model_name: 'o1', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/o1',
  },
  {
    identity: { model_name: 'deepseek-v3.2-exp', provider: 'novita', source: 'deepseek' },
    modelId: 'deepseek/deepseek-v3.2-exp',
  },
  {
    identity: { model_name: 'gpt-4.1-nano', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/gpt-4.1-nano',
  },
  {
    identity: { model_name: 'o4-mini', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/o4-mini',
  },
  {
    identity: { model_name: 'glm-4.6', provider: 'novita', source: 'zai-org' },
    modelId: 'z-ai/glm-4.6',
  },
  {
    identity: { model_name: 'gpt-4o', provider: 'OpenAI', source: 'OpenAI' },
    modelId: 'openai/gpt-4o',
  },
  {
    identity: { model_name: 'deepseek-chat', provider: 'deepseek', source: 'deepseek-chat' },
    modelId: 'deepseek/deepseek-chat',
  },
  {
    identity: { model_name: 'gemini-2.5-flash', provider: 'gemini', source: 'Google' },
    modelId: 'google/gemini-2.5-flash',
  },
  {
    identity: { model_name: 'gemini-2.5-pro', provider: 'gemini', source: 'Google' },
    modelId: 'google/gemini-2.5-pro',
  },
  {
    identity: { model_name: 'gemma-2-27b-it', provider: 'together', source: 'google' },
    modelId: 'google/gemma-2-27b-it',
  },
  {
    identity: { model_name: 'gemma-3-12b-it', provider: 'openai_compatible', source: 'google' },
    modelId: 'google/gemma-3-12b-it',
  },
  {
    identity: { model_name: 'gpt-3.5-turbo', provider: 'OpenAI', source: 'OpenAI' },
    modelId: 'openai/gpt-3.5-turbo',
  },
  {
    identity: { model_name: 'gpt-4', provider: 'OpenAI', source: 'OpenAI' },
    modelId: 'openai/gpt-4',
  },
  {
    identity: { model_name: 'gpt-4-turbo', provider: 'OpenAI', source: 'OpenAI' },
    modelId: 'openai/gpt-4-turbo',
  },
  {
    identity: { model_name: 'gpt-4.1', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/gpt-4.1',
  },
  {
    identity: { model_name: 'gemma-3-4b-it', provider: 'openai_compatible', source: 'google' },
    modelId: 'google/gemma-3-4b-it',
  },
  {
    identity: { model_name: 'gemma-3-27b-it', provider: 'openai_compatible', source: 'google' },
    modelId: 'google/gemma-3-27b-it',
  },
  {
    identity: { model_name: 'o3-mini', provider: 'OpenAI', source: 'OpenAI' },
    modelId: 'openai/o3-mini',
  },
  {
    identity: { model_name: 'o3', provider: 'openai', source: 'OpenAI' },
    modelId: 'openai/o3',
  },
  {
    identity: { model_name: 'phi-4', provider: 'HuggingFace', source: 'Microsoft' },
    modelId: 'microsoft/phi-4',
  },
  {
    identity: { model_name: 'qwen3-30b-a3b', provider: 'fireworks', source: 'Qwen' },
    modelId: 'qwen/qwen3-30b-a3b',
  },
  {
    identity: { model_name: 'qwen3-235b-a22b', provider: 'fireworks', source: 'qwen' },
    modelId: 'qwen/qwen3-235b-a22b',
  },
  {
    identity: { model_name: 'Inkling', provider: 'together', source: 'ThinkingMachines' },
    modelId: 'thinkingmachines/inkling',
  },
  {
    identity: { model_name: 'gemma-4-26B-A4B-it', provider: 'openai_compatible', source: 'google' },
    modelId: 'google/gemma-4-26b-a4b-it',
  },
  {
    identity: { model_name: 'WizardLM-2-8x22B', provider: 'Together', source: 'microsoft' },
    modelId: 'microsoft/wizardlm-2-8x22b',
  },
  {
    identity: { model_name: 'gemma-4-31B-it', provider: 'openai_compatible', source: 'google' },
    modelId: 'google/gemma-4-31b-it',
  },
  {
    identity: {
      model_name: 'Hunyuan-A13B-Instruct',
      provider: 'openai_compatible',
      source: 'tencent',
    },
    modelId: 'tencent/hunyuan-a13b-instruct',
  },
  {
    identity: {
      model_name: 'Llama-3.1-8B-Instruct',
      provider: 'openai_compatible',
      source: 'meta',
    },
    modelId: 'meta-llama/llama-3.1-8b-instruct',
  },
  {
    identity: { model_name: 'Llama-3.2-1B-Instruct', provider: 'Hugging Face', source: 'meta' },
    modelId: 'meta-llama/llama-3.2-1b-instruct',
  },
  {
    identity: { model_name: 'Llama-3.2-3B-Instruct', provider: 'Hugging Face', source: 'meta' },
    modelId: 'meta-llama/llama-3.2-3b-instruct',
  },
  {
    identity: {
      model_name: 'Mistral-Small-24B-Instruct-2501',
      provider: 'Together',
      source: 'Mistral',
    },
    modelId: 'mistralai/mistral-small-24b-instruct-2501',
  },
];

export const ENKRYPT_REQUIRED_MODEL_IDS: readonly string[] = [
  'openai/gpt-oss-120b',
  'z-ai/glm-4.5',
  'qwen/qwen3-8b',
];

export type EnkryptRejectedRecord = {
  index: number;
  issues: { path: string[]; code: string }[];
};

export type ParsedEnkryptScores = {
  scores: EnkryptScore[];
  fetchedCount: number;
  rejectedCount: number;
  rejectedRecords: EnkryptRejectedRecord[];
};

const EnkryptResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({ scores: z.array(z.unknown()) }),
});

export function parseEnkryptScores(value: unknown): ParsedEnkryptScores {
  const envelope = EnkryptResponseSchema.safeParse(value);
  if (!envelope.success) {
    throw new EnkryptSyncError('response_validation');
  }

  const scores: EnkryptScore[] = [];
  const rejectedRecords: EnkryptRejectedRecord[] = [];
  envelope.data.data.scores.forEach((value, index) => {
    const result = EnkryptScoreSchema.safeParse(value);
    if (result.success) {
      scores.push(result.data);
    } else {
      rejectedRecords.push({
        index,
        issues: result.error.issues.map(issue => ({
          path: issue.path.map(String),
          code: issue.code,
        })),
      });
    }
  });

  return {
    scores,
    fetchedCount: envelope.data.data.scores.length,
    rejectedCount: rejectedRecords.length,
    rejectedRecords,
  };
}

const excludedPrefixes = [
  CUSTOM_LLM_PREFIX,
  KILO_AUTO_MODEL_PREFIX,
  KILOCLAW_KILO_PROVIDER_PREFIX,
  KILOCODE_KILO_PROVIDER_PREFIX,
  'internal/',
  'private/',
  'custom/',
  'openrouter/',
];

function getIdentity(score: EnkryptScore): EnkryptIdentity {
  return {
    model_name: score.model_name,
    provider: score.provider,
    ...(Object.hasOwn(score, 'source') ? { source: score.source } : {}),
  };
}

export type EnkryptMatchResult = {
  matches: { model: EnkryptCatalogModel; score: EnkryptScore }[];
  unmatchedRecords: {
    identity: EnkryptIdentity;
    reason: 'unreviewed_identity' | 'unavailable_model';
  }[];
  ambiguousRecords: { identity: EnkryptIdentity; modelIds: string[] }[];
  unmatchedModelNames: string[];
  ambiguousCount: number;
  missingRequiredModelIds: string[];
};

export function matchEnkryptScores(
  scores: readonly EnkryptScore[],
  models: readonly EnkryptCatalogModel[],
  mappings: readonly EnkryptModelMapping[] = ENKRYPT_MODEL_MAPPINGS
): EnkryptMatchResult {
  const publicModels = models.filter(
    model =>
      model.isActive === true &&
      model.isStealth === false &&
      /^[^/\s]+\/[^/\s]+$/.test(model.openrouterId) &&
      !excludedPrefixes.some(prefix => model.openrouterId.startsWith(prefix))
  );
  const unmatchedRecords: EnkryptMatchResult['unmatchedRecords'] = [];
  const candidates: {
    score: EnkryptScore;
    modelIds: string[];
    models: EnkryptCatalogModel[];
  }[] = [];
  const candidateCounts = new Map<string, number>();

  for (const score of scores) {
    const modelIds = [
      ...new Set(
        mappings
          .filter(
            ({ identity }) =>
              identity.model_name === score.model_name &&
              identity.provider === score.provider &&
              identity.source === score.source
          )
          .map(mapping => mapping.modelId)
      ),
    ].sort();
    if (modelIds.length === 0) {
      unmatchedRecords.push({ identity: getIdentity(score), reason: 'unreviewed_identity' });
      continue;
    }
    const candidateModels = publicModels.filter(model => modelIds.includes(model.openrouterId));
    if (modelIds.length === 1 && candidateModels.length === 0) {
      unmatchedRecords.push({ identity: getIdentity(score), reason: 'unavailable_model' });
      continue;
    }
    candidates.push({ score, modelIds, models: candidateModels });
    for (const id of new Set(candidateModels.map(model => model.id))) {
      candidateCounts.set(id, (candidateCounts.get(id) ?? 0) + 1);
    }
  }

  const matches: EnkryptMatchResult['matches'] = [];
  const ambiguousRecords: EnkryptMatchResult['ambiguousRecords'] = [];
  for (const candidate of candidates) {
    const [model] = candidate.models;
    if (
      candidate.modelIds.length !== 1 ||
      candidate.models.length !== 1 ||
      !model ||
      candidate.models.some(model => candidateCounts.get(model.id) !== 1)
    ) {
      ambiguousRecords.push({
        identity: getIdentity(candidate.score),
        modelIds: candidate.modelIds,
      });
    } else {
      matches.push({ model, score: candidate.score });
    }
  }

  matches.sort((left, right) => left.model.id.localeCompare(right.model.id));
  const matchedModelIds = new Set(matches.map(({ model }) => model.openrouterId));
  return {
    matches,
    unmatchedRecords,
    ambiguousRecords,
    unmatchedModelNames: unmatchedRecords.map(({ identity }) => identity.model_name),
    ambiguousCount: ambiguousRecords.length,
    missingRequiredModelIds: ENKRYPT_REQUIRED_MODEL_IDS.filter(id => !matchedModelIds.has(id)),
  };
}

export function buildEnkryptCoverageReport(
  parsed: ParsedEnkryptScores,
  models: readonly EnkryptCatalogModel[],
  evidence: 'examples' | 'fullinput'
) {
  const result = matchEnkryptScores(parsed.scores, models);
  return {
    evidence: {
      kind: evidence,
      scope:
        evidence === 'examples'
          ? 'representative-only; not full 267-record coverage; metrics and fixture-provider are synthetic'
          : 'supplied sanitized input; completeness not independently verified',
    },
    counters: {
      fetchedCount: parsed.fetchedCount,
      acceptedCount: parsed.scores.length,
      matchedCount: result.matches.length,
      unmatchedCount: result.unmatchedRecords.length,
      ambiguousCount: result.ambiguousCount,
      rejectedCount: parsed.rejectedCount,
    },
    matchedRecords: result.matches.map(({ model, score }) => ({
      identity: getIdentity(score),
      modelId: model.openrouterId,
    })),
    unmatchedRecords: result.unmatchedRecords,
    ambiguousRecords: result.ambiguousRecords,
    rejectedRecords: parsed.rejectedRecords,
    requiredGate: {
      passed: result.missingRequiredModelIds.length === 0,
      requiredModelIds: ENKRYPT_REQUIRED_MODEL_IDS,
      missingRequiredModelIds: result.missingRequiredModelIds,
    },
  };
}
