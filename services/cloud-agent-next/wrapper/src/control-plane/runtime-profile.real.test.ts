import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWorktreeKiloEnvironment } from '../control/worktree-runtime.js';
import { materializeRuntimeProfile, withRuntimeProfileEnvironment } from './runtime-profile.js';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;

suite('pinned Kilo profile discovery', () => {
  it('discovers profile skills, custom agents and commands from the control-plane runtime home', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-kilo-781-'));
    const home = path.join(root, 'home');
    const directory = path.join(root, 'workspace');
    const profile = {
      runtimeSkills: [
        {
          name: 'profile-review',
          rawMarkdown:
            '---\nname: profile-review\ndescription: Review a profile fixture\n---\nRead scripts/check.sh before reviewing.',
          files: { 'scripts/check.sh': 'echo profile-skill' },
        },
      ],
      runtimeAgents: [
        {
          slug: 'profile-reviewer',
          name: 'Profile reviewer',
          config: { prompt: 'Review profile fixtures', mode: 'primary' as const },
        },
      ],
      kiloCommands: [
        {
          name: 'profile-check',
          template: 'Review the profile fixture',
          agent: 'profile-reviewer',
        },
      ],
    };
    await fs.mkdir(directory, { recursive: true });
    await materializeRuntimeProfile(home, profile);
    const env = withRuntimeProfileEnvironment(
      buildWorktreeKiloEnvironment(
        directory,
        home,
        {
          scopeId: 'profile-test',
          token: 'local-test',
          targets: {
            backendBaseUrl: 'http://127.0.0.1:1',
            providerBaseUrl: 'http://127.0.0.1:1',
            sessionIngestBaseUrl: 'http://127.0.0.1:1',
          },
        },
        {},
        { PATH: process.env.PATH, TMPDIR: os.tmpdir() }
      ),
      profile
    );
    const proc = Bun.spawn([binary, 'serve', '--hostname=127.0.0.1', '--port=0'], {
      cwd: directory,
      env,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const signal = AbortSignal.timeout(25_000);
    const expired = new Promise<never>((_, reject) =>
      signal.addEventListener(
        'abort',
        () => reject(new Error('Kilo profile discovery timed out')),
        { once: true }
      )
    );
    try {
      const reader = proc.stdout.getReader();
      let output = '';
      let url: string | undefined;
      while (!url) {
        const next = await Promise.race([reader.read(), expired]);
        if (next.done) throw new Error('Kilo exited before listening');
        output = (output + new TextDecoder().decode(next.value)).slice(-8192);
        url = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      }
      const read = async (endpoint: string): Promise<unknown> => {
        const target = new URL(endpoint, url);
        target.searchParams.set('directory', directory);
        const response = await fetch(target, { signal });
        expect(response.ok).toBe(true);
        return response.json();
      };
      expect(await read('/skill')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'profile-review',
            description: 'Review a profile fixture',
          }),
        ])
      );
      expect(await read('/agent')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'profile-reviewer', mode: 'primary' }),
        ])
      );
      expect(await read('/command')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'profile-check',
            agent: 'profile-reviewer',
            template: 'Review the profile fixture',
          }),
          expect.objectContaining({ name: 'profile-review', source: 'skill' }),
        ])
      );
      expect(
        await fs.readFile(
          path.join(home, '.kilocode/skills/profile-review/scripts/check.sh'),
          'utf8'
        )
      ).toBe('echo profile-skill');
    } finally {
      proc.kill();
      await proc.exited;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
