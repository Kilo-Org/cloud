export interface ContextUsage {
  readonly promptTokens: number;
}

export const AUTO_COMPACT_RATIO = 0.85;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const getContextRatio = (
  promptTokens: number,
  contextLength: number | undefined
): number | undefined => {
  if (contextLength === undefined || contextLength <= 0) {
    return undefined;
  }

  return clamp01(promptTokens / contextLength);
};

export const getContextTone = (ratio: number): 'danger' | 'safe' | 'warn' => {
  if (ratio >= 0.9) {
    return 'danger';
  }

  if (ratio >= 0.7) {
    return 'warn';
  }

  return 'safe';
};

const formatCount = (value: number): string => value.toLocaleString('en-US');

export const formatContextSummary = (
  promptTokens: number,
  contextLength: number | undefined
): string => {
  if (contextLength === undefined || contextLength <= 0) {
    return `${formatCount(promptTokens)} tokens`;
  }

  // Clamp caps the displayed percent at 100% when prompt tokens exceed the context window.
  const percent = Math.round(clamp01(promptTokens / contextLength) * 100);

  return `${formatCount(promptTokens)} / ${formatCount(contextLength)} tokens (${percent}%)`;
};
