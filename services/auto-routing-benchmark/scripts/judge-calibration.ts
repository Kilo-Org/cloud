import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { createDeciderJudge } from '../src/decider-judge';
import { runDeciderCheck } from '../src/grading';

const LabeledRowSchema = z.object({
  userPrompt: z.string(),
  output: z.string(),
  rubric: z.string(),
  reference: z.string().optional(),
  label: z.boolean(),
});
const MechanicalRowSchema = z.object({
  userPrompt: z.string(),
  output: z.string(),
  check: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('exact'), value: z.string() }),
    z.object({ kind: z.literal('contains_all'), values: z.array(z.string()) }),
    z.object({ kind: z.literal('regex'), pattern: z.string(), flags: z.string().optional() }),
    z.object({ kind: z.literal('json_equal'), value: z.unknown() }),
  ]),
});

async function main() {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      'from-mechanical': { type: 'string' },
    },
  });
  const input = values.in;
  const mechanical = values['from-mechanical'];
  if ((!input && !mechanical) || (input && mechanical)) {
    throw new Error('Provide exactly one of --in <labels.jsonl> or --from-mechanical <cases.json>');
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  let rows: z.infer<typeof LabeledRowSchema>[];
  if (mechanical) {
    const source: unknown = JSON.parse(await readFile(mechanical, 'utf8'));
    rows = z
      .array(MechanicalRowSchema)
      .parse(source)
      .map(({ userPrompt, output, check }) => {
        let rubric: string;
        switch (check.kind) {
          case 'exact':
            rubric = `The final answer equals ${JSON.stringify(check.value)} after removing markdown fences, trimming whitespace and ignoring case. Accept a matching last non-empty line even if preceded by prose.`;
            break;
          case 'json_equal':
            rubric = `The final answer equals ${JSON.stringify(check.value)} as JSON, preserving array and object key order. Ignore surrounding prose and markdown fences.`;
            break;
          case 'contains_all':
            rubric = `The final answer contains every string in ${JSON.stringify(check.values)}, ignoring case and markdown fences.`;
            break;
          case 'regex':
            rubric = `The final answer matches the JavaScript regular expression ${JSON.stringify(check.pattern)} with flags ${JSON.stringify(check.flags ?? '')}.`;
            break;
        }
        return { userPrompt, output, rubric, label: runDeciderCheck(check, output) };
      });
  } else if (input) {
    rows = (await readFile(input, 'utf8'))
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const row: unknown = JSON.parse(line);
        return LabeledRowSchema.parse(row);
      });
  } else {
    throw new Error('Calibration input is required');
  }
  if (!rows.length) throw new Error('Calibration input has no rows');
  const judge = createDeciderJudge({ apiKey, attributionHeaders: {} });
  const bins = Array.from({ length: 5 }, () => ({ n: 0, probability: 0, positives: 0 }));
  let correct = 0;
  let squaredError = 0;
  for (const row of rows) {
    const { probability } = await judge(row);
    const label = Number(row.label);
    correct += Number(probability >= 0.5 === row.label);
    squaredError += (probability - label) ** 2;
    const bin = bins[Math.min(4, Math.floor(probability * 5))];
    if (!bin) throw new Error('Invalid reliability bin');
    bin.n++;
    bin.probability += probability;
    bin.positives += label;
  }
  console.log(`n: ${rows.length}`);
  console.log(`accuracy@0.5: ${(correct / rows.length).toFixed(6)}`);
  console.log(`Brier score: ${(squaredError / rows.length).toFixed(6)}`);
  console.log('bin\tn\tmean probability\tpositive fraction');
  bins.forEach((bin, index) => {
    const range = `[${(index / 5).toFixed(1)},${((index + 1) / 5).toFixed(1)}${index === 4 ? ']' : ')'}`;
    console.log(
      `${range}\t${bin.n}\t${bin.n ? (bin.probability / bin.n).toFixed(6) : '-'}\t${bin.n ? (bin.positives / bin.n).toFixed(6) : '-'}`
    );
  });
}

main().catch(() => {
  console.error(
    'Judge calibration failed. Check input schema, arguments, API key availability and System One connectivity.'
  );
  process.exitCode = 1;
});
