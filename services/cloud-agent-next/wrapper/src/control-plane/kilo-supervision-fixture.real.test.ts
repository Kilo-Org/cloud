import { describe, expect, it } from 'bun:test';
import { activityFixture } from './kilo-activity-fixture.js';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;

// The service owns and typechecks its E2E harness. Keep that implementation
// outside the wrapper's rootDir while exercising the actual local HTTP adapter.
type FakeServer = {
  url: string;
  adminFetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
};

suite('shared supervision fake with pinned Kilo', () => {
  it('pairs HTTP drain with its real marker only after a held background child completes', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    const moduleUrl = new URL('../../../test/e2e/fake-llm-server.ts', import.meta.url).href;
    const { startFakeLlmServer } = (await import(moduleUrl)) as {
      startFakeLlmServer: (options: { host: string }) => Promise<FakeServer>;
    };
    const server = await startFakeLlmServer({ host: '127.0.0.1' });
    let fixture: Awaited<ReturnType<typeof activityFixture>> | undefined;
    try {
      const f = await activityFixture(binary, { modelBaseUrl: `${server.url}/api/openrouter` });
      fixture = f;
      const sessionID = await f.session();
      const tag = `drain-${crypto.randomUUID()}`;
      await f.prompt(sessionID, `__fake__:background-task:parent:${tag}`);
      await f.until(
        () => server.adminFetch(`/test/gate-status?tag=${tag}`).then(response => response.json()),
        value => value.engaged === true,
        'background child gate is held'
      );
      await f.until(
        () => f.sessionEvents(sessionID),
        events =>
          events.some(
            event => event.type === 'session.turn.close' && event.properties.reason === 'completed'
          ),
        'parent closes while child is held'
      );
      const token = crypto.randomUUID();
      let http = false;
      const drain = f.wrapper
        .drainSession({ sessionId: sessionID, directory: f.directory, token, signal: f.signal })
        .then(result => {
          http = result;
          return result;
        });
      void drain.catch(() => undefined);
      const marker = () =>
        f
          .sessionEvents(sessionID)
          .find(event => event.type === 'session.drained' && event.properties.token === token);
      // Observe a bounded held interval against the actual native coordinator.
      expect(
        await Promise.race([drain.then(() => 'early'), Bun.sleep(250).then(() => 'held')])
      ).toBe('held');
      expect(http).toBe(false);
      expect(marker()).toBeUndefined();
      expect(
        (await server.adminFetch(`/test/gate-status?tag=${tag}`).then(response => response.json()))
          .engaged
      ).toBe(true);
      expect(
        f.events.some(
          event =>
            event.type === 'session.created' &&
            typeof event.properties.info === 'object' &&
            event.properties.info !== null &&
            'parentID' in event.properties.info &&
            event.properties.info.parentID === sessionID
        )
      ).toBe(true);
      expect((await server.adminFetch(`/test/release?tag=${tag}`, { method: 'POST' })).status).toBe(
        204
      );
      expect(await drain).toBe(true);
      await f.until(marker, event => event !== undefined, 'matching processed native drain marker');
      console.info(
        JSON.stringify({
          contract: 'paired-background-drain',
          verifiedVersion: '7.8.1',
          sessionID,
          token,
          http,
          marker: marker()?.properties,
        })
      );
    } finally {
      await fixture?.dispose();
      await server.close();
    }
  }, 90_000);

  for (const mode of ['progress', 'silent', 'stuck'] as const) {
    it(`${mode} runs after the first native execution closes`, async () => {
      if (!binary) throw new Error('KILO_781_BINARY is required');
      const moduleUrl = new URL('../../../test/e2e/fake-llm-server.ts', import.meta.url).href;
      const { startFakeLlmServer } = (await import(moduleUrl)) as {
        startFakeLlmServer: (options: { host: string }) => Promise<FakeServer>;
      };
      const server = await startFakeLlmServer({ host: '127.0.0.1' });
      let fixture: Awaited<ReturnType<typeof activityFixture>> | undefined;
      try {
        const f = await activityFixture(binary, {
          modelBaseUrl: `${server.url}/api/openrouter`,
        });
        fixture = f;
        const sessionID = await f.session();
        const command = f.client.session.command(
          {
            sessionID,
            directory: f.directory,
            command: 'goal',
            arguments: `__fake__:supervision:contract-${mode}:${mode}:${mode === 'stuck' ? 60 : mode === 'progress' ? 3 : 1}`,
            model: 'contract/fake-deterministic',
          },
          { signal: f.signal }
        );
        void command.catch(() => undefined);
        await f.until(
          () => f.sessionEvents(sessionID),
          events => events.filter(event => event.type === 'session.turn.open').length >= 2,
          'autonomous execution opens'
        );
        expect(f.sessionEvents(sessionID).some(event => event.type === 'session.turn.close')).toBe(
          true
        );

        if (mode === 'stuck') {
          await f.until(
            () => server.adminFetch('/test/waiters').then(response => response.json()),
            value => value.liveResponses === 1,
            'autonomous model request holds without output'
          );
          expect((await f.wrapper.getSessionStatuses(f.directory, f.signal))[sessionID]?.type).toBe(
            'busy'
          );
          expect(
            await f.wrapper.abortSession({
              sessionId: sessionID,
              directory: f.directory,
              signal: f.signal,
            })
          ).toBe(true);
          // Native abort settles the execution but 7.8.1 can leave the upstream
          // response open. The fixture bounds it and dispose closes its process;
          // do not use upstream socket closure as native cancellation evidence.
        } else {
          await f.until(
            () =>
              f.client.session.messages(
                { sessionID, directory: f.directory, limit: 12 },
                { signal: f.signal }
              ),
            result =>
              result.data?.some(message =>
                message.parts.some(
                  part =>
                    part.type === 'text' && part.text === `supervision-complete-contract-${mode}`
                )
              ) === true,
            'autonomous work completes its goal'
          );
        }
        await command;
        await f.idle(sessionID);
        if (mode !== 'stuck') {
          const history = await f.client.session.messages(
            { sessionID, directory: f.directory, limit: 12 },
            { signal: f.signal }
          );
          const parts = history.data?.flatMap(message => message.parts) ?? [];
          if (mode === 'progress') {
            const tools = parts.filter(part => part.type === 'tool' && part.tool === 'bash');
            expect(tools).toHaveLength(4);
            expect(
              tools.every(part => part.type === 'tool' && part.state.status === 'completed')
            ).toBe(true);
            expect(
              parts.some(
                part =>
                  part.type === 'text' &&
                  part.text.includes('supervision-progress-contract-progress')
              )
            ).toBe(true);
          } else {
            const work = parts.find(
              part =>
                part.type === 'tool' &&
                part.tool === 'bash' &&
                part.state.input.command === 'sleep 1'
            );
            expect(work?.type === 'tool' && work.state.status).toBe('completed');
            if (work?.type !== 'tool' || work.state.status !== 'completed')
              throw new Error('Silent native tool did not complete');
            expect(work.state.time.end - work.state.time.start).toBeGreaterThanOrEqual(900);
          }
        }
        const closed = f
          .sessionEvents(sessionID)
          .filter(event => event.type === 'session.turn.close').length;
        expect(closed).toBeGreaterThanOrEqual(2);
        await Bun.sleep(200);
        expect(
          f.sessionEvents(sessionID).filter(event => event.type === 'session.turn.open')
        ).toHaveLength(closed);
      } finally {
        await fixture?.dispose();
        await server.close();
      }
    }, 90_000);
  }
});
