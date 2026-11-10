import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeRuntimeInstructions } from './runtime-instructions.js';

describe('runtime instruction cleanup', () => {
  it('still fails promptly when an enabled instruction cannot be written', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-instructions-'));
    try {
      await fs.mkdir(path.join(home, '.kilocode/rules/blocked.md'), { recursive: true });
      const error = await writeRuntimeInstructions(
        home,
        [{ name: 'blocked', content: 'Required rule' }],
        { replaceExisting: true }
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(error).toMatchObject({ code: 'EISDIR' });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each(['invalid JSON', '["../outside.md"]', '["cloud-agent.md"]'])(
    'ignores an invalid ownership manifest: %s',
    async manifest => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-instructions-'));
      try {
        const rules = path.join(home, '.kilocode/rules');
        await fs.mkdir(rules, { recursive: true });
        await fs.writeFile(path.join(home, '.kilocode/profile-instructions.json'), manifest);
        await fs.writeFile(path.join(home, '.kilocode/outside.md'), 'Outside');
        await fs.writeFile(path.join(rules, 'cloud-agent.md'), 'Built-in');
        await writeRuntimeInstructions(home, undefined, { replaceExisting: true });
        expect(await fs.readFile(path.join(home, '.kilocode/outside.md'), 'utf8')).toBe('Outside');
        expect(await fs.readFile(path.join(rules, 'cloud-agent.md'), 'utf8')).toBe('Built-in');
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  );

  it('cleans valid owned rules even when other manifest entries are invalid', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-instructions-'));
    const rules = path.join(home, '.kilocode/rules');
    try {
      await writeRuntimeInstructions(home, [
        { name: 'stale', content: 'Old' },
        { name: 'retained', content: 'Old' },
      ]);
      await fs.writeFile(
        path.join(home, '.kilocode/profile-instructions.json'),
        JSON.stringify(['stale.md', '../outside.md', 'cloud-agent.md', null, 42, 'retained.md'])
      );
      await fs.writeFile(path.join(home, '.kilocode/outside.md'), 'Outside');
      await fs.writeFile(path.join(rules, 'cloud-agent.md'), 'Built-in');
      await writeRuntimeInstructions(home, [{ name: 'retained', content: 'Updated' }], {
        replaceExisting: true,
      });
      expect((await fs.readdir(rules)).sort()).toEqual(['cloud-agent.md', 'retained.md']);
      expect(await fs.readFile(path.join(rules, 'retained.md'), 'utf8')).toBe('Updated');
      expect(await fs.readFile(path.join(home, '.kilocode/outside.md'), 'utf8')).toBe('Outside');
      expect(await fs.readFile(path.join(rules, 'cloud-agent.md'), 'utf8')).toBe('Built-in');
      expect(
        JSON.parse(
          await fs.readFile(path.join(home, '.kilocode/profile-instructions.json'), 'utf8')
        )
      ).toEqual(['retained.md']);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('preserves unowned legacy rules when a restored HOME has no manifest', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-instructions-'));
    const rules = path.join(home, '.kilocode/rules');
    try {
      await fs.mkdir(rules, { recursive: true });
      await fs.writeFile(path.join(rules, 'legacy-rule.md'), 'Ownership unknown');
      await writeRuntimeInstructions(home, [{ name: 'current-profile', content: 'Current' }], {
        replaceExisting: true,
      });
      await writeRuntimeInstructions(home, undefined, { replaceExisting: true });
      expect(await fs.readdir(rules)).toEqual(['legacy-rule.md']);
      expect(await fs.readFile(path.join(rules, 'legacy-rule.md'), 'utf8')).toBe(
        'Ownership unknown'
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('removes only previously materialized profile rules from a restored HOME', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-instructions-'));
    const rules = path.join(home, '.kilocode/rules');
    try {
      await fs.mkdir(rules, { recursive: true });
      await fs.writeFile(path.join(rules, 'setup-rule.md'), 'Keep setup rules');
      await fs.writeFile(path.join(rules, 'cloud-agent.md'), 'Keep built-in rules');
      await writeRuntimeInstructions(home, [{ name: 'old-profile', content: 'Old' }]);
      await fs.writeFile(path.join(rules, 'agent-rule.md'), 'Keep agent rules');
      await writeRuntimeInstructions(home, [{ name: 'new-profile', content: 'New' }], {
        replaceExisting: true,
      });
      expect((await fs.readdir(rules)).sort()).toEqual([
        'agent-rule.md',
        'cloud-agent.md',
        'new-profile.md',
        'setup-rule.md',
      ]);
      await writeRuntimeInstructions(home, undefined, { replaceExisting: true });
      expect((await fs.readdir(rules)).sort()).toEqual([
        'agent-rule.md',
        'cloud-agent.md',
        'setup-rule.md',
      ]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('preserves directories and symlinks that replaced stale profile rules', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-instructions-'));
    const rules = path.join(home, '.kilocode/rules');
    try {
      await writeRuntimeInstructions(home, [
        { name: 'directory', content: 'Old' },
        { name: 'link', content: 'Old' },
      ]);
      await fs.rm(path.join(rules, 'directory.md'));
      await fs.mkdir(path.join(rules, 'directory.md'));
      await fs.writeFile(path.join(rules, 'directory.md/keep.txt'), 'Keep me');
      await fs.rm(path.join(rules, 'link.md'));
      await fs.symlink('directory.md/keep.txt', path.join(rules, 'link.md'));
      await writeRuntimeInstructions(home, undefined, { replaceExisting: true });
      expect(await fs.readFile(path.join(rules, 'directory.md/keep.txt'), 'utf8')).toBe('Keep me');
      expect((await fs.lstat(path.join(rules, 'link.md'))).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each(['before stat', 'before removal'] as const)(
    'tolerates a stale rule disappearing %s',
    async timing => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-instructions-'));
      const file = path.join(home, '.kilocode/rules/stale.md');
      try {
        await writeRuntimeInstructions(home, [{ name: 'stale', content: 'Old' }]);
        if (timing === 'before stat') await fs.rm(file);
        const remove = fs.rm.bind(fs);
        const removeSpy = spyOn(fs, 'rm').mockImplementation(async (target, options) => {
          if (target === file && timing === 'before removal') await remove(file);
          await remove(target, options);
        });
        try {
          await writeRuntimeInstructions(home, undefined, { replaceExisting: true });
          if (timing === 'before removal') {
            expect(removeSpy).toHaveBeenCalledWith(file, { force: true });
          }
        } finally {
          removeSpy.mockRestore();
        }
        expect(await fs.readdir(path.dirname(file))).toEqual([]);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  );
});
