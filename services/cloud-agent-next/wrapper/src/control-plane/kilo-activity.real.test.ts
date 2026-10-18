import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { activityFixture, type ModelReply } from './kilo-activity-fixture.js';
import { readSessionSnapshot } from './session-snapshot.js';
import { createRuntimeActivity } from './runtime-activity.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;
type Fixture = Awaited<ReturnType<typeof activityFixture>>;

function contract(
  name: string,
  run: (fixture: Fixture) => Promise<void>,
  options?: Parameters<typeof activityFixture>[1]
) {
  it(
    name,
    async () => {
      if (!binary) throw new Error('KILO_781_BINARY is required');
      const fixture = await activityFixture(binary, options);
      try {
        await run(fixture);
      } finally {
        await fixture.dispose();
      }
    },
    90_000
  );
}

suite('pinned Kilo 7.8.1 native activity contract', () => {
  contract(
    'native execution stays in its saved directory when a prompt supplies another directory',
    async f => {
      const held = Promise.withResolvers<ModelReply>();
      f.respond(() => held.promise);
      const sessionID = await f.session();
      const directory = path.join(f.root, 'execution-only');
      await fsp.mkdir(directory);
      try {
        await f.prompt(sessionID, 'execute in another instance', directory);
        await f.until(
          () => f.requests,
          count => count === 1,
          'alternate execution directory'
        );
        const metadata = await f.wrapper.listSessionMetadata(f.signal);
        expect(metadata.find(session => session.id === sessionID)?.directory).toBe(f.directory);
        expect(metadata.some(session => session.directory === directory)).toBe(false);
        expect(
          (await f.wrapper.getSessionStatuses(directory, f.signal))[sessionID]
        ).toBeUndefined();
        expect((await f.wrapper.getSessionStatuses(f.directory, f.signal))[sessionID]?.type).toBe(
          'busy'
        );
        expect(
          f.events.some(
            event => event.directory === f.directory && event.type === 'session.turn.open'
          )
        ).toBe(true);
        const snapshot = await readSessionSnapshot({
          client: f.wrapper,
          directory: f.directory,
          observedDirectories: [directory],
          knownSessions: [],
          signal: f.signal,
        });
        expect(snapshot.find(session => session.id === sessionID)).toMatchObject({
          directory: f.directory,
          status: 'busy',
        });
        expect(
          await f.wrapper.abortSession({
            sessionId: sessionID,
            directory: f.directory,
            signal: f.signal,
          })
        ).toBe(true);
        await f.idle(sessionID);
      } finally {
        held.resolve({ text: 'cleanup' });
      }
    }
  );

  contract(
    'an idle status and a nonblocking suggestion can coexist with independently running tools',
    async f => {
      let step = 0;
      f.respond(async () =>
        step++ === 0
          ? {
              tools: [
                {
                  name: 'suggest',
                  arguments: {
                    suggest: 'Continue?',
                    actions: [{ label: 'Continue', prompt: 'continue' }],
                  },
                },
                {
                  name: 'bash',
                  arguments: {
                    command: 'sleep 15',
                    timeout: 20000,
                    description: 'Independent work',
                  },
                },
              ],
            }
          : { text: 'finished' }
      );
      const sessionID = await f.session();
      await f.prompt(sessionID);
      const pending = await f.until(
        () => f.client.suggestion.list({ directory: f.directory }, { signal: f.signal }),
        r => r.data?.length === 1,
        'suggestion'
      );
      expect(pending.data![0].blocking).toBe(false);
      await f.idle(sessionID);
      const messageID = pending.data![0].tool!.messageID;
      await f.until(
        () =>
          f.client.session.message(
            { sessionID, directory: f.directory, messageID },
            { signal: f.signal }
          ),
        r =>
          r.data?.parts.filter(p => p.type === 'tool' && p.state.status === 'running').length === 2,
        'running tool snapshot despite idle status'
      );
      expect(f.sessionEvents(sessionID).some(e => e.type === 'session.turn.close')).toBe(false);
      await f.client.session.abort({ sessionID, directory: f.directory }, { signal: f.signal });
      await f.until(
        () => f.sessionEvents(sessionID),
        events => events.some(e => e.type === 'session.turn.close'),
        'suggestion abort'
      );
    }
  );

  contract(
    'a foreground task follows its child through permission identity, allow, rejection and resume',
    async f => {
      let call = 0;
      const childReply = Promise.withResolvers<ModelReply>();
      f.respond(async () => {
        const current = call++;
        if (current === 0)
          return {
            tools: [
              {
                name: 'task',
                arguments: {
                  description: 'Child execution',
                  prompt: 'Do fixture work',
                  subagent_type: 'general',
                },
              },
            ],
          };
        if (current === 1) return childReply.promise;
        if (current === 2)
          return {
            tools: [
              {
                name: 'bash',
                arguments: { command: 'echo rejected', description: 'Rejected probe' },
              },
            ],
          };
        return { text: 'finished' };
      });
      const sessionID = await f.session();
      const faults: string[] = [];
      const activity = createRuntimeActivity({
        nativeRuntimeId: 'child-permission-contract',
        directory: f.directory,
        client: f.wrapper,
        timers: CONTROL_PLANE_TIMERS.wrapper,
        now: Date.now,
        onDeadline: (_identity, reason) => faults.push(reason),
        onFault: reason => {
          faults.push(reason);
          return true;
        },
        onChange() {},
      });
      try {
        await f.prompt(sessionID);
        const children = await f.until(
          () =>
            f.client.session.children({ sessionID, directory: f.directory }, { signal: f.signal }),
          r => r.data?.length === 1,
          'task child'
        );
        const childID = children.data![0].id;
        await f.until(
          () => f.requests,
          count => count === 2,
          'child model execution'
        );
        expect(childID).not.toBe(sessionID);
        const messages = await f.client.session.messages(
          { sessionID, directory: f.directory, limit: 1 },
          { signal: f.signal }
        );
        const messageID = messages.data![0].info.id;
        const detail = await f.until(
          () =>
            f.client.session.message(
              { sessionID, directory: f.directory, messageID },
              { signal: f.signal }
            ),
          r =>
            r.data?.parts.some(
              p => p.type === 'tool' && p.tool === 'task' && p.state.status === 'running'
            ) === true,
          'parent task snapshot'
        );
        const task = detail.data!.parts.find(p => p.type === 'tool' && p.tool === 'task');
        expect(
          task?.type === 'tool' && task.state.status === 'running' && task.state.metadata?.sessionId
        ).toBe(childID);
        activity.connected();
        await activity.refresh();
        expect(activity.isReady()).toBe(true);
        expect(activity.state(sessionID)?.activity).toBe('running');
        expect(activity.state(childID)?.activity).toBe('running');
        childReply.resolve({
          tools: [
            {
              name: 'bash',
              arguments: { command: 'sleep 5', description: 'Allowed probe', timeout: 15000 },
            },
          ],
        });
        const pending = await f.until(
          () => f.client.permission.list({ directory: f.directory }, { signal: f.signal }),
          result => result.data?.some(request => request.sessionID === childID) === true,
          'child permission request'
        );
        const allowed = pending.data!.find(request => request.sessionID === childID)!;
        expect(allowed.sessionID).toBe(childID);
        expect(allowed.tool?.callID).toBeDefined();
        expect(allowed.tool?.messageID).toBeDefined();
        await activity.refresh();
        expect(activity.state(childID)?.activity).toBe('waiting');
        expect(activity.state(sessionID)?.activity).toBe('waiting');
        expect(activity.needsCompute()).toBe(false);
        expect(activity.isIdle()).toBe(false);
        await f.client.permission.reply(
          { requestID: allowed.id, directory: f.directory, reply: 'once' },
          { signal: f.signal }
        );
        await f.until(
          () => f.client.permission.list({ directory: f.directory }, { signal: f.signal }),
          result => !result.data?.some(request => request.id === allowed.id),
          'allowed permission cleared'
        );
        await f.until(
          async () => {
            await activity.refresh();
            return activity.state(childID)?.activity;
          },
          value => value === 'running',
          'child resumes after permission'
        );
        expect(activity.state(sessionID)?.activity).toBe('running');
        expect(activity.needsCompute()).toBe(true);

        const secondPending = await f.until(
          () => f.client.permission.list({ directory: f.directory }, { signal: f.signal }),
          result =>
            result.data?.some(
              request => request.sessionID === childID && request.id !== allowed.id
            ) === true,
          'second child permission request'
        );
        const rejected = secondPending.data!.find(
          request => request.sessionID === childID && request.id !== allowed.id
        )!;
        expect(rejected.sessionID).toBe(childID);
        expect(rejected.tool?.messageID).toBeDefined();
        await f.client.permission.reply(
          { requestID: rejected.id, directory: f.directory, reply: 'reject' },
          { signal: f.signal }
        );
        await f.until(
          () => f.client.permission.list({ directory: f.directory }, { signal: f.signal }),
          result => (result.data?.length ?? 0) === 0,
          'permission rejection'
        );
        await f.until(
          () => f.sessionEvents(sessionID),
          events => events.some(e => e.type === 'session.turn.close'),
          'permission completion'
        );
        await f.idle(sessionID);
        await f.idle(childID);
        await activity.refresh();
        expect(activity.isReady()).toBe(true);
        expect(activity.needsCompute()).toBe(false);
        expect(faults).toEqual([]);
      } finally {
        activity.dispose();
        childReply.resolve({ text: 'cleanup' });
      }
    },
    { subagentPermission: { bash: 'ask' } }
  );

  contract('a silent tool obeys its own shorter timeout and allows normal completion', async f => {
    let step = 0;
    f.respond(async () =>
      step++ === 0
        ? {
            tools: [
              {
                name: 'bash',
                arguments: { command: 'sleep 10', description: 'Short bounded tool', timeout: 200 },
              },
            ],
          }
        : { text: 'finished after tool timeout' }
    );
    const sessionID = await f.session();
    await f.prompt(sessionID);
    await f.until(
      () => f.sessionEvents(sessionID),
      events => events.some(e => e.type === 'session.turn.close'),
      'tool timeout completion'
    );
    const updates = f.events
      .filter(e => e.type === 'message.part.updated')
      .map(
        e =>
          e.properties.part as {
            type?: string;
            tool?: string;
            state?: { status?: string; output?: string };
          }
      );
    expect(updates.some(p => p.tool === 'bash' && p.state?.status === 'running')).toBe(true);
    expect(
      updates.some(
        p =>
          p.tool === 'bash' &&
          p.state?.status === 'completed' &&
          p.state.output?.includes('timeout')
      )
    ).toBe(true);
    await f.idle(sessionID);
  });

  contract('keeps overlapping prompt and compaction requests busy until native idle', async f => {
    let held = Promise.withResolvers<ModelReply>();
    f.respond(() => held.promise);
    const sessionID = await f.session();
    try {
      await f.prompt(sessionID);
      await f.until(
        () => f.requests,
        count => count === 1,
        'first request'
      );
      const summary = f.client.session.summarize(
        {
          sessionID,
          directory: f.directory,
          providerID: 'contract',
          modelID: 'fake-deterministic',
        },
        { signal: f.signal }
      );
      void summary.catch(() => undefined);
      await f.prompt(sessionID, 'queued overlapping prompt');
      await f.until(
        () => f.sessionEvents(sessionID),
        events => events.filter(e => e.type === 'session.turn.open').length >= 2,
        'overlapping opens'
      );
      expect(
        (await f.client.session.status({ directory: f.directory }, { signal: f.signal })).data?.[
          sessionID
        ]?.type
      ).toBe('busy');
      const old = held;
      held = Promise.withResolvers<ModelReply>();
      old.resolve({ text: 'first response' });
      await f.until(
        () => f.requests,
        count => count >= 2,
        'next request'
      );
      expect(
        (await f.client.session.status({ directory: f.directory }, { signal: f.signal })).data?.[
          sessionID
        ]?.type
      ).toBe('busy');
      await f.client.session.abort(
        { sessionID, directory: f.directory, scope: 'tree' },
        { signal: f.signal }
      );
      held.resolve({ text: 'cleanup' });
      await summary;
      await f.idle(sessionID);
      const events = f.sessionEvents(sessionID);
      expect(events.filter(e => e.type === 'session.turn.close').length).toBeGreaterThanOrEqual(2);
    } finally {
      held.resolve({ text: 'cleanup' });
    }
  });

  contract(
    'reports parent identity and tree abort cancels children without stopping an unrelated root',
    async f => {
      const held = Promise.withResolvers<ModelReply>();
      f.respond(() => held.promise);
      const parent = await f.session();
      const child = await f.session(f.directory, parent);
      const sibling = await f.session();
      try {
        await Promise.all([f.prompt(parent), f.prompt(child), f.prompt(sibling)]);
        await f.until(
          () => f.requests,
          count => count === 3,
          'three native executions'
        );
        const metadata = await f.client.session.get(
          { sessionID: child, directory: f.directory },
          { signal: f.signal }
        );
        expect(metadata.data?.parentID).toBe(parent);
        expect(
          f.events.some(
            e =>
              e.type === 'session.created' &&
              (e.properties.info as { id?: string; parentID?: string })?.id === child &&
              (e.properties.info as { parentID?: string }).parentID === parent
          )
        ).toBe(true);
        expect(
          (
            await f.client.session.abort(
              { sessionID: parent, directory: f.directory, scope: 'tree' },
              { signal: f.signal }
            )
          ).data
        ).toBe(true);
        const status = await f.client.session.status(
          { directory: f.directory },
          { signal: f.signal }
        );
        expect(status.data?.[parent]).toBeUndefined();
        expect(status.data?.[child]).toBeUndefined();
        expect(status.data?.[sibling]?.type).toBe('busy');
        await f.client.session.abort(
          { sessionID: sibling, directory: f.directory },
          { signal: f.signal }
        );
      } finally {
        held.resolve({ text: 'cleanup' });
      }
    }
  );

  contract(
    'observes unrouted native execution, directory isolation, bounded message snapshots and confirmed abort',
    async f => {
      const held = Promise.withResolvers<ModelReply>();
      f.respond(() => held.promise);
      const directory = path.join(f.root, 'other');
      const sessionID = await f.session(directory);
      try {
        await f.prompt(sessionID, 'native work without Cloud submit', directory);
        await f.until(
          () => f.requests,
          count => count > 0,
          'model request'
        );
        const statuses = await f.client.session.status({ directory }, { signal: f.signal });
        expect(statuses.data?.[sessionID]?.type).toBe('busy');
        expect(
          (await f.client.session.status({ directory: f.directory }, { signal: f.signal })).data?.[
            sessionID
          ]
        ).toBeUndefined();
        expect(
          f.events.some(e => e.directory === directory && e.type === 'session.turn.open')
        ).toBe(true);
        // The new public Session API owns different execution; it cannot enumerate legacy prompt loops.
        const active = await f.client.v2.session.active({ signal: f.signal });
        expect(active.error).toBeUndefined();
        expect(active.data?.data).toBeDefined();
        expect(active.data?.data[sessionID]).toBeUndefined();
        const listed = await f.globalClient.experimental.session.list(
          { limit: 100 },
          { signal: f.signal }
        );
        expect(listed.data?.some(s => s.id === sessionID && s.directory === directory)).toBe(true);
        expect(await f.wrapper.listSessionMetadata(f.signal)).toContainEqual({
          id: sessionID,
          directory,
        });
        const messages = await f.client.session.messages(
          { sessionID, directory, limit: 2 },
          { signal: f.signal }
        );
        expect(messages.data?.length).toBeLessThanOrEqual(2);
        expect(messages.data?.some(m => m.info.role === 'user')).toBe(true);
        expect(messages.data?.some(m => m.info.role === 'assistant')).toBe(true);
        expect(
          await f.wrapper.abortSession({ sessionId: sessionID, directory, signal: f.signal })
        ).toBe(true);
        await f.idle(sessionID, directory);
        await f.until(
          () => f.sessionEvents(sessionID),
          events => events.some(e => e.type === 'session.turn.close'),
          'abort close'
        );
        expect(
          f
            .sessionEvents(sessionID)
            .some(e => e.type === 'session.turn.close' && e.properties.reason === 'interrupted')
        ).toBe(true);
        held.resolve({ text: 'late output' });
        f.respond(async () => ({ text: 'recovered' }));
        const start = f.events.length;
        await f.prompt(sessionID, 'recover same chat', directory);
        await f.until(
          () => f.events.slice(start),
          events => events.some(e => e.type === 'session.turn.close'),
          'new execution closes'
        );
        await f.idle(sessionID, directory);
        const recovered = await f.client.session.messages(
          { sessionID, directory, limit: 1 },
          { signal: f.signal }
        );
        const detail = await f.client.session.message(
          { sessionID, directory, messageID: recovered.data![0].info.id },
          { signal: f.signal }
        );
        expect(detail.data?.parts.some(p => p.type === 'text' && p.text === 'recovered')).toBe(
          true
        );
      } finally {
        held.resolve({ text: 'cleanup' });
      }
    }
  );

  contract(
    'exposes running tools and multiple pending interactions without a transcript scan',
    async f => {
      let step = 0;
      f.respond(async () =>
        step++ === 0
          ? {
              tools: [
                {
                  name: 'question',
                  arguments: {
                    questions: [
                      {
                        header: 'One',
                        question: 'First?',
                        options: [{ label: 'Yes', description: 'Proceed' }],
                      },
                    ],
                  },
                },
                {
                  name: 'question',
                  arguments: {
                    questions: [
                      {
                        header: 'Two',
                        question: 'Second?',
                        options: [{ label: 'Yes', description: 'Proceed' }],
                      },
                    ],
                  },
                },
                {
                  name: 'bash',
                  arguments: {
                    command: 'sleep 15',
                    description: 'Silent bounded work',
                    timeout: 20000,
                  },
                },
              ],
            }
          : { text: 'answered' }
      );
      const sessionID = await f.session();
      await f.prompt(sessionID);
      const pending = await f.until(
        () => f.client.question.list({ directory: f.directory }, { signal: f.signal }),
        result => result.data?.length === 2,
        'two questions'
      );
      const questions = pending.data!;
      expect(questions[0].id).not.toBe(questions[1].id);
      expect(questions.every(q => q.sessionID === sessionID && !!q.tool)).toBe(true);
      const messages = await f.client.session.messages(
        { sessionID, directory: f.directory, limit: 1 },
        { signal: f.signal }
      );
      expect(messages.data?.[0]?.info.id).toBe(questions[0].tool?.messageID);
      const detail = await f.until(
        () =>
          f.client.session.message(
            { sessionID, directory: f.directory, messageID: questions[0].tool!.messageID },
            { signal: f.signal }
          ),
        result =>
          result.data?.parts.filter(p => p.type === 'tool' && p.state.status === 'running')
            .length === 3,
        'persisted running parts'
      );
      const tools = detail.data?.parts.filter(p => p.type === 'tool');
      await f.until(
        () => f.wrapper.getRecentSessionMessages(sessionID, f.directory, f.signal),
        messages =>
          messages
            .flatMap(m => m.parts)
            .filter(p => p.type === 'tool' && p.state.status === 'running').length === 3,
        'paged running parts projection'
      );
      expect(
        tools
          ?.filter(p => p.state.status === 'running')
          .map(p => p.tool)
          .sort()
      ).toEqual(['bash', 'question', 'question']);
      expect(
        (await f.client.session.status({ directory: f.directory }, { signal: f.signal })).data?.[
          sessionID
        ]?.type
      ).toBe('busy');
      await f.client.question.reply(
        { requestID: questions[0].id, directory: f.directory, answers: [['Yes']] },
        { signal: f.signal }
      );
      const remaining = await f.client.question.list(
        { directory: f.directory },
        { signal: f.signal }
      );
      expect(remaining.data?.map(q => q.id)).toEqual([questions[1].id]);
      expect(
        (
          await f.client.session.abort(
            { sessionID, directory: f.directory, scope: 'tree' },
            { signal: f.signal }
          )
        ).data
      ).toBe(true);
      await f.idle(sessionID);
      expect(
        f.sessionEvents(sessionID).find(event => event.type === 'session.error')
      ).toMatchObject({ properties: { error: { name: 'MessageAbortedError' } } });
      // Abort settles execution but can leave a request in the question projection.
      // It must not keep compute awake after cancellation; the next prompt dismisses it.
      const stale = await f.client.question.list({ directory: f.directory }, { signal: f.signal });
      expect(stale.data?.map(q => q.id)).toEqual([questions[1].id]);
      const recoveredActivity = createRuntimeActivity({
        nativeRuntimeId: 'recovered',
        directory: f.directory,
        client: f.wrapper,
        timers: CONTROL_PLANE_TIMERS.wrapper,
        now: Date.now,
        onDeadline: () => {
          throw new Error('Unexpected deadline after abort');
        },
        onFault: () => {
          throw new Error('Unexpected observation failure');
        },
        onChange: () => undefined,
      });
      try {
        recoveredActivity.connected();
        await recoveredActivity.refresh();
        expect(recoveredActivity.isReady()).toBe(true);
        expect(recoveredActivity.needsCompute()).toBe(false);
      } finally {
        recoveredActivity.dispose();
      }
      const offset = f.events.length;
      await f.prompt(sessionID, 'resume after aborted question');
      await f.until(
        () => f.events.slice(offset),
        events => events.some(e => e.type === 'session.turn.close'),
        'recovery completion'
      );
      expect(
        (await f.client.question.list({ directory: f.directory }, { signal: f.signal })).data
      ).toEqual([]);
    }
  );

  contract(
    'observes goal continuations through ordinary open/status/progress/idle events and stops their future continuation',
    async f => {
      const held = Promise.withResolvers<ModelReply>();
      let requests = 0;
      f.respond(async () => {
        requests++;
        if (requests === 1)
          return {
            tools: [
              {
                name: 'bash',
                arguments: { command: 'echo progress', description: 'Make progress' },
              },
            ],
          };
        if (requests === 2) return { text: 'first execution complete' };
        return held.promise;
      });
      const sessionID = await f.session();
      try {
        const command = f.client.session.command(
          {
            sessionID,
            directory: f.directory,
            command: 'goal',
            arguments: 'Continue fixture work',
            model: 'contract/fake-deterministic',
          },
          { signal: f.signal }
        );
        void command.catch(() => undefined);
        await f.until(
          () => requests,
          count => count >= 3,
          'autonomous continuation'
        );
        const events = f.sessionEvents(sessionID);
        expect(events.filter(e => e.type === 'session.turn.open').length).toBeGreaterThanOrEqual(2);
        expect(events.some(e => e.type === 'session.turn.close')).toBe(true);
        expect(
          (await f.client.session.status({ directory: f.directory }, { signal: f.signal })).data?.[
            sessionID
          ]?.type
        ).toBe('busy');
        expect(
          (
            await f.client.session.abort(
              { sessionID, directory: f.directory, scope: 'tree' },
              { signal: f.signal }
            )
          ).data
        ).toBe(true);
        held.resolve({ text: 'late continuation' });
        await command;
        await f.idle(sessionID);
        const stoppedAt = requests;
        await Bun.sleep(500);
        expect(requests).toBe(stoppedAt);
      } finally {
        held.resolve({ text: 'cleanup' });
      }
    }
  );
});
