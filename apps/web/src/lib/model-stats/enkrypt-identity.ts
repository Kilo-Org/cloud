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
