import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSetupScript } from './setup-script.js';

describe('setup script execution', () => {
  for (const failure of ['false', 'false | cat']) {
    it(`stops after ${failure} without an explicit set -e`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'setup-script-'));
      try {
        const result = await runSetupScript(`#!/bin/bash\n${failure}\nprintf reached > continued`, {
          cwd: directory,
        });
        expect(result.exitCode).not.toBe(0);
        expect(
          await access(path.join(directory, 'continued')).then(
            () => true,
            () => false
          )
        ).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
  it('supports Bash syntax and explicit recovery from an expected failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'setup-script-'));
    try {
      const result = await runSetupScript(
        '#!/bin/bash\nfalse || true\nvalues=(one two)\nprintf "%s" "${values[1]}" > result',
        { cwd: directory }
      );
      expect(result.exitCode).toBe(0);
      expect(await readFile(path.join(directory, 'result'), 'utf8')).toBe('two');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
