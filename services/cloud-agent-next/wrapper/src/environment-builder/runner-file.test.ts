import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { takeRunner } from './runner-file.js';

const RUNNER = { url: 'https://worker.example/environment-build/e/b', credential: 'c'.repeat(32) };

async function tempFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-runner-'));
  return path.join(directory, 'runner.json');
}

describe('takeRunner', () => {
  it('reads the runner once and deletes the file', async () => {
    const file = await tempFile();
    await fs.writeFile(file, JSON.stringify(RUNNER));

    expect(await takeRunner({ path: file })).toEqual(RUNNER);
    expect(await fs.stat(file).catch(() => null)).toBeNull();
  });

  it('waits for a file written after the start', async () => {
    const file = await tempFile();
    let polls = 0;
    const runner = await takeRunner({
      path: file,
      sleep: async () => {
        polls += 1;
        if (polls === 3) await fs.writeFile(file, JSON.stringify(RUNNER));
      },
    });

    expect(runner).toEqual(RUNNER);
    expect(polls).toBe(3);
  });

  it('gives up after the wait and deletes an invalid file', async () => {
    const missing = await tempFile();
    let clock = 0;
    expect(
      await takeRunner({
        path: missing,
        waitMs: 1_000,
        now: () => clock,
        sleep: async ms => {
          clock += ms;
        },
      })
    ).toBeNull();

    const invalid = await tempFile();
    await fs.writeFile(invalid, '{"url":"not a url"}');
    expect(await takeRunner({ path: invalid })).toBeNull();
    expect(await fs.stat(invalid).catch(() => null)).toBeNull();
  });
});
