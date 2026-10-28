import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  classifyWithSystemOne,
  ClassifierRunResult,
} from '@kilocode/auto-routing-contracts/classifier';
import type { DeciderCase } from './datasets/decider-cases';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
  };
});

import { labelCaseComplexity } from '../scripts/label-case-complexity';

const client = { apiKey: 'fixture-key', attributionHeaders: {} };
const result: ClassifierRunResult = {
  classifierModel: 'fixture-classifier',
  cost: null,
  classification: {
    taskType: 'implementation',
    subtaskType: 'code_generation',
    contextComplexity: 'small',
    reasoningComplexity: 'low',
    riskLevel: 'low',
    executionMode: 'answer_only',
    requiresTools: false,
    confidence: 1,
  },
};
const cases: DeciderCase[] = ['first', 'second'].map(id => ({
  id,
  taskType: 'implementation',
  subtaskType: 'code_generation',
  systemPrompt: 'Answer precisely.',
  userPrompt: `Return ${id}.`,
  check: { kind: 'exact', value: id },
}));

describe('labelCaseComplexity checkpoints', () => {
  let directory: string;
  let outputPath: string;
  const classify = vi.fn<typeof classifyWithSystemOne>();

  beforeEach(async () => {
    vi.clearAllMocks();
    classify.mockReset();
    directory = await mkdtemp(join(tmpdir(), 'case-complexity-'));
    outputPath = join(directory, 'labels.json');
    await writeFile(outputPath, '{"committed":"high"}\n');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the committed dataset intact even if the first classifier call fails', async () => {
    classify.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(labelCaseComplexity(outputPath, client, { cases, classify })).rejects.toThrow(
      'Case first: provider unavailable'
    );
    expect(await readFile(outputPath, 'utf8')).toBe('{"committed":"high"}\n');
    expect(JSON.parse(await readFile(`${outputPath}.checkpoint`, 'utf8'))).toEqual({});
    expect(rename).toHaveBeenCalledWith(
      `${outputPath}.checkpoint.partial`,
      `${outputPath}.checkpoint`
    );
  });

  it('resumes only the separate checkpoint and publishes atomically after every case succeeds', async () => {
    classify.mockResolvedValueOnce(result).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(labelCaseComplexity(outputPath, client, { cases, classify })).rejects.toThrow(
      'Case second: provider unavailable'
    );
    expect(await readFile(outputPath, 'utf8')).toBe('{"committed":"high"}\n');
    expect(JSON.parse(await readFile(`${outputPath}.checkpoint`, 'utf8'))).toEqual({
      first: 'low',
    });
    classify.mockClear();
    classify.mockResolvedValueOnce({
      ...result,
      classification: { ...result.classification, reasoningComplexity: 'high' },
    });
    await labelCaseComplexity(outputPath, client, { cases, classify, resume: true });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({
      first: 'low',
      second: 'high',
    });
    expect(rename).toHaveBeenCalledWith(`${outputPath}.partial`, outputPath);
    await expect(readFile(`${outputPath}.checkpoint`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not replace an earlier checkpoint or the dataset when a temporary write fails', async () => {
    await writeFile(`${outputPath}.checkpoint`, '{"first":"low"}\n');
    classify.mockRejectedValueOnce(new Error('provider unavailable'));
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk interrupted'));
    await expect(
      labelCaseComplexity(outputPath, client, { cases, classify, resume: true })
    ).rejects.toThrow('disk interrupted');
    expect(await readFile(outputPath, 'utf8')).toBe('{"committed":"high"}\n');
    expect(JSON.parse(await readFile(`${outputPath}.checkpoint`, 'utf8'))).toEqual({
      first: 'low',
    });
    expect(rename).not.toHaveBeenCalled();
  });
});
