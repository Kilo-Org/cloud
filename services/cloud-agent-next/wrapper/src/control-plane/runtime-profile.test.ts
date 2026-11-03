import { writeRuntimeSkills, type RuntimeSkillInstallOptions } from '../runtime-skills.js';
import { existsSync } from 'node:fs';
import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeProfileMaterializer,
  materializeRuntimeProfile,
  profileConfigPath,
  RuntimeProfileMismatchError,
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

const skillsShProfile = {
  runtimeSkills: [{ name: 'find-skills', source: 'vercel-labs/skills' }],
};

function skillsInstaller(): {
  run: NonNullable<RuntimeSkillInstallOptions['run']>;
  installs: () => number;
} {
  let installs = 0;
  return {
    installs: () => installs,
    run: async (_command, args, options) => {
      installs += 1;
      const name = args[args.indexOf('--skill') + 1]!;
      const directory = path.join(String(options?.env?.HOME), '.agents/skills', name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'SKILL.md'), `# ${name}`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function blockingInstaller(): {
  run: NonNullable<RuntimeSkillInstallOptions['run']>;
  started: Promise<void>;
  release: () => void;
  installs: () => number;
} {
  let installs = 0;
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    installs: () => installs,
    run: async (_command, args, options) => {
      installs += 1;
      started.resolve();
      await Promise.race([
        released.promise,
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('aborted')),
            { once: true }
          );
        }),
      ]);
      options?.signal?.throwIfAborted();
      const name = args[args.indexOf('--skill') + 1]!;
      const directory = path.join(String(options?.env?.HOME), '.agents/skills', name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'SKILL.md'), `# ${name}`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    release: () => released.resolve(),
    started: started.promise,
  };
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

describe('workspace profile single-flight', () => {
  it('installs one profile for concurrent siblings and fans progress out to both', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-shared-'));
    try {
      const materializer = createRuntimeProfileMaterializer();
      const installer = skillsInstaller();
      const progressA: string[] = [];
      const progressB: string[] = [];
      await Promise.all([
        materializer.materialize(home, skillsShProfile, {
          run: installer.run,
          onProgress: detail => progressA.push(detail),
        }),
        materializer.materialize(home, skillsShProfile, {
          run: installer.run,
          onProgress: detail => progressB.push(detail),
        }),
      ]);
      expect(installer.installs()).toBe(1);
      expect(progressA.some(detail => detail.includes('Installing skills.sh skill'))).toBe(true);
      expect(progressB.some(detail => detail.includes('Installing skills.sh skill'))).toBe(true);
      expect(
        await fs.readFile(path.join(home, '.kilocode/skills/find-skills/SKILL.md'), 'utf8')
      ).toBe('# find-skills');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('reuses a successful profile for later siblings in the same HOME', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-sequential-'));
    try {
      const materializer = createRuntimeProfileMaterializer();
      const installer = skillsInstaller();
      await materializer.materialize(home, skillsShProfile, { run: installer.run });
      await materializer.materialize(home, skillsShProfile, { run: installer.run });
      expect(installer.installs()).toBe(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the shared install running when one sibling releases', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-release-'));
    const controller = new AbortController();
    const installer = blockingInstaller();
    try {
      const materializer = createRuntimeProfileMaterializer();
      const released = materializer.materialize(home, skillsShProfile, {
        run: installer.run,
        signal: controller.signal,
      });
      await installer.started;
      const sibling = materializer.materialize(home, skillsShProfile, { run: installer.run });

      controller.abort(new Error('released'));
      expect(await captureRejection(released)).toMatchObject({ message: 'released' });
      installer.release();
      await sibling;
      expect(installer.installs()).toBe(1);
      expect(
        await fs.readFile(path.join(home, '.kilocode/skills/find-skills/SKILL.md'), 'utf8')
      ).toBe('# find-skills');
    } finally {
      installer.release();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('aborts the shared install when the last sibling releases, then retries the next attach', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-abort-'));
    try {
      const materializer = createRuntimeProfileMaterializer();
      const installer = blockingInstaller();
      const first = new AbortController();
      const second = new AbortController();
      const a = captureRejection(
        materializer.materialize(home, skillsShProfile, {
          run: installer.run,
          signal: first.signal,
        })
      );
      await installer.started;
      const b = captureRejection(
        materializer.materialize(home, skillsShProfile, {
          run: installer.run,
          signal: second.signal,
        })
      );

      first.abort(new Error('first released'));
      second.abort(new Error('second released'));
      expect(await a).toMatchObject({ message: 'first released' });
      expect(await b).toMatchObject({ message: 'second released' });

      const retry = skillsInstaller();
      await materializer.materialize(home, skillsShProfile, { run: retry.run });
      expect(installer.installs()).toBe(1);
      expect(retry.installs()).toBe(1);
      expect(
        await fs.readFile(path.join(home, '.kilocode/skills/find-skills/SKILL.md'), 'utf8')
      ).toBe('# find-skills');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('does not pin a HOME when the last sibling releases during the final commit', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-commit-abort-'));
    const controller = new AbortController();
    const rename = fs.rename.bind(fs);
    const commit = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === profileConfigPath(home)) controller.abort(new Error('released'));
      return rename(from, to);
    });
    try {
      const materializer = createRuntimeProfileMaterializer();
      expect(
        await captureRejection(
          materializer.materialize(home, previousProfile, { signal: controller.signal })
        )
      ).toMatchObject({ message: 'released' });
      commit.mockRestore();
      materializer.release(home);
      // Queues behind the aborted write, so the aborted install has settled.
      await materializeRuntimeProfile(home, previousProfile);
      await Bun.sleep(0);
      await materializer.materialize(home, nextProfile);
      expect(await fs.readFile(path.join(home, '.kilocode/skills/next/SKILL.md'), 'utf8')).toBe(
        'Next'
      );
    } finally {
      commit.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('retries the next attach after a failed installation', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-retry-'));
    try {
      const materializer = createRuntimeProfileMaterializer();
      let fail = true;
      let attempts = 0;
      const run: NonNullable<RuntimeSkillInstallOptions['run']> = async (
        _command,
        args,
        options
      ) => {
        attempts += 1;
        if (fail) return { exitCode: 1, stdout: '', stderr: 'install failed' };
        const name = args[args.indexOf('--skill') + 1]!;
        const directory = path.join(String(options?.env?.HOME), '.agents/skills', name);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'SKILL.md'), `# ${name}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      expect(
        await captureRejection(materializer.materialize(home, skillsShProfile, { run }))
      ).toBeDefined();
      fail = false;
      await materializer.materialize(home, skillsShProfile, { run });
      expect(attempts).toBe(3);
      expect(
        await fs.readFile(path.join(home, '.kilocode/skills/find-skills/SKILL.md'), 'utf8')
      ).toBe('# find-skills');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('keeps distinct HOME directories isolated', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-homes-'));
    const homeA = path.join(root, 'a');
    const homeB = path.join(root, 'b');
    try {
      const materializer = createRuntimeProfileMaterializer();
      const installer = skillsInstaller();
      await materializer.materialize(homeA, skillsShProfile, { run: installer.run });
      await materializer.materialize(homeB, skillsShProfile, { run: installer.run });
      expect(installer.installs()).toBe(2);
      expect(
        await fs.readFile(path.join(homeA, '.kilocode/skills/find-skills/SKILL.md'), 'utf8')
      ).toBe('# find-skills');
      expect(
        await fs.readFile(path.join(homeB, '.kilocode/skills/find-skills/SKILL.md'), 'utf8')
      ).toBe('# find-skills');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a different profile on an already configured HOME without overwriting it', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-mismatch-'));
    try {
      const materializer = createRuntimeProfileMaterializer();
      await materializer.materialize(home, {
        runtimeSkills: [{ name: 'first', rawMarkdown: 'First' }],
      });
      expect(
        await captureRejection(
          materializer.materialize(home, {
            runtimeSkills: [{ name: 'second', rawMarkdown: 'Second' }],
          })
        )
      ).toBeInstanceOf(RuntimeProfileMismatchError);
      expect(await captureRejection(materializer.materialize(home, {}))).toBeInstanceOf(
        RuntimeProfileMismatchError
      );
      expect(await fs.readFile(path.join(home, '.kilocode/skills/first/SKILL.md'), 'utf8')).toBe(
        'First'
      );
      expect(existsSync(path.join(home, '.kilocode/skills/second'))).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('caches an empty profile as the canonical workspace configuration', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-empty-'));
    const staging = spyOn(fs, 'mkdtemp');
    try {
      const materializer = createRuntimeProfileMaterializer();
      await materializer.materialize(home, {});
      await materializer.materialize(home, {});
      expect(staging).toHaveBeenCalledTimes(1);
      expect(
        await captureRejection(materializer.materialize(home, skillsShProfile))
      ).toBeInstanceOf(RuntimeProfileMismatchError);
      expect(staging).toHaveBeenCalledTimes(1);
    } finally {
      staging.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('keeps a completed profile cached when its waiter aborts afterwards', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-late-abort-'));
    const controller = new AbortController();
    try {
      const materializer = createRuntimeProfileMaterializer();
      const installer = skillsInstaller();
      await materializer.materialize(home, skillsShProfile, {
        run: installer.run,
        signal: controller.signal,
      });
      controller.abort(new Error('late release'));
      await materializer.materialize(home, skillsShProfile, { run: installer.run });
      expect(installer.installs()).toBe(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('reuses the profile for the same config after release', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-idle-same-'));
    try {
      const materializer = createRuntimeProfileMaterializer();
      const installer = skillsInstaller();
      await materializer.materialize(home, skillsShProfile, { run: installer.run });
      materializer.release(home);
      await materializer.materialize(home, skillsShProfile, { run: installer.run });
      expect(installer.installs()).toBe(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('reinstalls a changed profile after release', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-profile-idle-changed-'));
    try {
      const materializer = createRuntimeProfileMaterializer();
      await materializer.materialize(home, {
        runtimeSkills: [{ name: 'first', rawMarkdown: 'First' }],
      });
      materializer.release(home);
      await materializer.materialize(home, {
        runtimeSkills: [{ name: 'second', rawMarkdown: 'Second' }],
      });
      expect(await fs.readFile(path.join(home, '.kilocode/skills/second/SKILL.md'), 'utf8')).toBe(
        'Second'
      );
      expect(existsSync(path.join(home, '.kilocode/skills/first'))).toBe(false);
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
