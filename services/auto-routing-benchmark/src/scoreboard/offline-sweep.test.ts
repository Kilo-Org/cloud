import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DECIDER_CASES } from '../datasets/decider-cases';
import { runOfflineSweep } from './offline-sweep';
import { OfflineSweepSchema, type OfflineSweep } from './schema';
import { selectSweepCases } from './sweep';

it.each([1, 2])(
  'retains the unknown-cost stop when resuming with %i repetitions',
  async repetitions => {
    const directory = await mkdtemp(join(tmpdir(), 'sweep-resume-'));
    try {
      const pair = { model: 'fixture/model', variant: null };
      const cases = selectSweepCases().filter(row => row.taskType !== 'agentic_execution');
      const sweep: OfflineSweep = {
        startedAt: '2026-01-01T00:00:00.000Z',
        suite: 'efficient',
        truncated: false,
        costUsd: 0,
        graderCostUsd: 0,
        pairs: [
          {
            ...pair,
            results: cases.map((row, index) => ({
              caseId: row.id,
              rep: 0,
              routeKey: `${row.taskType}/${row.subtaskType}`,
              split:
                createHash('sha256').update(row.id).digest().readUInt8(0) % 2 === 0
                  ? 'train'
                  : 'heldOut',
              score: 0,
              costUsd: index === 0 ? null : 0,
              graderCostUsd: 0,
              latencyMs: 1,
              ttftMs: null,
              error: index === 0 ? 'usage_missing' : null,
            })),
          },
        ],
        summaries: [],
      };
      const egressMarker = join(directory, 'egress');
      await writeFile(join(directory, 'resume.json'), JSON.stringify(sweep));
      await writeFile(join(directory, 'pairs.json'), JSON.stringify([pair]));
      await writeFile(
        join(directory, 'catalog.json'),
        JSON.stringify({ data: [{ id: pair.model }] })
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        await writeFile(egressMarker, 'attempted');
        throw new Error('Unexpected network request');
      });
      try {
        await runOfflineSweep(
          [
            '--pairs',
            join(directory, 'pairs.json'),
            '--catalog',
            join(directory, 'catalog.json'),
            '--skip-agentic',
            '--reps',
            String(repetitions),
            '--max-usd',
            '1',
            '--resume',
            join(directory, 'resume.json'),
            '--out',
            join(directory, 'out.json'),
          ],
          { ...process.env, OPENROUTER_API_KEY: 'fixture-key' }
        );
      } finally {
        fetchSpy.mockRestore();
      }
      const resumed = OfflineSweepSchema.parse(
        JSON.parse(await readFile(join(directory, 'out.json'), 'utf8'))
      );
      expect(resumed.truncated).toBe(true);
      expect(resumed.pairs[0].results).toEqual(sweep.pairs[0].results);
      expect(await readdir(directory)).not.toContain('egress');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

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
    const argv = [
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
    const env = { ...process.env, OPENROUTER_API_KEY: 'unused-zero-budget-key' };
    await runOfflineSweep(argv, env);
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
    await runOfflineSweep([...argv, '--resume', outputPath], env);
    const resumed = OfflineSweepSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
    expect(resumed.pairs).toEqual([
      { ...pairs[1], results: [] },
      { ...pairs[0], results: [result] },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
