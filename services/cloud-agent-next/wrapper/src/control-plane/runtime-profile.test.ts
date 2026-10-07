import { writeRuntimeSkills } from '../runtime-skills.js';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  materializeRuntimeProfile,
  profileConfigPath,
  withRuntimeProfileEnvironment,
} from './runtime-profile.js';

describe('runtime profile materialization', () => {
  it('writes large valid command templates to disk without expanding process env', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-'));
    try {
      const profile = { kiloCommands: [{ name: 'long-review', template: 'x'.repeat(100_000) }] };
      await materializeRuntimeProfile(home, profile);
      const env = withRuntimeProfileEnvironment(
        { HOME: home, KILO_CONFIG_CONTENT: '{"provider":{}}' },
        profile
      );
      expect(env.KILO_CONFIG_CONTENT).toBe('{"provider":{}}');
      expect(env.KILO_CONFIG).toBe(profileConfigPath(home));
      expect(
        JSON.parse(await fs.readFile(env.KILO_CONFIG, 'utf8')).command['long-review'].template
      ).toBe(profile.kiloCommands[0].template);
      expect((await fs.stat(env.KILO_CONFIG)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('replaces stale skill companion files and clears absent profile artifacts on a restored home', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-'));
    try {
      await materializeRuntimeProfile(home, {
        runtimeSkills: [{ name: 'review', rawMarkdown: 'old', files: { 'obsolete.txt': 'stale' } }],
        runtimeAgents: [{ slug: 'reviewer', name: 'Reviewer', config: {} }],
      });
      await materializeRuntimeProfile(home, {
        runtimeSkills: [{ name: 'review', rawMarkdown: 'new' }],
      });
      expect(await fs.readFile(path.join(home, '.kilocode/skills/review/SKILL.md'), 'utf8')).toBe(
        'new'
      );
      expect(existsSync(path.join(home, '.kilocode/skills/review/obsolete.txt'))).toBe(false);
      expect(existsSync(profileConfigPath(home))).toBe(false);
      await materializeRuntimeProfile(home, {});
      expect(existsSync(path.join(home, '.kilocode/skills/review/SKILL.md'))).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('legacy skill writing', () => {
  it('skips unsafe companion files while keeping the skill and its safe files', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-'));
    try {
      await writeRuntimeSkills(home, [
        {
          name: 'review',
          rawMarkdown: '# Review',
          files: {
            '../outside.txt': 'unsafe',
            'SKILL.md': 'override',
            '': 'empty path',
            ['x'.repeat(201)]: 'overlong path',
            ['x'.repeat(200)]: 'valid boundary',
            'nested/guide.txt': 'safe',
          },
        },
      ]);
      const skillDir = path.join(home, '.kilocode/skills/review');
      expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('# Review');
      expect(await fs.readFile(path.join(skillDir, 'nested/guide.txt'), 'utf8')).toBe('safe');
      expect(await fs.readFile(path.join(skillDir, 'x'.repeat(200)), 'utf8')).toBe(
        'valid boundary'
      );
      expect(existsSync(path.join(skillDir, 'x'.repeat(201)))).toBe(false);
      expect(existsSync(path.join(home, '.kilocode/skills/outside.txt'))).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
