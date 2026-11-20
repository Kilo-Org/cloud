import { parseArgs } from 'node:util';
import * as z from 'zod';
import { containerRunBody, parseContainerRunResponse } from '../src/cli-runner';
import { gradeDeciderOutput, lacksRequiredToolCalls } from '../src/grading';
import { deciderCasesForRouter, MEASUREMENT_REVISION } from '../src/measurement-revision';

const USAGE =
  'Usage: KILO_TOKEN=<token> KILO_CLI_API_URL=<gateway url the container calls> [KILO_ORG_ID=<org>] tsx scripts/continuation-pilot.ts --container-url http://127.0.0.1:3000 --model vendor/model[:variant] [--model ...] --case <case id> [--case ...] [--reps 1] [--confirm-spend]';

const containerResponseSchema = z.object({
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  stdoutLines: z.array(z.string()),
  stderrTail: z.string(),
  timedOut: z.boolean().optional(),
});

function isLoopback(url: URL) {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  );
}

type Totals = {
  runs: number;
  graded: number;
  score: number;
  zeroToolCalls: number;
  costUsd: number;
};

async function main() {
  const { values } = parseArgs({
    options: {
      'container-url': { type: 'string' },
      model: { type: 'string', multiple: true },
      case: { type: 'string', multiple: true },
      reps: { type: 'string', default: '1' },
      'confirm-spend': { type: 'boolean', default: false },
    },
  });
  const kiloToken = process.env.KILO_TOKEN;
  const kiloApiUrl = process.env.KILO_CLI_API_URL;
  const orgId = process.env.KILO_ORG_ID ?? null;
  if (!values['container-url'] || !values.model?.length || !values.case?.length) {
    throw new Error(USAGE);
  }
  if (!kiloToken || !kiloApiUrl)
    throw new Error(`KILO_TOKEN and KILO_CLI_API_URL are required\n${USAGE}`);
  const containerUrl = new URL('/run', values['container-url']);
  if (!isLoopback(new URL(z.url().parse(kiloApiUrl))) && !values['confirm-spend']) {
    throw new Error(
      `KILO_CLI_API_URL ${kiloApiUrl} is not loopback, so every run bills real model calls; pass --confirm-spend to run it`
    );
  }
  const reps = z.coerce.number().int().positive().parse(values.reps);
  const cases = deciderCasesForRouter('efficient', MEASUREMENT_REVISION);
  const selected = values.case.map(caseId => {
    const benchCase = cases.find(candidate => candidate.id === caseId);
    if (!benchCase) throw new Error(`Unknown efficient case ${caseId}`);
    return benchCase;
  });
  const entries = values.model.map(entry => {
    const [model, variant] = entry.split(':');
    if (!model) throw new Error(`Invalid --model ${entry}`);
    return { model, variant: variant || null };
  });

  const totals = new Map<string, Totals>();
  for (const { model, variant } of entries) {
    for (const benchCase of selected) {
      for (let rep = 0; rep < reps; rep++) {
        const startedAt = Date.now();
        const response = await fetch(containerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            containerRunBody({ model, benchCase, kiloToken, kiloApiUrl, orgId, variant })
          ),
        });
        if (!response.ok) {
          throw new Error(
            `container /run failed: HTTP ${response.status} ${await response.text()}`
          );
        }
        const result = parseContainerRunResponse(
          containerResponseSchema.parse(await response.json()),
          startedAt,
          model
        );
        const score = lacksRequiredToolCalls(benchCase.requiredToolCalls, result.tools.calls)
          ? 0
          : result.exitCode === 0 && result.text.length > 0
            ? (
                await gradeDeciderOutput(benchCase.check, {
                  userPrompt: benchCase.userPrompt,
                  output: result.text,
                  judge: null,
                })
              ).score
            : 0;
        console.log(
          JSON.stringify({
            model,
            variant,
            case: benchCase.id,
            rep,
            score,
            exitCode: result.exitCode,
            tools: result.tools,
            finalFinishReason: result.tools.finalFinishReason,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
            text: result.text.slice(0, 200),
          })
        );
        const key = `${model}:${variant ?? ''}`;
        const total = totals.get(key) ?? {
          runs: 0,
          graded: 0,
          score: 0,
          zeroToolCalls: 0,
          costUsd: 0,
        };
        total.runs += 1;
        if (score !== null) {
          total.graded += 1;
          total.score += score;
        }
        if (result.tools.calls === 0) total.zeroToolCalls += 1;
        total.costUsd += result.costUsd ?? 0;
        totals.set(key, total);
      }
    }
  }
  for (const [key, total] of totals) {
    console.log(
      JSON.stringify({
        total: key,
        runs: total.runs,
        passRate: total.graded > 0 ? total.score / total.graded : null,
        zeroToolCallRate: total.zeroToolCalls / total.runs,
        costUsd: total.costUsd,
      })
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Continuation pilot failed');
  process.exitCode = 1;
});
