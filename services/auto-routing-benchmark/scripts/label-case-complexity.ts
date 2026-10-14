// Regenerate: OPENROUTER_API_KEY=... pnpm exec tsx scripts/label-case-complexity.ts
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ComplexityLabelsSchema,
  normalizeClassifierInput,
  type ComplexityLabels,
} from '@kilocode/auto-routing-contracts';
import {
  classifyWithSystemOne,
  DEFAULT_CLASSIFIER_MODEL,
} from '@kilocode/auto-routing-contracts/classifier';
import { DECIDER_CASES, FRONTIER_CASES } from '../src/datasets/decider-cases';
import { materializeLongContext } from '../src/datasets/long-context';

async function main() {
  const defaultOutput = fileURLToPath(new URL('../src/datasets/case-complexity.json', import.meta.url));
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
  const labels: ComplexityLabels = values.resume
    ? ComplexityLabelsSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')))
    : {};
  for (const benchCase of [...DECIDER_CASES, ...FRONTIER_CASES]) {
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
      const result = await classifyWithSystemOne(client, input, DEFAULT_CLASSIFIER_MODEL);
      labels[benchCase.id] = result.classification.reasoningComplexity;
    } catch (error) {
      await writeFile(outputPath, `${JSON.stringify(labels, null, 2)}\n`);
      throw new Error(
        `Case ${benchCase.id}: ${error instanceof Error ? error.message : 'Classification failed'}`,
        { cause: error }
      );
    }
  }
  await writeFile(outputPath, `${JSON.stringify(labels, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Complexity labeling failed');
  process.exitCode = 1;
});
