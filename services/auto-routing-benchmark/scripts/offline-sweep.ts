import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { PoolEntrySchema, poolEntryKey } from '@kilocode/auto-routing-contracts';
import { DECIDER_CASES, type DeciderCase } from '../src/datasets/decider-cases';
import { createDeciderJudge } from '../src/decider-judge';
import { gradeDeciderOutput } from '../src/grading';
import { OPENROUTER_APP_TITLE, OPENROUTER_HTTP_REFERER } from '../src/openrouter';
import { OfflineSweepSchema, type OfflineSweep } from '../src/scoreboard/schema';

const catalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      opencode: z
        .object({ variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional() })
        .optional(),
    })
  ),
});
const usageSchema = z.object({ usage: z.object({ cost: z.number().nonnegative() }) });
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

type SweepResult = OfflineSweep['pairs'][number]['results'][number];

function caseSplit(caseId: string): SweepResult['split'] {
  return createHash('sha256').update(caseId).digest().readUInt8(0) % 2 === 0 ? 'train' : 'heldOut';
}

function summarize(sweep: OfflineSweep): OfflineSweep['summaries'] {
  return sweep.pairs.flatMap(pair => {
    const groups = new Map<string, SweepResult[]>();
    for (const result of pair.results) {
      const key = JSON.stringify([result.routeKey, result.split]);
      const group = groups.get(key);
      if (group) group.push(result);
      else groups.set(key, [result]);
    }
    return [...groups.values()].map(results => {
      const latencies = results.map(result => result.latencyMs).sort((a, b) => a - b);
      const middle = Math.floor(latencies.length / 2);
      return {
        model: pair.model,
        variant: pair.variant,
        routeKey: results[0].routeKey,
        split: results[0].split,
        accuracy: results.reduce((sum, result) => sum + result.score, 0) / results.length,
        cases: results.length,
        avgCostUsd: results.reduce((sum, result) => sum + result.costUsd, 0) / results.length,
        p50LatencyMs:
          latencies.length % 2 === 0
            ? (latencies[middle - 1] + latencies[middle]) / 2
            : latencies[middle],
      };
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      pairs: { type: 'string' },
      catalog: { type: 'string', default: 'live' },
      reps: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '16' },
      'max-usd': { type: 'string' },
      out: { type: 'string' },
      resume: { type: 'string' },
    },
  });
  if (!values.pairs || !values.out || values['max-usd'] === undefined) {
    throw new Error(
      'Usage: sweep:offline --pairs pairs.json --catalog live|file.json --reps 1 --concurrency 16 --max-usd <n> --out sweep.json [--resume sweep.json]'
    );
  }
  const reps = z.coerce.number().int().positive().parse(values.reps);
  const concurrency = z.coerce.number().int().positive().parse(values.concurrency);
  const maxUsd = z.coerce.number().nonnegative().parse(values['max-usd']);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const attributionHeaders = {
    'HTTP-Referer': OPENROUTER_HTTP_REFERER,
    'X-Title': OPENROUTER_APP_TITLE,
  };
  const pairs = z.array(PoolEntrySchema).min(1).parse(JSON.parse(await readFile(values.pairs, 'utf8')));
  const pairKeys = new Set(pairs.map(poolEntryKey));
  if (pairKeys.size !== pairs.length) throw new Error('Pairs must be unique');
  const catalogPath = values.catalog ?? 'live';
  let catalog: z.infer<typeof catalogSchema>;
  if (catalogPath === 'live') {
    const response = await fetch('https://app.kilo.ai/api/openrouter/models', {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status}`);
    catalog = catalogSchema.parse(await response.json());
  } else {
    catalog = catalogSchema.parse(JSON.parse(await readFile(catalogPath, 'utf8')));
  }
  const catalogModels = new Map(catalog.data.map(model => [model.id, model]));
  const fragments = pairs.map(pair => {
    const model = catalogModels.get(pair.model);
    if (!model) throw new Error(`Model missing from catalog: ${pair.model}`);
    if (pair.variant === null) return {};
    const fragment = model.opencode?.variants?.[pair.variant];
    if (!fragment) throw new Error(`Variant missing from catalog: ${poolEntryKey(pair)}`);
    return fragment;
  });
  const previous = values.resume
    ? OfflineSweepSchema.parse(JSON.parse(await readFile(values.resume, 'utf8')))
    : null;
  if (
    previous &&
    (previous.pairs.length !== pairs.length ||
      previous.pairs.some(pair => !pairKeys.has(poolEntryKey(pair))))
  ) {
    throw new Error('Resume sweep must have the same model/variant pairs');
  }
  const previousPairs = new Map(previous?.pairs.map(pair => [poolEntryKey(pair), pair]) ?? []);
  const sweep: OfflineSweep = {
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    truncated: false,
    costUsd: previous?.costUsd ?? 0,
    graderCostUsd: previous?.graderCostUsd ?? 0,
    pairs: pairs.map(pair => ({
      ...pair,
      results: previousPairs.get(poolEntryKey(pair))?.results ?? [],
    })),
    summaries: [],
  };
  const cases = DECIDER_CASES.filter(benchCase => benchCase.taskType !== 'agentic_execution');
  const casesById = new Map(cases.map(benchCase => [benchCase.id, benchCase]));
  const jobs: { pairIndex: number; benchCase: DeciderCase; rep: number }[] = [];
  for (const [pairIndex, pair] of sweep.pairs.entries()) {
    const done = new Set<string>();
    for (const result of pair.results) {
      const benchCase = casesById.get(result.caseId);
      const key = JSON.stringify([result.caseId, result.rep]);
      if (
        !benchCase ||
        result.rep >= reps ||
        result.routeKey !== `${benchCase.taskType}/${benchCase.subtaskType}` ||
        result.split !== caseSplit(result.caseId) ||
        done.has(key)
      ) {
        throw new Error('Resume sweep has incompatible or duplicate case results');
      }
      done.add(key);
    }
    for (let rep = 0; rep < reps; rep++) {
      for (const benchCase of cases) {
        if (!done.has(JSON.stringify([benchCase.id, rep]))) jobs.push({ pairIndex, benchCase, rep });
      }
    }
  }
  const budgetAvailable = () => {
    if (sweep.costUsd + sweep.graderCostUsd < maxUsd) return true;
    sweep.truncated = true;
    return false;
  };
  const baseJudge = createDeciderJudge({ apiKey, attributionHeaders });
  const judge: typeof baseJudge = async input => {
    if (!budgetAvailable()) throw new Error('Sweep budget exhausted before grading');
    const result = await baseJudge(input);
    sweep.graderCostUsd += result.costUsd;
    return result;
  };
  let writes = Promise.resolve();
  const out = values.out;
  const checkpoint = () => {
    sweep.summaries = summarize(sweep);
    const snapshot = `${JSON.stringify(sweep, null, 2)}\n`;
    writes = writes.then(async () => {
      await writeFile(`${out}.partial`, snapshot);
      await rename(`${out}.partial`, out);
    });
    return writes;
  };
  await checkpoint();
  let nextJob = 0;
  let completed = 0;
  let stopping = false;
  const worker = async () => {
    while (!stopping && nextJob < jobs.length) {
      if (!budgetAvailable()) return;
      const { pairIndex, benchCase, rep } = jobs[nextJob++];
      const pair = sweep.pairs[pairIndex];
      const started = performance.now();
      let modelCostUsd = 0;
      let graderCostUsd = 0;
      let score = 0;
      let error: string | null = null;
      let output: string | null = null;
      const body = JSON.stringify({
        ...fragments[pairIndex],
        model: pair.model,
        messages: [
          { role: 'system', content: benchCase.systemPrompt },
          { role: 'user', content: benchCase.userPrompt },
        ],
        usage: { include: true },
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!budgetAvailable()) {
          error = 'Sweep budget exhausted before request';
          break;
        }
        let retry = false;
        try {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              ...attributionHeaders,
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(170_000),
          });
          const text = await response.text();
          if (!response.ok) {
            error = `OpenRouter returned HTTP ${response.status}`;
            retry = response.status === 429 || response.status >= 500;
          } else {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              error = 'OpenRouter returned invalid JSON';
              break;
            }
            const usage = usageSchema.safeParse(parsed);
            if (!usage.success) {
              error = 'OpenRouter response is missing valid usage.cost';
              break;
            }
            modelCostUsd += usage.data.usage.cost;
            sweep.costUsd += usage.data.usage.cost;
            const completion = completionSchema.safeParse(parsed);
            if (!completion.success || completion.data.choices[0].message.content.length === 0) {
              error = 'OpenRouter response is missing answer content';
              break;
            }
            output = completion.data.choices[0].message.content;
            error = null;
            break;
          }
        } catch {
          error = 'OpenRouter transport or body read failed';
          retry = true;
        }
        if (!retry || attempt === 2) break;
        await delay(1_000 * 2 ** attempt);
      }
      const latencyMs = performance.now() - started;
      if (output !== null) {
        const grade = await gradeDeciderOutput(benchCase.check, {
          userPrompt: benchCase.userPrompt,
          output,
          judge,
        });
        score = grade.score;
        graderCostUsd = grade.costUsd;
        error = grade.graderError;
      }
      pair.results.push({
        caseId: benchCase.id,
        rep,
        routeKey: `${benchCase.taskType}/${benchCase.subtaskType}`,
        split: caseSplit(benchCase.id),
        score,
        costUsd: modelCostUsd,
        graderCostUsd,
        latencyMs,
        error,
      });
      completed++;
      if (completed % 200 === 0) {
        try {
          await checkpoint();
        } catch (writeError) {
          stopping = true;
          throw writeError;
        }
      }
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, jobs.length) }, worker)
  );
  await checkpoint();
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
  console.log(`Saved ${sweep.pairs.reduce((sum, pair) => sum + pair.results.length, 0)} case results to ${out}${sweep.truncated ? ' (truncated)' : ''}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Offline sweep failed');
  process.exitCode = 1;
});
