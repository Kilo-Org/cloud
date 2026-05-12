/**
 * Pools of dimension values used by the mock usage generator.
 *
 * Snowflake groups by `model`, `feature`, `mode`, `provider`, `project_id`,
 * plus the user and org scope. We generate records with enough variety across
 * those dimensions that every breakdown chart has multiple slices.
 */
import { FEATURE_VALUES } from '@/lib/feature-detection';
import { GatewayApiKindSchema } from '@kilocode/db';

export type ModelSpec = {
  id: string;
  provider: string;
  inputCostPerMTokens: number; // microdollars
  outputCostPerMTokens: number; // microdollars
  weight: number;
};

/**
 * Model pool. Costs are approximate microdollars per 1M tokens, matching
 * the scale used by `seed-fake-usage-for-org.ts`. Weights bias the
 * distribution so the breakdown charts are not perfectly uniform.
 */
export const MOCK_MODELS: ModelSpec[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    provider: 'anthropic',
    inputCostPerMTokens: 3_000_000,
    outputCostPerMTokens: 15_000_000,
    weight: 40,
  },
  {
    id: 'anthropic/claude-opus-4.7',
    provider: 'anthropic',
    inputCostPerMTokens: 15_000_000,
    outputCostPerMTokens: 75_000_000,
    weight: 10,
  },
  {
    id: 'openai/gpt-5.4',
    provider: 'openai',
    inputCostPerMTokens: 2_500_000,
    outputCostPerMTokens: 10_000_000,
    weight: 15,
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    provider: 'google',
    inputCostPerMTokens: 1_250_000,
    outputCostPerMTokens: 5_000_000,
    weight: 10,
  },
  {
    id: 'kilo-auto/frontier',
    provider: 'openrouter',
    inputCostPerMTokens: 3_000_000,
    outputCostPerMTokens: 15_000_000,
    weight: 10,
  },
  {
    id: 'kilo-auto/free',
    provider: 'openrouter',
    inputCostPerMTokens: 0,
    outputCostPerMTokens: 0,
    weight: 8,
  },
  {
    id: 'codestral-2508',
    provider: 'mistral',
    inputCostPerMTokens: 200_000,
    outputCostPerMTokens: 600_000,
    weight: 7,
  },
];

/** `codestral-2508` is the autocomplete model — used for autocomplete metrics */
export const AUTOCOMPLETE_MODEL_ID = 'codestral-2508';

export const MOCK_MODES = ['code', 'build', 'architect', 'ask', 'debug', 'plan'] as const;

export const MOCK_EDITORS = ['vscode', 'cursor', 'windsurf', 'jetbrains'] as const;

export const MOCK_AUTO_MODELS = [
  'kilo-auto/frontier',
  'kilo-auto/free',
  'kilo-auto/small',
] as const;

export const MOCK_PROJECT_IDS = [
  '/home/dev/web-app',
  '/home/dev/api-server',
  '/home/dev/infra',
  '/home/dev/docs',
  '/home/dev/mobile',
] as const;

/**
 * The feature pool mirrors the real `FEATURE_VALUES` enum so rollup JOINs
 * on the `feature` lookup table resolve to valid values.
 */
export const MOCK_FEATURES = FEATURE_VALUES;

export const MOCK_API_KINDS = GatewayApiKindSchema.options;

/**
 * Weighted choice from a pool of `{ value, weight }` entries.
 */
export function weightedPick<T>(pool: ReadonlyArray<{ value: T; weight: number }>): T {
  const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
  let r = Math.random() * totalWeight;
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) return p.value;
  }
  return pool[pool.length - 1].value;
}

/** Per-feature weights so e.g. `vscode-extension` dominates. */
export const FEATURE_WEIGHTS: ReadonlyArray<{ value: string; weight: number }> = [
  { value: 'vscode-extension', weight: 50 },
  { value: 'autocomplete', weight: 20 },
  { value: 'cloud-agent', weight: 10 },
  { value: 'code-review', weight: 5 },
  { value: 'cli', weight: 5 },
  { value: 'jetbrains-extension', weight: 4 },
  { value: 'app-builder', weight: 2 },
  { value: 'agent-manager', weight: 1 },
  { value: 'auto-triage', weight: 1 },
  { value: 'autofix', weight: 1 },
  { value: 'managed-indexing', weight: 1 },
];

export const MODE_WEIGHTS: ReadonlyArray<{ value: string; weight: number }> = [
  { value: 'code', weight: 50 },
  { value: 'architect', weight: 15 },
  { value: 'debug', weight: 12 },
  { value: 'ask', weight: 10 },
  { value: 'plan', weight: 8 },
  { value: 'build', weight: 5 },
];

export const EDITOR_WEIGHTS: ReadonlyArray<{ value: string; weight: number }> = [
  { value: 'vscode', weight: 60 },
  { value: 'cursor', weight: 25 },
  { value: 'jetbrains', weight: 10 },
  { value: 'windsurf', weight: 5 },
];

export const API_KIND_WEIGHTS: ReadonlyArray<{ value: string; weight: number }> = [
  { value: 'chat_completions', weight: 50 },
  { value: 'messages', weight: 30 },
  { value: 'responses', weight: 15 },
  { value: 'fim_completions', weight: 4 },
  { value: 'embeddings', weight: 1 },
];
