import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import {
  BenchmarkCatalogVariantsSchema,
  estimateRequestCostUsd,
  getReasoningVariantKeys,
  PoolEntrySchema,
  poolEntryKey,
  ProductionTokenProfileSchema,
  rankCandidates,
  rankValue,
  RANKING_POLICY_VERSION,
  RoutingTableSchema,
  wilsonLowerBound,
  type CandidatePricing,
  type PoolEntry,
  type ProductionTokenProfile,
  type RankedCandidate,
} from '@kilocode/auto-routing-contracts';
import type { DeciderCase } from '../src/datasets/decider-cases';
import { materializeLongContext } from '../src/datasets/long-context';
import { createDeciderJudge } from '../src/decider-judge';
import { gradeDeciderOutput } from '../src/grading';
import { OPENROUTER_APP_TITLE, OPENROUTER_HTTP_REFERER } from '../src/openrouter';
import { BenchmarkModelCatalogSchema, catalogCandidatePrices } from '../src/platform-models';
import { OfflineSweepSchema, type OfflineSweep } from '../src/scoreboard/schema';
import {
  createScreenBudget,
  createScreenCheckpoint,
  runScreenWorkerPool,
} from '../src/scoreboard/screen-runtime';
import {
  requestDirectSweepCompletion,
  selectSweepCases,
  type SweepTokenUsage,
} from '../src/scoreboard/sweep';

const ScreeningModelSchema = BenchmarkModelCatalogSchema.shape.data.element.extend({
  architecture: z.object({ output_modalities: z.array(z.string()) }).optional(),
  supported_parameters: z.array(z.string()).optional(),
  autoRouting: z.unknown().optional(),
  opencode: z
    .object({
      variants: z
        .record(z.string(), BenchmarkCatalogVariantsSchema.valueType.passthrough())
        .optional(),
    })
    .optional(),
});
export const ScreeningCatalogSchema = z.object({ data: z.array(ScreeningModelSchema) });
type ScreeningModel = z.infer<typeof ScreeningModelSchema>;
type Result = OfflineSweep['pairs'][number]['results'][number];
export type ScreenMeasurement = PoolEntry & { results: Result[] };

export const ScreenResumeSchema = z.object({
  startedAt: z.iso.datetime({ offset: true }),
  suite: z.enum(['efficient', 'frontier']),
  tableVersion: z.string().min(1),
  productionTokenProfile: ProductionTokenProfileSchema.nullable(),
  casesPerRoute: z.number().int().positive(),
  costUsd: z.number().nonnegative(),
  graderCostUsd: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().default(0),
  reservedCostUsd: z.number().nonnegative().default(0),
  unsettledCostUsd: z.number().nonnegative().default(0),
  spendIncomplete: z.boolean().default(false),
  sampledCases: z.array(z.object({ id: z.string(), routeKey: z.string() })),
  models: z.array(
    z.object({
      model: z.string(),
      costUnknown: z.boolean().default(false),
      estimatedCostUsd: z.number().nonnegative().default(0),
      variants: z.array(
        z.object({
          variant: z.string().nullable(),
          results: OfflineSweepSchema.shape.pairs.element.shape.results,
        })
      ),
    })
  ),
});
export type ScreenResume = z.infer<typeof ScreenResumeSchema>;

export function restoreScreenMeasurements(
  previous: ScreenResume,
  measurements: ScreenMeasurement[],
  cases: readonly DeciderCase[],
  identity: {
    suite: 'efficient' | 'frontier';
    casesPerRoute: number;
    tableVersion: string;
    profile: ProductionTokenProfile | null;
  }
) {
  if (
    previous.suite !== identity.suite ||
    previous.casesPerRoute !== identity.casesPerRoute ||
    previous.tableVersion !== identity.tableVersion ||
    previous.productionTokenProfile?.uncachedInputTokens !==
      identity.profile?.uncachedInputTokens ||
    previous.productionTokenProfile?.cachedInputTokens !== identity.profile?.cachedInputTokens
  ) {
    throw new Error('Resume screen must use the same suite, sample size, table and cost profile');
  }
  if (previous.spendIncomplete)
    throw new Error('Cannot resume a screen with indeterminate grader spend');
  const casesById = new Map(cases.map(benchCase => [benchCase.id, benchCase]));
  if (
    previous.sampledCases.length !== cases.length ||
    new Set(previous.sampledCases.map(benchCase => benchCase.id)).size !== cases.length ||
    previous.sampledCases.some(saved => {
      const benchCase = casesById.get(saved.id);
      return !benchCase || saved.routeKey !== `${benchCase.taskType}/${benchCase.subtaskType}`;
    })
  )
    throw new Error('Resume screen must use the same sampled cases');
  const savedPairs = new Map<string, Result[]>();
  const savedModels = new Set<string>();
  for (const model of previous.models) {
    if (savedModels.has(model.model)) throw new Error('Resume screen has duplicate models');
    savedModels.add(model.model);
    for (const variant of model.variants) {
      const key = poolEntryKey({ model: model.model, variant: variant.variant });
      if (savedPairs.has(key)) throw new Error('Resume screen has duplicate model/variant pairs');
      const completed = new Set<string>();
      for (const result of variant.results) {
        const benchCase = casesById.get(result.caseId);
        if (
          !benchCase ||
          result.rep !== 0 ||
          result.split !== 'train' ||
          result.routeKey !== `${benchCase.taskType}/${benchCase.subtaskType}` ||
          completed.has(result.caseId)
        ) {
          throw new Error('Resume screen has incompatible or duplicate case results');
        }
        completed.add(result.caseId);
      }
      savedPairs.set(key, variant.results);
    }
  }
  if (
    savedPairs.size !== measurements.length ||
    measurements.some(pair => !savedPairs.has(poolEntryKey(pair))) ||
    savedModels.size !== new Set(measurements.map(pair => pair.model)).size
  ) {
    throw new Error('Resume screen must use the same candidate models and variants');
  }
  for (const pair of measurements) pair.results = savedPairs.get(poolEntryKey(pair)) ?? [];
}

export type ScreenMetrics = {
  cases: number;
  pricedCases: number;
  errors: number;
  accuracy: number | null;
  wilsonLowerBound: number | null;
  avgCostUsd: number | null;
  estimatedRequestCostUsd: number | null;
  p50LatencyMs: number | null;
  p50TtftMs: number | null;
};

export type ScreenModelSpend = {
  costUnknown: boolean;
  estimatedCostUsd: number;
};

export type ScreenRequest = {
  systemPrompt: string;
  userPrompt: string;
  fragment: Record<string, unknown>;
};

export function screenRequestTokenBudget(request: ScreenRequest) {
  return {
    promptTokens: Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4),
    completionTokens: z.number().int().positive().catch(8192).parse(request.fragment.max_tokens),
  };
}

export const GRADER_RESERVE_USD = 0.002;

export function screenGraderReserveUsd(
  input: string,
  pricing: CandidatePricing | null | undefined
) {
  if (!pricing) return GRADER_RESERVE_USD;
  const tokens = screenRequestTokenBudget({
    systemPrompt: '',
    userPrompt: input,
    fragment: {},
  });
  return (
    tokens.promptTokens * pricing.promptUsdPerToken +
    tokens.completionTokens * pricing.completionUsdPerToken
  );
}

export function recordScreenModelCost(
  spend: ScreenModelSpend,
  completion: {
    costUsd: number | null;
    output: string | null;
    error: string | null;
    tokenUsage?: SweepTokenUsage;
  },
  pricing: CandidatePricing,
  request: ScreenRequest
): number {
  if (completion.costUsd !== null) return completion.costUsd;
  if (
    completion.output === null &&
    completion.error !== 'OpenRouter transport or body read failed'
  ) {
    return 0;
  }
  spend.costUnknown = true;
  const usage = completion.tokenUsage;
  const fallback = screenRequestTokenBudget(request);
  const promptTokens = usage?.promptTokens ?? fallback.promptTokens;
  const completionTokens = usage?.completionTokens ?? fallback.completionTokens;
  const estimatedCostUsd =
    promptTokens * pricing.promptUsdPerToken + completionTokens * pricing.completionUsdPerToken;
  spend.estimatedCostUsd += estimatedCostUsd;
  return estimatedCostUsd;
}

export function selectScreenCandidates(
  catalog: z.infer<typeof ScreeningCatalogSchema>,
  pairs: readonly PoolEntry[],
  maxPromptUsdPerMtok: number,
  maxModels?: number
): ScreeningModel[] {
  const currentModels = new Set(pairs.map(pair => pair.model));
  return catalog.data
    .filter(
      model =>
        !currentModels.has(model.id) &&
        model.autoRouting === undefined &&
        model.architecture?.output_modalities.includes('text') &&
        model.supported_parameters?.includes('tools') &&
        model.pricing?.prompt != null &&
        model.pricing.completion != null &&
        model.pricing.prompt * 1_000_000 < maxPromptUsdPerMtok
    )
    .toSorted(
      (a, b) =>
        (a.pricing?.prompt ?? Infinity) - (b.pricing?.prompt ?? Infinity) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, maxModels);
}

export function screenVariants(model: ScreeningModel): (string | null)[] {
  const variants = model.opencode?.variants;
  const effortOrder: Record<string, number> = {
    none: 0,
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
    xhigh: 5,
    max: 6,
  };
  const highest = getReasoningVariantKeys(variants)
    .map(key => {
      const reasoning = variants?.[key]?.reasoning;
      return {
        key,
        effort: reasoning?.enabled === false ? 0 : effortOrder[reasoning?.effort ?? 'high'],
      };
    })
    .toSorted((a, b) => b.effort - a.effort || a.key.localeCompare(b.key))[0];
  return highest === undefined ? [null] : [null, highest.key];
}

export function sampleScreenCases(cases: readonly DeciderCase[], casesPerRoute: number) {
  const routes = new Map<string, { benchCase: DeciderCase; hash: string }[]>();
  for (const benchCase of cases) {
    if (benchCase.taskType === 'agentic_execution') continue;
    const route = `${benchCase.taskType}/${benchCase.subtaskType}`;
    const group = routes.get(route) ?? [];
    group.push({ benchCase, hash: createHash('sha256').update(benchCase.id).digest('hex') });
    routes.set(route, group);
  }
  return [...routes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, group]) =>
      group
        .toSorted(
          (a, b) => a.hash.localeCompare(b.hash) || a.benchCase.id.localeCompare(b.benchCase.id)
        )
        .slice(0, casesPerRoute)
        .map(item => item.benchCase)
    );
}

export function* screenCandidateJobs(pairs: readonly PoolEntry[], cases: readonly DeciderCase[]) {
  const pairIndicesByModel = new Map<string, number[]>();
  let rounds = 0;
  for (const [index, pair] of pairs.entries()) {
    const indices = pairIndicesByModel.get(pair.model) ?? [];
    indices.push(index);
    pairIndicesByModel.set(pair.model, indices);
    rounds = Math.max(rounds, indices.length * cases.length);
  }
  for (let round = 0; round < rounds; round++) {
    for (const indices of pairIndicesByModel.values()) {
      const benchCase = cases[Math.floor(round / indices.length)];
      if (benchCase) yield { pairIndex: indices[round % indices.length], benchCase };
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}

export function screenMetrics(
  results: readonly Result[],
  pricing: CandidatePricing,
  profile: ProductionTokenProfile | null
): ScreenMetrics {
  const graded = results.filter(
    (result): result is Result & { score: number } =>
      result.score !== null &&
      (result.error === null ||
        result.error === 'usage_missing' ||
        result.error === 'OpenRouter response is missing answer content')
  );
  const accuracy =
    graded.length > 0
      ? graded.reduce((sum, result) => sum + result.score, 0) / graded.length
      : null;
  const costs = graded.flatMap(result => (result.costUsd === null ? [] : [result.costUsd]));
  const avgCostUsd =
    costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : null;
  return {
    cases: graded.length,
    pricedCases: costs.length,
    errors: results.length - graded.length,
    accuracy,
    wilsonLowerBound: accuracy === null ? null : wilsonLowerBound(accuracy, graded.length),
    avgCostUsd,
    estimatedRequestCostUsd:
      avgCostUsd === null ? null : estimateRequestCostUsd({ avgCostUsd, pricing }, profile),
    p50LatencyMs: median(graded.map(result => result.latencyMs)),
    p50TtftMs: median(graded.flatMap(result => (result.ttftMs == null ? [] : [result.ttftMs]))),
  };
}

export function screenRouteComparison(input: {
  model: string;
  variant: string | null;
  metrics: ScreenMetrics;
  expectedCases: number;
  incumbent: RankedCandidate | undefined;
  pricing: CandidatePricing;
  incumbentPricing: CandidatePricing | null;
  profile: ProductionTokenProfile | null;
  minAccuracy: number;
}) {
  const { metrics, incumbent, profile } = input;
  if (
    !incumbent ||
    metrics.accuracy === null ||
    metrics.avgCostUsd === null ||
    metrics.cases < input.expectedCases ||
    metrics.errors > 0 ||
    metrics.pricedCases !== metrics.cases ||
    (profile !== null && input.incumbentPricing === null)
  ) {
    return { beatsCurrentPick: false, value: null, currentValue: null };
  }
  const candidate = {
    model: input.model,
    variant: input.variant,
    accuracy: metrics.accuracy,
    cases: metrics.cases,
    avgCostUsd: metrics.avgCostUsd,
    p50LatencyMs: metrics.p50LatencyMs,
    p50TtftMs: metrics.p50TtftMs,
    pricing: input.pricing,
  };
  const current = {
    ...incumbent,
    p50LatencyMs: incumbent.p50LatencyMs ?? null,
    pricing: input.incumbentPricing,
  };
  const value = rankValue({ ...candidate, avgCostUsd: estimateRequestCostUsd(candidate, profile) });
  const currentValue = rankValue({
    ...current,
    avgCostUsd: estimateRequestCostUsd(current, profile),
  });
  const first = rankCandidates([current, candidate], input.minAccuracy, { profile })[0];
  return {
    beatsCurrentPick:
      Number.isFinite(value) &&
      Number.isFinite(currentValue) &&
      value < currentValue &&
      first.model === candidate.model &&
      first.variant === candidate.variant,
    value: Number.isFinite(value) ? value : null,
    currentValue: Number.isFinite(currentValue) ? currentValue : null,
  };
}

export function screenRecommendation(
  variants: readonly {
    routes: readonly { routeKey: string; beatsCurrentPick: boolean }[];
  }[]
) {
  const beatsCurrentPickRoutes = new Set<string>();
  let recommend = false;
  for (const variant of variants) {
    const variantRoutes = new Set<string>();
    for (const route of variant.routes) {
      if (!route.beatsCurrentPick) continue;
      variantRoutes.add(route.routeKey);
      beatsCurrentPickRoutes.add(route.routeKey);
    }
    if (variantRoutes.size >= 2) recommend = true;
  }
  return { beatsCurrentPickRoutes: [...beatsCurrentPickRoutes].sort(), recommend };
}

async function main() {
  const { values } = parseArgs({
    options: {
      catalog: { type: 'string', default: 'live' },
      'catalog-file': { type: 'string' },
      pairs: { type: 'string' },
      suite: { type: 'string', default: 'efficient' },
      'max-prompt-usd-per-mtok': { type: 'string' },
      'max-models': { type: 'string' },
      'cases-per-route': { type: 'string', default: '4' },
      'max-usd': { type: 'string' },
      concurrency: { type: 'string', default: '24' },
      resume: { type: 'string' },
      'cost-profile': { type: 'string' },
      table: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (
    !values.pairs ||
    !values.out ||
    !values.table ||
    values['max-usd'] === undefined ||
    values['max-prompt-usd-per-mtok'] === undefined
  ) {
    throw new Error(
      'Usage: screen:candidates --catalog live|file --catalog-file catalog.json --pairs current-pairs.json --suite efficient|frontier --max-prompt-usd-per-mtok <n> [--max-models <n>] --cases-per-route 4 --concurrency 24 --max-usd <n> --table table.json [--cost-profile profile.json] [--resume screen.json] --out screen.json'
    );
  }
  const out = values.out;
  const suite = z.enum(['efficient', 'frontier']).parse(values.suite);
  const casesPerRoute = z.coerce.number().int().positive().parse(values['cases-per-route']);
  const maxUsd = z.coerce.number().nonnegative().parse(values['max-usd']);
  const concurrency = z.coerce.number().int().positive().parse(values.concurrency);
  const maxPromptUsdPerMtok = z.coerce
    .number()
    .nonnegative()
    .parse(values['max-prompt-usd-per-mtok']);
  const maxModels =
    values['max-models'] === undefined
      ? undefined
      : z.coerce.number().int().positive().parse(values['max-models']);
  const pairs = z.array(PoolEntrySchema).parse(JSON.parse(await readFile(values.pairs, 'utf8')));
  const table = RoutingTableSchema.parse(JSON.parse(await readFile(values.table, 'utf8')));
  const profile = values['cost-profile']
    ? ProductionTokenProfileSchema.parse(JSON.parse(await readFile(values['cost-profile'], 'utf8')))
    : (table.productionTokenProfile ?? null);
  let catalog: z.infer<typeof ScreeningCatalogSchema>;
  if (values.catalog === 'live') {
    const response = await fetch('https://app.kilo.ai/api/openrouter/models', {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status}`);
    catalog = ScreeningCatalogSchema.parse(await response.json());
  } else {
    const path = values.catalog === 'file' ? values['catalog-file'] : values.catalog;
    if (!path) throw new Error('--catalog file requires --catalog-file <path>');
    catalog = ScreeningCatalogSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }
  const prices = catalogCandidatePrices(catalog);
  const candidates = selectScreenCandidates(catalog, pairs, maxPromptUsdPerMtok, maxModels);
  const suiteCases = selectSweepCases(suite);
  const cases = sampleScreenCases(suiteCases, casesPerRoute);
  const previous = values.resume
    ? ScreenResumeSchema.parse(JSON.parse(await readFile(values.resume, 'utf8')))
    : null;
  const casesByRoute = new Map<string, number>();
  for (const benchCase of cases) {
    const route = `${benchCase.taskType}/${benchCase.subtaskType}`;
    casesByRoute.set(route, (casesByRoute.get(route) ?? 0) + 1);
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (maxUsd > 0 && candidates.length > 0 && !apiKey)
    throw new Error('OPENROUTER_API_KEY is required');
  const attributionHeaders = {
    'HTTP-Referer': OPENROUTER_HTTP_REFERER,
    'X-Title': OPENROUTER_APP_TITLE,
  };
  const judgeModel = 'typesafe/jev-1.13';
  const judgePricing = prices.get(judgeModel);
  const baseJudge = apiKey ? createDeciderJudge({ apiKey, attributionHeaders }, judgeModel) : null;
  const measurements: ScreenMeasurement[] = candidates.flatMap(model =>
    screenVariants(model).map(variant => ({
      model: model.id,
      variant,
      results: [],
    }))
  );
  if (previous)
    restoreScreenMeasurements(previous, measurements, cases, {
      suite,
      casesPerRoute,
      tableVersion: table.version,
      profile,
    });
  const modelSpend = new Map<string, ScreenModelSpend>(
    candidates.map(model => [model.id, { costUnknown: false, estimatedCostUsd: 0 }])
  );
  for (const model of previous?.models ?? []) {
    modelSpend.set(model.model, {
      costUnknown: model.costUnknown,
      estimatedCostUsd: model.estimatedCostUsd,
    });
  }
  const report = {
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    suite,
    rankingPolicy: RANKING_POLICY_VERSION,
    tableVersion: table.version,
    productionTokenProfile: profile,
    casesPerRoute,
    maxUsd,
    concurrency,
    maxPromptUsdPerMtok,
    maxModels: maxModels ?? null,
    costUsd: previous?.costUsd ?? 0,
    graderCostUsd: previous?.graderCostUsd ?? 0,
    estimatedCostUsd: previous?.estimatedCostUsd ?? 0,
    unsettledCostUsd: (previous?.unsettledCostUsd ?? 0) + (previous?.reservedCostUsd ?? 0),
    truncated: false,
    spendIncomplete: false,
    excludedRoutes: [
      ...new Set(
        suiteCases
          .filter(benchCase => benchCase.taskType === 'agentic_execution')
          .map(benchCase => `${benchCase.taskType}/${benchCase.subtaskType}`)
      ),
    ].sort(),
    sampledCases: cases.map(benchCase => ({
      id: benchCase.id,
      routeKey: `${benchCase.taskType}/${benchCase.subtaskType}`,
    })),
  };
  const budget = createScreenBudget(
    maxUsd,
    report.costUsd + report.graderCostUsd + report.unsettledCostUsd
  );
  const budgetAvailable = () =>
    !report.spendIncomplete && !report.truncated && budget.spentUsd < maxUsd;
  const judge: typeof baseJudge = baseJudge
    ? async input => {
        const estimate = screenGraderReserveUsd(JSON.stringify(input), judgePricing);
        const reservation = await budget.reserve(estimate);
        if (!reservation) {
          report.truncated = true;
          throw new Error('Screen budget exhausted before grading');
        }
        try {
          await checkpoint();
        } catch (error) {
          reservation.settle(0);
          budget.stop();
          throw error;
        }
        try {
          const result = await baseJudge(input);
          report.graderCostUsd += result.costUsd;
          reservation.settle(result.costUsd);
          return result;
        } catch (error) {
          report.graderCostUsd += estimate;
          reservation.settle(estimate);
          report.spendIncomplete = true;
          budget.stop();
          throw error;
        }
      }
    : null;
  const snapshot = () => ({
    ...report,
    reservedCostUsd: budget.reservedUsd,
    models: candidates.map(model => {
      const pricing = prices.get(model.id);
      if (!pricing) throw new Error(`Candidate pricing missing: ${model.id}`);
      const spend = modelSpend.get(model.id);
      if (!spend) throw new Error(`Candidate spend missing: ${model.id}`);
      const variants = measurements
        .filter(pair => pair.model === model.id)
        .map(pair => {
          const routes = [...casesByRoute].map(([routeKey, expectedCases]) => {
            const metrics = screenMetrics(
              pair.results.filter(result => result.routeKey === routeKey),
              pricing,
              profile
            );
            const incumbent = table.routes[routeKey]?.[0];
            return {
              routeKey,
              expectedCases,
              ...metrics,
              currentPick: incumbent
                ? {
                    model: incumbent.model,
                    variant: incumbent.variant ?? incumbent.reasoningEffort ?? null,
                  }
                : null,
              ...screenRouteComparison({
                model: model.id,
                variant: pair.variant,
                metrics,
                expectedCases,
                incumbent,
                pricing,
                incumbentPricing: incumbent
                  ? (prices.get(incumbent.model) ?? incumbent.pricing ?? null)
                  : null,
                profile,
                minAccuracy: table.minAccuracy,
              }),
            };
          });
          return {
            variant: pair.variant,
            ...screenMetrics(pair.results, pricing, profile),
            routes,
            results: pair.results,
          };
        });
      const recommendation = screenRecommendation(variants);
      return {
        model: model.id,
        pricing,
        ...spend,
        ...screenMetrics(
          variants.flatMap(variant => variant.results),
          pricing,
          profile
        ),
        ...recommendation,
        recommend: !spend.costUnknown && recommendation.recommend,
        variants,
      };
    }),
  });
  const checkpoint = createScreenCheckpoint(out, snapshot);
  await checkpoint();
  const materializedCases = new Map<string, { systemPrompt: string; userPrompt: string }>();
  const completedCases = measurements.map(
    pair => new Set(pair.results.map(result => result.caseId))
  );
  const jobs = screenCandidateJobs(measurements, cases);
  try {
    await runScreenWorkerPool(jobs, concurrency, async ({ pairIndex, benchCase }) => {
      const pair = measurements[pairIndex];
      const spend = modelSpend.get(pair.model);
      if (!spend) throw new Error(`Candidate spend missing: ${pair.model}`);
      if (spend.costUnknown || completedCases[pairIndex].has(benchCase.id)) return;
      if (!budgetAvailable()) {
        report.truncated = true;
        return;
      }
      let prompts = materializedCases.get(benchCase.id);
      if (!prompts) {
        prompts = benchCase.longContext ? materializeLongContext(benchCase) : benchCase;
        materializedCases.set(benchCase.id, prompts);
      }
      const model = candidates.find(candidate => candidate.id === pair.model);
      if (!model || !apiKey) throw new Error('Candidate request prerequisites missing');
      const variantFragment =
        pair.variant === null ? {} : (model.opencode?.variants?.[pair.variant] ?? {});
      const tokens = screenRequestTokenBudget({
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        fragment: variantFragment,
      });
      const fragment = { ...variantFragment, max_tokens: tokens.completionTokens };
      const pricing = prices.get(pair.model);
      if (!pricing) throw new Error(`Candidate pricing missing: ${pair.model}`);
      const estimate =
        tokens.promptTokens * pricing.promptUsdPerToken +
        tokens.completionTokens * pricing.completionUsdPerToken;
      let reservation: { settle: (costUsd: number) => void } | null = null;
      const completion = await requestDirectSweepCompletion({
        model: pair.model,
        fragment,
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        apiKey,
        attributionHeaders,
        budgetAvailable: () => budgetAvailable() && !spend.costUnknown,
        beforeRequest: async () => {
          reservation = await budget.reserve(estimate);
          if (!reservation) {
            report.truncated = true;
            return false;
          }
          if (spend.costUnknown || !budgetAvailable()) {
            reservation.settle(0);
            reservation = null;
            return false;
          }
          try {
            await checkpoint();
          } catch (error) {
            reservation.settle(0);
            reservation = null;
            budget.stop();
            throw error;
          }
          if (spend.costUnknown || !budgetAvailable()) {
            reservation.settle(0);
            reservation = null;
          }
          return reservation !== null;
        },
        onAttemptComplete: attempt => {
          if (!reservation) throw new Error('Screen request has no budget reservation');
          const previousEstimate = spend.estimatedCostUsd;
          const costUsd = recordScreenModelCost(spend, attempt, pricing, {
            systemPrompt: prompts.systemPrompt,
            userPrompt: prompts.userPrompt,
            fragment,
          });
          report.costUsd += costUsd;
          report.estimatedCostUsd += spend.estimatedCostUsd - previousEstimate;
          reservation.settle(costUsd);
          reservation = null;
        },
      });
      if (completion.error === 'Sweep budget exhausted before request') return;
      const grade =
        completion.output === null || completion.output === '' || spend.costUnknown
          ? null
          : await gradeDeciderOutput(benchCase.check, {
              userPrompt: prompts.userPrompt,
              output: completion.output,
              judge,
            });
      pair.results.push({
        caseId: benchCase.id,
        rep: 0,
        routeKey: `${benchCase.taskType}/${benchCase.subtaskType}`,
        split: 'train',
        score: completion.output === '' ? 0 : (grade?.score ?? null),
        costUsd: completion.costUsd,
        graderCostUsd: grade?.costUsd ?? 0,
        latencyMs: completion.latencyMs,
        ttftMs: completion.ttftMs,
        error:
          grade && grade.score === null
            ? 'grader_failed'
            : (grade?.graderError ?? completion.error),
        output: completion.output,
      });
      completedCases[pairIndex].add(benchCase.id);
      await checkpoint();
    });
  } finally {
    await checkpoint();
  }
  console.log(`Saved candidate screen to ${out}${report.truncated ? ' (truncated)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Candidate screen failed');
    process.exitCode = 1;
  });
}
