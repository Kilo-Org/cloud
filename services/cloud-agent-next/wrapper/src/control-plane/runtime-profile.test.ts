import { writeRuntimeSkills } from '../runtime-skills.js';
import { existsSync } from 'node:fs';
import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  materializeRuntimeProfile,
  profileConfigPath,
  withRuntimeProfileEnvironment,
} from './runtime-profile.js';

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected operation to reject');
    },
    (error: unknown) => error
  );
}

const previousProfile = {
  runtimeSkills: [{ name: 'previous', rawMarkdown: 'Keep me' }],
  runtimeAgents: [{ slug: 'previous-agent', name: 'Previous agent', config: {} }],
  kiloCommands: [{ name: 'previous-command', template: 'Previous command' }],
};

const nextProfile = {
  runtimeSkills: [{ name: 'next', rawMarkdown: 'Next' }],
  runtimeAgents: [{ slug: 'next-agent', name: 'Next agent', config: {} }],
  kiloCommands: [{ name: 'next-command', template: 'Next command' }],
};

async function expectPreviousProfile(home: string, previousConfig: string): Promise<void> {
  expect(await fs.readFile(path.join(home, '.kilocode/skills/previous/SKILL.md'), 'utf8')).toBe(
    'Keep me'
  );
  expect(existsSync(path.join(home, '.kilocode/skills/next'))).toBe(false);
  expect(await fs.readFile(profileConfigPath(home), 'utf8')).toBe(previousConfig);
}

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

describe('runtime profile preparation failures', () => {
  it.each([
    ['a non-empty new config', nextProfile],
    ['an empty new config', { runtimeSkills: nextProfile.runtimeSkills }],
  ] as const)(
    'keeps the previous profile when the skills replacement fails with %s',
    async (_label, next) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-'));
      try {
        await materializeRuntimeProfile(home, previousProfile);
        const previousConfig = await fs.readFile(profileConfigPath(home), 'utf8');
        const skills = path.join(home, '.kilocode', 'skills');
        const rename = fs.rename.bind(fs);
        const replacementError = new Error('replacement failed');
        const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (to === skills && !String(from).endsWith('previous-skills')) throw replacementError;
          await rename(from, to);
        });
        try {
          expect(await captureRejection(materializeRuntimeProfile(home, next))).toBe(
            replacementError
          );
        } finally {
          renameSpy.mockRestore();
        }
        await expectPreviousProfile(home, previousConfig);
        expect((await fs.readdir(home)).some(name => name.startsWith('.profile-'))).toBe(false);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  );

  it('keeps the previous profile when preparation is aborted after the skills swap', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-'));
    const controller = new AbortController();
    try {
      await materializeRuntimeProfile(home, previousProfile);
      const previousConfig = await fs.readFile(profileConfigPath(home), 'utf8');
      const skills = path.join(home, '.kilocode', 'skills');
      const rename = fs.rename.bind(fs);
      const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to === skills && !String(from).endsWith('previous-skills')) {
          controller.abort(new Error('stopped'));
        }
        await rename(from, to);
      });
      try {
        expect(
          await captureRejection(
            materializeRuntimeProfile(home, nextProfile, { signal: controller.signal })
          )
        ).toMatchObject({ message: 'stopped' });
      } finally {
        renameSpy.mockRestore();
      }
      await expectPreviousProfile(home, previousConfig);
      expect((await fs.readdir(home)).some(name => name.startsWith('.profile-'))).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the previous profile when committing the new config fails', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-'));
    try {
      await materializeRuntimeProfile(home, previousProfile);
      const previousConfig = await fs.readFile(profileConfigPath(home), 'utf8');
      const config = profileConfigPath(home);
      const rename = fs.rename.bind(fs);
      const configError = new Error('config commit failed');
      const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to === config) throw configError;
        await rename(from, to);
      });
      try {
        expect(await captureRejection(materializeRuntimeProfile(home, nextProfile))).toBe(
          configError
        );
      } finally {
        renameSpy.mockRestore();
      }
      await expectPreviousProfile(home, previousConfig);
      expect((await fs.readdir(home)).some(name => name.startsWith('.profile-'))).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the previous profile when deleting the config for an empty new profile fails', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-'));
    try {
      await materializeRuntimeProfile(home, previousProfile);
      const previousConfig = await fs.readFile(profileConfigPath(home), 'utf8');
      const config = profileConfigPath(home);
      const remove = fs.rm.bind(fs);
      const configError = new Error('config deletion failed');
      const removeSpy = spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (target === config) throw configError;
        await remove(target, options);
      });
      try {
        expect(
          await captureRejection(
            materializeRuntimeProfile(home, {
              runtimeSkills: nextProfile.runtimeSkills,
            })
          )
        ).toBe(configError);
      } finally {
        removeSpy.mockRestore();
      }
      await expectPreviousProfile(home, previousConfig);
      expect((await fs.readdir(home)).some(name => name.startsWith('.profile-'))).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('removes the new skills when a config commit fails without previous skills', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-'));
    try {
      const config = profileConfigPath(home);
      const rename = fs.rename.bind(fs);
      const configError = new Error('config commit failed');
      const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to === config) throw configError;
        await rename(from, to);
      });
      try {
        expect(await captureRejection(materializeRuntimeProfile(home, nextProfile))).toBe(
          configError
        );
      } finally {
        renameSpy.mockRestore();
      }
      expect(existsSync(path.join(home, '.kilocode/skills/next'))).toBe(false);
      expect(existsSync(config)).toBe(false);
      expect((await fs.readdir(home)).some(name => name.startsWith('.profile-'))).toBe(false);
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
