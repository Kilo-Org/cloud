// Regenerate: OPENROUTER_API_KEY=... pnpm exec tsx scripts/label-case-complexity.ts
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ComplexityLabelsSchema,
  normalizeClassifierInput,
  type ComplexityLabels,
} from '@kilocode/auto-routing-contracts';
import {
  classifyWithSystemOne,
  DEFAULT_CLASSIFIER_MODEL,
  type SystemOneClient,
} from '@kilocode/auto-routing-contracts/classifier';
import { DECIDER_CASES, FRONTIER_CASES, type DeciderCase } from '../src/datasets/decider-cases';
import { materializeLongContext } from '../src/datasets/long-context';

export async function labelCaseComplexity(
  outputPath: string,
  client: SystemOneClient,
  options: {
    resume?: boolean;
    cases?: readonly DeciderCase[];
    classify?: typeof classifyWithSystemOne;
  } = {}
): Promise<void> {
  const checkpointPath = `${outputPath}.checkpoint`;
  const labels: ComplexityLabels = options.resume
    ? ComplexityLabelsSchema.parse(JSON.parse(await readFile(checkpointPath, 'utf8')))
    : {};
  const writeLabels = async (path: string) => {
    const temporaryPath = `${path}.partial`;
    await writeFile(temporaryPath, `${JSON.stringify(labels, null, 2)}\n`);
    await rename(temporaryPath, path);
  };
  const classify = options.classify ?? classifyWithSystemOne;
  for (const benchCase of options.cases ?? [...DECIDER_CASES, ...FRONTIER_CASES]) {
    if (labels[benchCase.id] !== undefined) continue;
    const prompts = materializeLongContext(benchCase);
    const input = normalizeClassifierInput('chat_completions', {
      model: 'kilo-auto/efficient',
      messages: [
        { role: 'system', content: prompts.systemPrompt },
        { role: 'user', content: prompts.userPrompt },
      ],
    });
    if (!input) throw new Error(`Could not normalize case ${benchCase.id}`);
    try {
      const result = await classify(client, input, DEFAULT_CLASSIFIER_MODEL);
      labels[benchCase.id] = result.classification.reasoningComplexity;
    } catch (error) {
      await writeLabels(checkpointPath);
      throw new Error(
        `Case ${benchCase.id}: ${error instanceof Error ? error.message : 'Classification failed'}`,
        { cause: error }
      );
    }
  }
  await writeLabels(outputPath);
  await rm(checkpointPath, { force: true });
}

async function main() {
  const defaultOutput = fileURLToPath(
    new URL('../src/datasets/case-complexity.json', import.meta.url)
  );
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: defaultOutput },
      resume: { type: 'boolean', default: false },
    },
  });
  const outputPath = values.out ?? defaultOutput;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const client = {
    apiKey,
    attributionHeaders: {
      'HTTP-Referer': 'https://kilo.ai',
      'X-Title': 'Kilo Auto Routing Benchmark',
    },
  };
  await labelCaseComplexity(outputPath, client, { resume: values.resume });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Complexity labeling failed');
    process.exitCode = 1;
  });
}
