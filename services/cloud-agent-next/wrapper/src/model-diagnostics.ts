import fuzzysort from 'fuzzysort';
import {
  MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SUGGESTIONS,
  type ModelNotFoundRuntimeDiagnostics,
  type ModelNotFoundSuggestionSource,
} from '../../src/shared/runtime-model-diagnostics.js';

const FUZZY_THRESHOLD = -10_000;
const KILO_PROVIDER_PREFIX = 'kilo/';

type CandidateVariant = {
  modelID: string;
  key: string;
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sortModelIds(modelIDs: string[]): string[] {
  return [...modelIDs].sort((left, right) => left.localeCompare(right));
}

function comparisonKeys(modelID: string): string[] {
  const lower = modelID.toLocaleLowerCase();
  const withoutKiloPrefix = lower.startsWith(KILO_PROVIDER_PREFIX)
    ? lower.slice(KILO_PROVIDER_PREFIX.length)
    : lower;
  const suffix = withoutKiloPrefix.split('/').at(-1) ?? withoutKiloPrefix;
  return unique([lower, withoutKiloPrefix, suffix]);
}

function buildCandidateVariants(modelIDs: string[]): CandidateVariant[] {
  return sortModelIds(modelIDs).flatMap(modelID =>
    comparisonKeys(modelID).map(key => ({ modelID, key }))
  );
}

function rankFuzzySuggestions(requestedModel: string, availableModels: string[]): string[] {
  const candidateVariants = buildCandidateVariants(availableModels);
  const bestScores = new Map<string, number>();

  for (const query of comparisonKeys(requestedModel)) {
    const results = fuzzysort.go(query, candidateVariants, {
      key: 'key',
      threshold: FUZZY_THRESHOLD,
      limit: candidateVariants.length,
    });
    for (const result of results) {
      const previousScore = bestScores.get(result.obj.modelID);
      if (previousScore === undefined || result.score > previousScore) {
        bestScores.set(result.obj.modelID, result.score);
      }
    }
  }

  return [...bestScores.entries()]
    .sort(
      ([leftModel, leftScore], [rightModel, rightScore]) =>
        rightScore - leftScore || leftModel.localeCompare(rightModel)
    )
    .slice(0, MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SUGGESTIONS)
    .map(([modelID]) => modelID);
}

export function buildModelNotFoundRuntimeDiagnostics(
  requestedModel: string,
  availableModels: string[]
): ModelNotFoundRuntimeDiagnostics {
  const sortedAvailableModels = sortModelIds(unique(availableModels));
  let suggestedModels: string[] = [];
  let suggestionSource: ModelNotFoundSuggestionSource = 'none';

  if (sortedAvailableModels.length > 0) {
    suggestedModels = rankFuzzySuggestions(requestedModel, sortedAvailableModels);
    suggestionSource = suggestedModels.length > 0 ? 'fuzzy' : 'first-five';
    if (suggestionSource === 'first-five') {
      suggestedModels = sortedAvailableModels.slice(
        0,
        MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SUGGESTIONS
      );
    }
  }

  return {
    requestedModel,
    availableModelCount: sortedAvailableModels.length,
    availableModels: sortedAvailableModels,
    suggestedModels,
    suggestionSource,
  };
}
