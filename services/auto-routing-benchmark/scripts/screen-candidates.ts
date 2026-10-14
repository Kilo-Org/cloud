import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import {
  BenchmarkCatalogVariantsSchema,
  estimateRequestCostUsd,
  getReasoningVariantKeys,
  PoolEntrySchema,
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
import type { OfflineSweep } from '../src/scoreboard/schema';
import { requestDirectSweepCompletion, selectSweepCases } from '../src/scoreboard/sweep';

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

export function selectScreenCandidates(
  catalog: z.infer<typeof ScreeningCatalogSchema>,
  pairs: readonly PoolEntry[],
  maxPromptUsdPerMtok: number
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
    .toSorted((a, b) => a.id.localeCompare(b.id));
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

async function main() {
  const { values } = parseArgs({
    options: {
      catalog: { type: 'string', default: 'live' },
      'catalog-file': { type: 'string' },
      pairs: { type: 'string' },
      suite: { type: 'string', default: 'efficient' },
      'max-prompt-usd-per-mtok': { type: 'string' },
      'cases-per-route': { type: 'string', default: '4' },
      'max-usd': { type: 'string' },
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
      'Usage: screen:candidates --catalog live|file --catalog-file catalog.json --pairs current-pairs.json --suite efficient|frontier --max-prompt-usd-per-mtok <n> --cases-per-route 4 --max-usd <n> --table table.json [--cost-profile profile.json] --out screen.json'
    );
  }
  const out = values.out;
  const suite = z.enum(['efficient', 'frontier']).parse(values.suite);
  const casesPerRoute = z.coerce.number().int().positive().parse(values['cases-per-route']);
  const maxUsd = z.coerce.number().nonnegative().parse(values['max-usd']);
  const maxPromptUsdPerMtok = z.coerce
    .number()
    .nonnegative()
    .parse(values['max-prompt-usd-per-mtok']);
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
  const candidates = selectScreenCandidates(catalog, pairs, maxPromptUsdPerMtok);
  const suiteCases = selectSweepCases(suite);
  const cases = sampleScreenCases(suiteCases, casesPerRoute);
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
  const baseJudge = apiKey ? createDeciderJudge({ apiKey, attributionHeaders }) : null;
  const measurements = candidates.flatMap(model =>
    screenVariants(model).map(variant => ({
      model: model.id,
      variant,
      results: [] as Result[],
    }))
  );
  const report = {
    startedAt: new Date().toISOString(),
    suite,
    rankingPolicy: RANKING_POLICY_VERSION,
    tableVersion: table.version,
    productionTokenProfile: profile,
    casesPerRoute,
    maxUsd,
    maxPromptUsdPerMtok,
    costUsd: 0,
    graderCostUsd: 0,
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
  const budgetAvailable = () =>
    !report.spendIncomplete && report.costUsd + report.graderCostUsd < maxUsd;
  const judge: typeof baseJudge = baseJudge
    ? async input => {
        if (!budgetAvailable()) throw new Error('Screen budget exhausted before grading');
        try {
          const result = await baseJudge(input);
          report.graderCostUsd += result.costUsd;
          return result;
        } catch (error) {
          report.spendIncomplete = true;
          throw error;
        }
      }
    : null;
  const snapshot = () => ({
    ...report,
    models: candidates.map(model => {
      const pricing = prices.get(model.id);
      if (!pricing) throw new Error(`Candidate pricing missing: ${model.id}`);
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
      const beatsCurrentPickRoutes = [
        ...new Set(
          variants.flatMap(variant =>
            variant.routes.filter(route => route.beatsCurrentPick).map(route => route.routeKey)
          )
        ),
      ].sort();
      return {
        model: model.id,
        pricing,
        ...screenMetrics(
          variants.flatMap(variant => variant.results),
          pricing,
          profile
        ),
        beatsCurrentPickRoutes,
        recommend: beatsCurrentPickRoutes.length >= 2,
        variants,
      };
    }),
  });
  const checkpoint = async () => {
    await writeFile(`${out}.partial`, `${JSON.stringify(snapshot(), null, 2)}\n`);
    await rename(`${out}.partial`, out);
  };
  await checkpoint();
  for (const benchCase of cases) {
    if (measurements.length === 0) break;
    if (!budgetAvailable()) {
      report.truncated = true;
      break;
    }
    const prompts = benchCase.longContext ? materializeLongContext(benchCase) : benchCase;
    for (const pair of measurements) {
      if (!budgetAvailable()) {
        report.truncated = true;
        break;
      }
      const model = candidates.find(candidate => candidate.id === pair.model);
      if (!model || !apiKey) throw new Error('Candidate request prerequisites missing');
      const completion = await requestDirectSweepCompletion({
        model: pair.model,
        fragment: pair.variant === null ? {} : (model.opencode?.variants?.[pair.variant] ?? {}),
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        apiKey,
        attributionHeaders,
        budgetAvailable,
      });
      if (completion.costUsd !== null) report.costUsd += completion.costUsd;
      if (
        (completion.output !== null && completion.costUsd === null) ||
        completion.error === 'OpenRouter transport or body read failed'
      ) {
        report.spendIncomplete = true;
      }
      const grade =
        completion.output === null || completion.output === ''
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
      await checkpoint();
    }
    if (report.truncated) break;
  }
  await checkpoint();
  console.log(`Saved candidate screen to ${out}${report.truncated ? ' (truncated)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Candidate screen failed');
    process.exitCode = 1;
  });
}
