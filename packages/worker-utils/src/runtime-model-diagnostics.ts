export const MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_MODEL_ID_LENGTH = 512;
export const MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SUGGESTIONS = 5;
export const MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SERIALIZED_BYTES = 96_000;
export const MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_LOG_CHUNK_SIZE = 50;

export type ModelNotFoundSuggestionSource = 'fuzzy' | 'first-five' | 'none';

export type ModelNotFoundRuntimeDiagnostics = {
  requestedModel: string;
  availableModelCount: number;
  availableModels: string[];
  suggestedModels: string[];
  suggestionSource: ModelNotFoundSuggestionSource;
};

export type ModelNotFoundRuntimeDiagnosticsParseResult =
  | { success: true; data: ModelNotFoundRuntimeDiagnostics; serializedByteLength: number }
  | { success: false; reason: string; serializedByteLength?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializedByteLength(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
}

function isValidModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_MODEL_ID_LENGTH
  );
}

function hasUniqueEntries(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isSuggestionSource(value: unknown): value is ModelNotFoundSuggestionSource {
  return value === 'fuzzy' || value === 'first-five' || value === 'none';
}

export function parseModelNotFoundRuntimeDiagnostics(
  value: unknown
): ModelNotFoundRuntimeDiagnosticsParseResult {
  const serializedLength = serializedByteLength(value);
  if (!isRecord(value)) {
    return {
      success: false,
      reason: 'diagnostic is not an object',
      serializedByteLength: serializedLength,
    };
  }

  const requestedModel = value.requestedModel;
  const availableModelCount = value.availableModelCount;
  const availableModels = value.availableModels;
  const suggestedModels = value.suggestedModels;
  const suggestionSource = value.suggestionSource;

  if (!isValidModelId(requestedModel)) {
    return {
      success: false,
      reason: 'requested model is invalid',
      serializedByteLength: serializedLength,
    };
  }
  if (
    typeof availableModelCount !== 'number' ||
    !Number.isInteger(availableModelCount) ||
    availableModelCount < 0
  ) {
    return {
      success: false,
      reason: 'available model count is invalid',
      serializedByteLength: serializedLength,
    };
  }
  if (!Array.isArray(availableModels) || !availableModels.every(isValidModelId)) {
    return {
      success: false,
      reason: 'available model list is invalid',
      serializedByteLength: serializedLength,
    };
  }
  if (availableModels.length !== availableModelCount) {
    return {
      success: false,
      reason: 'available model count does not match list length',
      serializedByteLength: serializedLength,
    };
  }
  if (!hasUniqueEntries(availableModels)) {
    return {
      success: false,
      reason: 'available model list contains duplicates',
      serializedByteLength: serializedLength,
    };
  }
  if (
    !Array.isArray(suggestedModels) ||
    suggestedModels.length > MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SUGGESTIONS ||
    !suggestedModels.every(isValidModelId)
  ) {
    return {
      success: false,
      reason: 'suggested model list is invalid',
      serializedByteLength: serializedLength,
    };
  }
  if (!hasUniqueEntries(suggestedModels)) {
    return {
      success: false,
      reason: 'suggested model list contains duplicates',
      serializedByteLength: serializedLength,
    };
  }
  if (!isSuggestionSource(suggestionSource)) {
    return {
      success: false,
      reason: 'suggestion source is invalid',
      serializedByteLength: serializedLength,
    };
  }
  if (suggestionSource === 'none' && suggestedModels.length > 0) {
    return {
      success: false,
      reason: 'none suggestion source cannot include suggestions',
      serializedByteLength: serializedLength,
    };
  }
  if (availableModelCount === 0 && (availableModels.length > 0 || suggestedModels.length > 0)) {
    return {
      success: false,
      reason: 'zero model count cannot include models',
      serializedByteLength: serializedLength,
    };
  }

  return {
    success: true,
    data: {
      requestedModel,
      availableModelCount,
      availableModels,
      suggestedModels,
      suggestionSource,
    },
    serializedByteLength: serializedLength ?? 0,
  };
}

export function isModelNotFoundRuntimeDiagnosticsWithinQueueBudget(
  diagnostics: ModelNotFoundRuntimeDiagnostics
): boolean {
  const byteLength = serializedByteLength(diagnostics);
  return (
    byteLength !== undefined &&
    byteLength <= MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SERIALIZED_BYTES
  );
}

export function formatModelNotFoundDashboardError(
  diagnostics: ModelNotFoundRuntimeDiagnostics
): string {
  const prefix = `Model not found: ${diagnostics.requestedModel}. Available runtime models: ${diagnostics.availableModelCount}.`;
  if (diagnostics.availableModelCount === 0 || diagnostics.suggestedModels.length === 0) {
    return prefix;
  }

  const label =
    diagnostics.suggestionSource === 'fuzzy' ? 'Closest matches' : 'Available models include';
  return `${prefix} ${label}: ${diagnostics.suggestedModels.join(', ')}.`;
}
