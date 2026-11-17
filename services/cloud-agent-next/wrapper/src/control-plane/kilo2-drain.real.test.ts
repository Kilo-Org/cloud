import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { createMessageId } from '../../../src/shared/message-id.js';
import { createKiloRuntime } from './kilo-runtime.js';
import { createTurnManager } from './turn.js';
import { DrainSessionError } from '../kilo-api.js';

const binary = process.env.KILO2_BINARY;
const suite = binary ? describe : describe.skip;

suite('real Kilo v2 drain completion', () => {
  it.each(['success', 'retry', 'exhaust'] as const)(
    'holds the Cloud outcome for a background child and its resumed parent: %s',
    async fault => {
      if (!binary || process.env.KILO_RUNTIME_HARNESS !== 'kilo2')
        throw new Error('KILO2_BINARY and KILO_RUNTIME_HARNESS=kilo2 are required');
      const root = await fs.mkdtemp('/tmp/kilo2/cloud-drain-');
      const directory = path.join(root, 'workspace');
      await fs.mkdir(directory);
      const childGate = Promise.withResolvers<void>();
      const parentGate = Promise.withResolvers<void>();
      let launched = false;
      let childStarted = false;
      let parentResumed = false;
      let rootClosed = false;
      let drainCalls = 0;
      let modelCalls = 0;
      const frames: ControlPlaneWrapperFrame[] = [];
      const diagnostics: string[] = [];
      const fake = Bun.serve({
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname.endsWith('/models'))
            return Response.json({
              data: [
                {
                  id: 'fake-deterministic',
                  name: 'Drain proof',
                  context_length: 128000,
                  max_completion_tokens: 4096,
                  isFree: true,
                  pricing: { prompt: '0', completion: '0' },
                  opencode: { ai_sdk_provider: 'openai-compatible' },
                },
              ],
            });
          if (!new URL(request.url).pathname.endsWith('/chat/completions'))
            return Response.json({});
          modelCalls++;
          const body = await request.text();
          let delta: Record<string, unknown> = {
            role: 'assistant',
            content: 'parent foreground idle',
          };
          let finish = 'stop';
          if (body.includes('DRAIN_CHILD_SYSTEM')) {
            childStarted = true;
            await childGate.promise;
            delta = { role: 'assistant', content: 'background child finished' };
          } else if (body.includes('<subagent')) {
            parentResumed = true;
            await parentGate.promise;
            delta = { role: 'assistant', content: 'parent processed background result' };
          } else if (!launched) {
            launched = true;
            delta = {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'drain_child_call',
                  type: 'function',
                  function: {
                    name: 'subagent',
                    arguments: JSON.stringify({
                      agent: 'drain_child',
                      description: 'Drain proof child',
                      prompt: 'Do background work',
                      background: true,
                    }),
                  },
                },
              ],
            };
            finish = 'tool_calls';
          }
          const chunk = (value: unknown, reason: string | null) =>
            `data: ${JSON.stringify({
              id: 'drain-proof',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fake-deterministic',
              choices: [{ index: 0, delta: value, finish_reason: reason }],
            })}\n\n`;
          return new Response(chunk(delta, null) + chunk({}, finish) + 'data: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      const env = {
        PATH: `${path.dirname(binary)}:${process.env.PATH ?? ''}`,
        HOME: root,
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_STATE_HOME: path.join(root, 'state'),
        KILO_API_KEY: 'local-test',
        KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: 'local-test' } }),
        KILO_API_URL: fake.url.origin,
        KILO_AI_GATEWAY_URL: `${fake.url.origin}/v1`,
        KILO_DISABLE_MODELS_FETCH: '1',
        KILO_DISABLE_FFF: '1',
        KILO_CONFIG_CONTENT: JSON.stringify({
          model: 'kilo/fake-deterministic',
          agents: {
            title: { disabled: true },
            drain_child: { mode: 'subagent', system: 'DRAIN_CHILD_SYSTEM' },
          },
          providers: { kilo: { settings: { baseURL: `${fake.url.origin}/v1` } } },
          permissions: [{ action: '*', resource: '*', effect: 'allow' }],
          snapshots: false,
        }),
      };
      const sessionId = `ses_${'d'.repeat(26)}`;
      const runtime = createKiloRuntime({
        directory,
        env,
        timers: CONTROL_PLANE_TIMERS,
        pidfileDirectory: path.join(root, 'pids'),
        log: message => {
          if (process.env.KILO2_TEST_LOG) console.error(message);
        },
        onEvent(event) {
          if (event.type === 'session.turn.close' && event.properties.sessionID === sessionId)
            rootClosed = true;
          manager.observeKiloEvent(event);
        },
        onHarnessActivity: event => manager.observeActivity(event),
        onActivityChange: () => manager.refreshActivity(directory),
        onFeedInterrupted: id => manager.onFeedInterrupted(id, directory),
      });
      const manager = createTurnManager({
        timers: CONTROL_PLANE_TIMERS,
        runtimes: { get: () => runtime },
        emit: frame => frames.push(frame),
        log: message => diagnostics.push(message),
      });
      const outcomes = () => frames.filter(frame => frame.type === 'session.outcome');
      async function until(check: () => boolean) {
        const deadline = Date.now() + 20_000;
        while (!check()) {
          if (Date.now() > deadline)
            throw new Error(`Drain proof timed out: ${JSON.stringify(outcomes())}`);
          await Bun.sleep(10);
        }
      }
      try {
        const harness = await runtime.ensure();
        const drain = harness.drainSession;
        if (!drain) throw new Error('V2 harness has no native drain');
        harness.drainSession = async input => {
          drainCalls++;
          const result = await drain(input);
          if (fault === 'exhaust' || (fault === 'retry' && drainCalls === 1))
            throw new DrainSessionError('transient', 'Kilo v2 drain request failed', {
              cause: Object.assign(new TypeError('socket connection closed'), {
                code: 'ECONNRESET',
              }),
            });
          return result;
        };
        await harness.open({ sessionId, directory, env, restoreFiles: false, onRestore() {} });
        manager.registerRoute({
          sessionId: 'workspace_drain',
          kiloSessionId: sessionId,
          directory,
          attemptId: 'drain',
        });
        manager.submit('workspace_drain', {
          messageId: createMessageId(),
          turn: { type: 'prompt', prompt: 'Start the background proof' },
          agent: { mode: 'build', model: 'fake-deterministic' },
        });
        await until(() => childStarted && rootClosed && drainCalls > 0);
        expect(outcomes()).toEqual([]);
        expect(runtime.sessionState(sessionId)).toBeUndefined();
        childGate.resolve();
        await until(() => parentResumed);
        expect(outcomes()).toEqual([]);
        parentGate.resolve();
        await until(() => outcomes().length > 0);
        expect(outcomes()).toMatchObject([
          fault === 'exhaust'
            ? { status: 'failed', reason: 'completion_unconfirmed' }
            : { status: 'completed' },
        ]);
        expect(outcomes()).toHaveLength(1);
        expect(JSON.stringify(frames)).toContain('parent processed background result');
        expect(drainCalls).toBe(fault === 'success' ? 1 : fault === 'retry' ? 2 : 3);
        expect(modelCalls).toBe(4);
        if (fault !== 'success') {
          expect(diagnostics.some(line => line.includes('ECONNRESET'))).toBe(true);
          expect(diagnostics.some(line => line.includes('socket connection closed'))).toBe(true);
        }
      } finally {
        childGate.resolve();
        parentGate.resolve();
        manager.shutdown();
        await runtime.shutdown();
        await fake.stop(true);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    60_000
  );
});
