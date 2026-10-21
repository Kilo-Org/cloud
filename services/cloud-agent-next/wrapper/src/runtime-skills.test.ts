import { describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { materializeRuntimeProfile } from './control-plane/runtime-profile.js';
import { writeRuntimeSkills } from './runtime-skills.js';
import type { ExecResult, ProcessOptions } from './utils.js';

const success: ExecResult = { exitCode: 0, stdout: '', stderr: '' };

async function installFixture(options?: ProcessOptions): Promise<void> {
  const home = options?.env?.HOME;
  if (!home) throw new Error('Missing isolated installation home');
  const directory = path.join(home, '.agents/skills/find-skills');
  await fs.mkdir(path.join(directory, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), '# Find skills');
  await fs.writeFile(path.join(directory, 'scripts/find.sh'), 'exit 0', { mode: 0o755 });
}

describe('skills.sh container installation', () => {
  it('preserves live skills until installation succeeds, then replaces them with the full bundle', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
    const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
    const progress: string[] = [];
    try {
      await materializeRuntimeProfile(home, {
        runtimeSkills: [{ name: 'stale', rawMarkdown: 'obsolete' }],
      });
      await materializeRuntimeProfile(
        home,
        {
          runtimeSkills: [
            { name: 'find-skills', source: 'vercel-labs/skills' },
            { name: 'review', rawMarkdown: '# Review' },
          ],
        },
        {
          onProgress: detail => progress.push(detail),
          run: async (command, args, options) => {
            calls.push({ command, args, options });
            expect(existsSync(path.join(home, '.kilocode/skills/stale'))).toBe(true);
            await installFixture(options);
            return success;
          },
        }
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('pnpm');
      expect(calls[0].args).toEqual([
        'dlx',
        'skills@1.7.4',
        'add',
        'vercel-labs/skills',
        '--skill',
        'find-skills',
        '--global',
        '--agent',
        'kilo',
        '--copy',
        '--yes',
      ]);
      expect(calls[0].options?.inheritEnv).toBe(false);
      expect(calls[0].options?.env).toMatchObject({
        CI: '1',
        DISABLE_TELEMETRY: '1',
        GIT_TERMINAL_PROMPT: '0',
      });
      expect(calls[0].options?.env?.KILOCODE_TOKEN).toBeUndefined();
      expect(calls[0].options?.env?.GITHUB_TOKEN).toBeUndefined();
      expect(calls[0].options?.timeoutMs).toBe(60_000);
      expect(calls[0].options?.cwd).not.toBe(home);
      expect(existsSync(calls[0].options?.cwd ?? '')).toBe(false);
      expect(progress[0]).toContain('vercel-labs/skills@find-skills');
      expect(existsSync(path.join(home, '.kilocode/skills/stale'))).toBe(false);
      expect(
        await fs.readFile(path.join(home, '.kilocode/skills/find-skills/SKILL.md'), 'utf8')
      ).toBe('# Find skills');
      expect(
        await fs.readFile(path.join(home, '.kilocode/skills/find-skills/scripts/find.sh'), 'utf8')
      ).toBe('exit 0');
      expect(
        (await fs.stat(path.join(home, '.kilocode/skills/find-skills/scripts/find.sh'))).mode &
          0o111
      ).toBe(0o111);
      expect(await fs.readFile(path.join(home, '.kilocode/skills/review/SKILL.md'), 'utf8')).toBe(
        '# Review'
      );
      await materializeRuntimeProfile(home, {});
      expect(existsSync(path.join(home, '.kilocode/skills/find-skills'))).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('retries a transient install failure once', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
    let attempts = 0;
    try {
      await writeRuntimeSkills(home, [{ name: 'find-skills', source: 'vercel-labs/skills' }], {
        run: async (_command, _args, options) => {
          attempts++;
          if (attempts === 1) return { ...success, exitCode: 1 };
          await installFixture(options);
          return success;
        },
      });
      expect(attempts).toBe(2);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('fails after two attempts without leaking installer output', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
    let attempts = 0;
    let staging: string | undefined;
    const progress: string[] = [];
    try {
      expect(
        writeRuntimeSkills(home, [{ name: 'find-skills', source: 'vercel-labs/skills' }], {
          onProgress: detail => progress.push(detail),
          run: async (_command, _args, options) => {
            attempts++;
            staging = options?.cwd;
            return { ...success, exitCode: 1, stderr: 'do-not-expose-this-output' };
          },
        })
      ).rejects.toThrow(
        'Failed to install skills.sh skill vercel-labs/skills@find-skills: termination nonzero exit, exit code 1'
      );
      expect(attempts).toBe(2);
      expect(progress.at(-1)).toBe(
        'Failed to install skills.sh skill vercel-labs/skills@find-skills'
      );
      expect(existsSync(staging ?? '')).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('fails promptly when the CLI does not install the selected skill', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
    let attempts = 0;
    try {
      expect(
        writeRuntimeSkills(home, [{ name: 'find-skills', source: 'vercel-labs/skills' }], {
          run: async () => {
            attempts++;
            return success;
          },
        })
      ).rejects.toThrow('did not install a SKILL.md');
      expect(attempts).toBe(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('does not retry an aborted installation', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
    const controller = new AbortController();
    let attempts = 0;
    try {
      expect(
        writeRuntimeSkills(home, [{ name: 'find-skills', source: 'vercel-labs/skills' }], {
          signal: controller.signal,
          run: async () => {
            attempts++;
            controller.abort(new Error('session stopped'));
            return success;
          },
        })
      ).rejects.toThrow('session stopped');
      expect(attempts).toBe(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('preserves intercept CA configuration without exposing runtime credentials', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
    const previousCa = process.env.NODE_EXTRA_CA_CERTS;
    const previousToken = process.env.KILOCODE_TOKEN;
    process.env.NODE_EXTRA_CA_CERTS = '/test/intercept-ca.pem';
    process.env.KILOCODE_TOKEN = 'must-not-reach-installer';
    try {
      await writeRuntimeSkills(home, [{ name: 'find-skills', source: 'vercel-labs/skills' }], {
        run: async (_command, _args, options) => {
          expect(options?.env?.NODE_EXTRA_CA_CERTS).toBe('/test/intercept-ca.pem');
          expect(options?.env?.KILOCODE_TOKEN).toBeUndefined();
          await installFixture(options);
          return success;
        },
      });
    } finally {
      if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previousCa;
      if (previousToken === undefined) delete process.env.KILOCODE_TOKEN;
      else process.env.KILOCODE_TOKEN = previousToken;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('classifies a batch deadline with a specific failure and keeps the previous skills', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
    const deadline = new AbortController();
    const progress: string[] = [];
    try {
      await materializeRuntimeProfile(home, {
        runtimeSkills: [{ name: 'previous', rawMarkdown: 'Keep me' }],
      });
      const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      try {
        expect(
          materializeRuntimeProfile(
            home,
            {
              runtimeSkills: [{ name: 'find-skills', source: 'vercel-labs/skills' }],
            },
            {
              onProgress: detail => progress.push(detail),
              run: async () => {
                deadline.abort(new Error('batch timeout'));
                return success;
              },
            }
          )
        ).rejects.toMatchObject({ subtype: 'setup_command_timeout' });
      } finally {
        timeout.mockRestore();
      }
      expect(progress.at(-1)).toContain('installation timed out');
      expect(await fs.readFile(path.join(home, '.kilocode/skills/previous/SKILL.md'), 'utf8')).toBe(
        'Keep me'
      );
      expect((await fs.readdir(home)).some(name => name.startsWith('.profile-'))).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('serializes shared-home preparation and allows recovery after an aborted install', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-test-'));
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    try {
      await materializeRuntimeProfile(home, {
        runtimeSkills: [{ name: 'previous', rawMarkdown: 'Keep me' }],
      });
      const installing = materializeRuntimeProfile(
        home,
        {
          runtimeSkills: [{ name: 'find-skills', source: 'vercel-labs/skills' }],
        },
        {
          signal: controller.signal,
          run: async () => {
            started.resolve();
            await finish.promise;
            return success;
          },
        }
      );
      const aborted = installing.catch((error: unknown) => error);
      await started.promise;
      const sibling = materializeRuntimeProfile(home, {
        runtimeSkills: [{ name: 'sibling', rawMarkdown: 'Next' }],
      });
      expect(await fs.readFile(path.join(home, '.kilocode/skills/previous/SKILL.md'), 'utf8')).toBe(
        'Keep me'
      );
      expect(existsSync(path.join(home, '.kilocode/skills/sibling'))).toBe(false);
      controller.abort(new Error('stopped'));
      finish.resolve();
      expect(await aborted).toMatchObject({ message: 'stopped' });
      await sibling;
      expect(await fs.readFile(path.join(home, '.kilocode/skills/sibling/SKILL.md'), 'utf8')).toBe(
        'Next'
      );
      expect((await fs.readdir(home)).some(name => name.startsWith('.profile-'))).toBe(false);
    } finally {
      finish.resolve();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env.RUN_SKILLS_SH_INSTALL_TEST !== '1')(
    'installs a public skills.sh skill using the real pinned CLI',
    async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-skills-live-'));
      try {
        await materializeRuntimeProfile(home, {
          runtimeSkills: [{ name: 'find-skills', source: 'vercel-labs/skills' }],
        });
        const manifest = await fs.readFile(
          path.join(home, '.kilocode/skills/find-skills/SKILL.md'),
          'utf8'
        );
        expect(manifest).toContain('find-skills');
        expect(manifest.length).toBeGreaterThan(100);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
    150_000
  );
});
