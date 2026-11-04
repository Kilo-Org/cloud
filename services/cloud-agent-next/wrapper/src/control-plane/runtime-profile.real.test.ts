import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWorktreeKiloEnvironment } from '../control/worktree-runtime.js';
import { materializeRuntimeProfile, withRuntimeProfileEnvironment } from './runtime-profile.js';
import { activityFixture } from './kilo-activity-fixture.js';
import { createTurnManager, type TurnKiloRuntime } from './turn.js';
import { runtimeKey } from './prepare.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { projectSafeSessionError } from '../../../src/shared/assistant-failure.js';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;

suite('pinned Kilo profile discovery', () => {
  it.each(['repository', 'profile'] as const)(
    'executes a %s-defined agent through the wrapper SDK with its own system prompt',
    async source => {
      if (!binary) throw new Error('KILO_781_BINARY is required');
      const agent = source === 'repository' ? 'foreman' : 'profile-foreman';
      const sentinel = `${source.toUpperCase()}_FOREMAN_PROMPT_SENTINEL`;
      const fixture = await activityFixture(
        binary,
        source === 'repository'
          ? {
              repositoryAgent: {
                slug: agent,
                markdown: `---\ndescription: Repository foreman\nmode: primary\n---\n${sentinel}\n`,
              },
            }
          : {
              runtimeAgents: [
                {
                  slug: agent,
                  name: 'Profile foreman',
                  config: { mode: 'primary', prompt: sentinel },
                },
              ],
            }
      );
      try {
        expect(
          await fs.access(path.join(fixture.root, '.config/kilo/profile.json')).then(
            () => true,
            () => false
          )
        ).toBe(source === 'profile');
        const sessionId = await fixture.session();
        await fixture.wrapper.sendPromptAsync({
          sessionId,
          messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          directory: fixture.directory,
          agent,
          model: { providerID: 'contract', modelID: 'fake-deterministic' },
          prompt: 'Respond once without tools.',
          signal: fixture.signal,
        });
        await fixture.until(
          () => fixture.sessionEvents(sessionId),
          events =>
            events.some(
              event =>
                event.type === 'session.turn.close' && event.properties.reason === 'completed'
            ),
          `${source} agent completed turn`
        );
        expect(fixture.modelRequests).toHaveLength(1);
        expect(fixture.modelRequests[0]).toContain(sentinel);
        expect(fixture.sessionEvents(sessionId).some(event => event.type === 'session.error')).toBe(
          false
        );
        const messages = await fixture.client.session.messages(
          { sessionID: sessionId, directory: fixture.directory },
          { signal: fixture.signal }
        );
        expect(messages.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              info: expect.objectContaining({ role: 'assistant', agent }),
            }),
          ])
        );
      } finally {
        await fixture.dispose();
      }
    },
    30_000
  );

  it('fails a missing repository agent visibly through the active wrapper SDK path', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    const fixture = await activityFixture(binary);
    const frames: ControlPlaneWrapperFrame[] = [];
    let manager: ReturnType<typeof createTurnManager> | undefined;
    try {
      const sessionId = await fixture.session();
      const spec = {
        sessionId: 'workspace_agent_probe',
        kiloSessionId: sessionId,
        directory: fixture.directory,
        attemptId: 'agent-probe',
        createdOnPlatform: 'webhook',
      };
      const runtime: TurnKiloRuntime = {
        directory: fixture.directory,
        env: {},
        client: fixture.wrapper,
        ensure: async () => fixture.wrapper,
        isSuspected: () => false,
        isRestarting: () => false,
        isUnavailable: () => false,
        isRetiredClient: () => false,
        sessionState: () => undefined,
        refreshActivity: async () => {},
      };
      manager = createTurnManager({
        timers: CONTROL_PLANE_TIMERS,
        emit: frame => frames.push(frame),
        runtimes: { get: key => (key === runtimeKey(spec) ? runtime : undefined) },
        materializeAttachments: async input => input,
      });
      manager.registerRoute(spec);
      manager.submit(spec.sessionId, {
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        turn: { type: 'prompt', prompt: 'Use the missing repository agent' },
        agent: { mode: 'missing-foreman', model: 'fake-deterministic' },
      });
      const error = await fixture.until(
        () =>
          fixture.events.find(
            event =>
              event.type === 'session.error' &&
              event.properties.sessionID === sessionId &&
              JSON.stringify(event.properties.error).includes('Agent not found')
          ),
        event => event !== undefined,
        'missing agent failure'
      );
      if (!error) throw new Error('Missing agent failure was not observed');
      manager.observeKiloEvent({
        ...error,
        nativeRuntimeId: 'agent-probe',
        runtimeKey: runtimeKey(spec),
      });
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: 'session.outcome',
          status: 'failed',
          reason: 'Agent "missing-foreman" was not found in the repository or profile',
          assistantReason: 'invalid_request',
        })
      );
      expect(projectSafeSessionError(error.properties.error, undefined)).toBe(
        'Agent "missing-foreman" was not found in the repository or profile'
      );
      expect(manager.hasPendingWork()).toBe(false);
      expect(manager.activeTurnCount()).toBe(0);
      expect(fixture.requests).toBe(0);
    } finally {
      manager?.shutdown();
      await fixture.dispose();
    }
  }, 30_000);

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
        ...(process.env.RUN_SKILLS_SH_INSTALL_TEST === '1'
          ? [{ name: 'find-skills', source: 'vercel-labs/skills' }]
          : []),
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
      const skills = await read('/skill');
      expect(skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'profile-review',
            description: 'Review a profile fixture',
          }),
        ])
      );
      if (process.env.RUN_SKILLS_SH_INSTALL_TEST === '1') {
        expect(skills).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'find-skills' })])
        );
      }
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
