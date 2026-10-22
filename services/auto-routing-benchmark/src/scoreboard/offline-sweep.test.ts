import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { DECIDER_CASES } from '../datasets/decider-cases';
import { OfflineSweepSchema } from './schema';

const execFileAsync = promisify(execFile);

it('preserves distinct variants from a pairs file and resumes their results independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-sweep-variants-'));
  try {
    const pairs = [
      { model: 'fixture/model', variant: 'low' },
      { model: 'fixture/model', variant: 'high' },
    ];
    const pairsPath = join(directory, 'pairs.json');
    const catalogPath = join(directory, 'catalog.json');
    const outputPath = join(directory, 'sweep.json');
    await writeFile(pairsPath, JSON.stringify(pairs));
    await writeFile(
      catalogPath,
      JSON.stringify({
        data: [{ id: 'fixture/model', opencode: { variants: { low: {}, high: {} } } }],
      })
    );
    const args = [
      '--import',
      'tsx',
      new URL('../../scripts/offline-sweep.ts', import.meta.url).pathname,
      '--pairs',
      pairsPath,
      '--catalog',
      catalogPath,
      '--max-usd',
      '0',
      '--out',
      outputPath,
      '--skip-agentic',
    ];
    const options = { env: { ...process.env, OPENROUTER_API_KEY: 'unused-zero-budget-key' } };
    await execFileAsync(process.execPath, args, options);
    const sweep = OfflineSweepSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
    expect(sweep.pairs).toEqual(pairs.map(pair => ({ ...pair, results: [] })));

    const benchCase = DECIDER_CASES.find(item => item.taskType !== 'agentic_execution');
    if (!benchCase) throw new Error('Expected a non-agentic benchmark case');
    const result = {
      caseId: benchCase.id,
      rep: 0,
      routeKey: `${benchCase.taskType}/${benchCase.subtaskType}`,
      split:
        createHash('sha256').update(benchCase.id).digest().readUInt8(0) % 2 === 0
          ? ('train' as const)
          : ('heldOut' as const),
      score: 1,
      costUsd: 0,
      graderCostUsd: 0,
      latencyMs: 1,
      error: null,
    };
    sweep.pairs[0].results.push(result);
    await writeFile(outputPath, JSON.stringify(sweep));
    await writeFile(pairsPath, JSON.stringify([...pairs].reverse()));
    await execFileAsync(process.execPath, [...args, '--resume', outputPath], options);
    const resumed = OfflineSweepSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
    expect(resumed.pairs).toEqual([
      { ...pairs[1], results: [] },
      { ...pairs[0], results: [result] },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
