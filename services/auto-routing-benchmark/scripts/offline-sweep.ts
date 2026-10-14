import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { PoolEntrySchema, poolEntryKey } from '@kilocode/auto-routing-contracts';
import type { DeciderCase } from '../src/datasets/decider-cases';
import { materializeLongContext } from '../src/datasets/long-context';
import { parseKiloRunEvents } from '../src/kilo-events';
import { createDeciderJudge } from '../src/decider-judge';
import { gradeDeciderOutput } from '../src/grading';
import { OPENROUTER_APP_TITLE, OPENROUTER_HTTP_REFERER } from '../src/openrouter';
import { OfflineSweepSchema, type OfflineSweep } from '../src/scoreboard/schema';
import {
  containerTtftMs,
  readSweepCompletion,
  selectSweepCases,
  summarizeSweep,
} from '../src/scoreboard/sweep';

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
const containerResponseSchema = z.object({
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  stdoutLines: z.array(z.string()),
  timedOut: z.boolean().optional(),
});

const FINAL_ANSWER_SUFFIX =
  '\n\nIMPORTANT: Your final message must contain ONLY the answer in the exact requested format - no explanations, no preamble, no extra words.';

type SweepResult = OfflineSweep['pairs'][number]['results'][number];

function caseSplit(caseId: string): SweepResult['split'] {
  return createHash('sha256').update(caseId).digest().readUInt8(0) % 2 === 0 ? 'train' : 'heldOut';
}

async function main() {
  const { values } = parseArgs({
    options: {
      pairs: { type: 'string' },
      catalog: { type: 'string', default: 'live' },
      reps: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '16' },
      suite: { type: 'string', default: 'efficient' },
      'container-url': { type: 'string' },
      'cli-api-url': { type: 'string' },
      'concurrency-agentic': { type: 'string', default: '1' },
      'max-usd': { type: 'string' },
      out: { type: 'string' },
      resume: { type: 'string' },
      'summarize-only': { type: 'boolean', default: false },
    },
  });
  if (values['summarize-only']) {
    if (!values.resume || !values.out) {
      throw new Error(
        'Usage: sweep:offline --summarize-only --resume sweep.json --out corrected.json'
      );
    }
    const sweep = OfflineSweepSchema.parse(JSON.parse(await readFile(values.resume, 'utf8')));
    sweep.summaries = summarizeSweep(sweep.pairs);
    await writeFile(`${values.out}.partial`, `${JSON.stringify(sweep, null, 2)}\n`);
    await rename(`${values.out}.partial`, values.out);
    return;
  }
  if (!values.pairs || !values.out || values['max-usd'] === undefined) {
    throw new Error(
      'Usage: sweep:offline --suite efficient|frontier --pairs pairs.json --catalog live|file.json --reps 1 --concurrency 16 --container-url http://localhost:3000 --cli-api-url <gateway-url> --concurrency-agentic 1 --max-usd <n> --out sweep.json [--resume sweep.json]'
    );
  }
  const reps = z.coerce.number().int().positive().parse(values.reps);
  const concurrency = z.coerce.number().int().positive().parse(values.concurrency);
  const suite = z.enum(['efficient', 'frontier']).parse(values.suite);
  const agenticConcurrency = z.coerce.number().int().positive().parse(values['concurrency-agentic']);
  const cases = selectSweepCases(suite);
  const containerUrl = values['container-url'] ? new URL(values['container-url']) : null;
  const cliApiUrl = values['cli-api-url'] ?? process.env.KILO_CLI_API_URL;
  const kiloToken = process.env.KILO_TOKEN;
  if (cases.some(benchCase => benchCase.taskType === 'agentic_execution')) {
    if (!containerUrl || !cliApiUrl || !kiloToken) {
      throw new Error('Agentic cases require --container-url, --cli-api-url (or KILO_CLI_API_URL), and KILO_TOKEN');
    }
    z.url().parse(cliApiUrl);
  }
  const maxUsd = z.coerce.number().nonnegative().parse(values['max-usd']);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const attributionHeaders = {
    'HTTP-Referer': OPENROUTER_HTTP_REFERER,
    'X-Title': OPENROUTER_APP_TITLE,
  };
  const pairs = z
    .array(PoolEntrySchema)
    .min(1)
    .parse(JSON.parse(await readFile(values.pairs, 'utf8')));
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
  if (previous && (previous.suite ?? 'efficient') !== suite) {
    throw new Error('Resume sweep must use the same suite');
  }
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
    suite,
    truncated: false,
    costUsd: previous?.costUsd ?? 0,
    graderCostUsd: previous?.graderCostUsd ?? 0,
    pairs: pairs.map(pair => ({
      ...pair,
      results: previousPairs.get(poolEntryKey(pair))?.results ?? [],
    })),
    summaries: [],
  };
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
        if (!done.has(JSON.stringify([benchCase.id, rep])))
          jobs.push({ pairIndex, benchCase, rep });
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
    sweep.summaries = summarizeSweep(sweep.pairs);
    const snapshot = `${JSON.stringify(sweep, null, 2)}\n`;
    writes = writes.then(async () => {
      await writeFile(`${out}.partial`, snapshot);
      await rename(`${out}.partial`, out);
    });
    return writes;
  };
  await checkpoint();
  let completed = 0;
  let stopping = false;
  const worker = async (pool: typeof jobs) => {
    while (!stopping && pool.length > 0) {
      if (!budgetAvailable()) return;
      const job = pool.pop();
      if (!job) return;
      const { pairIndex, benchCase, rep } = job;
      const pair = sweep.pairs[pairIndex];
      let ttftMs: number | null = null;
      let modelCostUsd: number | null = null;
      let graderCostUsd = 0;
      let score: number | null = null;
      let error: string | null = null;
      let output: string | null = null;
      const prompts = benchCase.longContext ? materializeLongContext(benchCase) : benchCase;
      const agentic = benchCase.taskType === 'agentic_execution';
      const body = agentic
        ? JSON.stringify({
            model: pair.model,
            prompt: `${prompts.systemPrompt}\n\n${prompts.userPrompt}${FINAL_ANSWER_SUFFIX}`,
            kiloToken,
            kiloApiUrl: cliApiUrl,
            orgId: process.env.KILO_ORG_ID ?? null,
            timeoutMs: 180_000,
            variant: pair.variant,
          })
        : JSON.stringify({
            ...fragments[pairIndex],
            model: pair.model,
            messages: [
              { role: 'system', content: prompts.systemPrompt },
              { role: 'user', content: prompts.userPrompt },
            ],
            stream: true,
            usage: { include: true },
          });
      const started = performance.now();
      const startedWall = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!budgetAvailable()) {
          error = 'Sweep budget exhausted before request';
          break;
        }
        let retry = false;
        try {
          const endpoint = agentic && containerUrl
            ? new URL('/run', containerUrl).toString()
            : 'https://openrouter.ai/api/v1/chat/completions';
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: agentic
              ? { 'Content-Type': 'application/json' }
              : {
                  ...attributionHeaders,
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
            body,
            signal: AbortSignal.timeout(agentic ? 195_000 * agenticConcurrency : 170_000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            error = `${agentic ? 'Container' : 'OpenRouter'} returned HTTP ${response.status}`;
            retry = response.status === 429 || response.status >= 500;
          } else {
            if (agentic) {
              const result = containerResponseSchema.parse(await response.json());
              const parsed = parseKiloRunEvents(result.stdoutLines);
              modelCostUsd = parsed.costUsd;
              ttftMs = containerTtftMs(result.stdoutLines, startedWall);
              if (modelCostUsd !== null) sweep.costUsd += modelCostUsd;
              if (result.timedOut || result.exitCode !== 0) {
                error = result.timedOut ? 'Container CLI timed out' : `Container CLI exited ${result.exitCode}`;
                break;
              }
              output = parsed.text;
            } else {
              const result = await readSweepCompletion(response, started);
              modelCostUsd = result.costUsd;
              ttftMs = result.ttftMs;
              output = result.output;
              if (modelCostUsd !== null) sweep.costUsd += modelCostUsd;
            }
            error = modelCostUsd === null ? 'usage_missing' : null;
            if (output.length === 0) {
              score = 0;
              error = agentic
                ? 'Container response is missing answer content'
                : 'OpenRouter response is missing answer content';
              output = null;
            }
            break;
          }
        } catch {
          error = `${agentic ? 'Container' : 'OpenRouter'} transport or body read failed`;
          retry = true;
        }
        if (!retry || attempt === 2) break;
        await delay(1_000 * 2 ** attempt);
      }
      const latencyMs = performance.now() - started;
      if (output !== null) {
        const grade = await gradeDeciderOutput(benchCase.check, {
          userPrompt: prompts.userPrompt,
          output,
          judge,
        });
        score = grade.score;
        graderCostUsd = grade.costUsd;
        error = grade.score === null ? 'grader_failed' : (grade.graderError ?? error);
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
        ttftMs,
        error,
        output,
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
  const directJobs = jobs.filter(job => job.benchCase.taskType !== 'agentic_execution').reverse();
  const agenticJobs = jobs.filter(job => job.benchCase.taskType === 'agentic_execution').reverse();
  const results = await Promise.allSettled([
    ...Array.from({ length: Math.min(concurrency, directJobs.length) }, () => worker(directJobs)),
    ...Array.from({ length: Math.min(agenticConcurrency, agenticJobs.length) }, () => worker(agenticJobs)),
  ]);
  await checkpoint();
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
  console.log(
    `Saved ${sweep.pairs.reduce((sum, pair) => sum + pair.results.length, 0)} case results to ${out}${sweep.truncated ? ' (truncated)' : ''}`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Offline sweep failed');
  process.exitCode = 1;
});
