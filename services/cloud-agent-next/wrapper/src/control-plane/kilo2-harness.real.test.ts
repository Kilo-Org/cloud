import { z } from 'zod';
import { kilo2MessageSchema } from './kilo2-api.js';
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMessageId } from '../../../src/shared/message-id.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import { createKiloRuntime } from './kilo-runtime.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';
import { createKilo2EventFeed } from './kilo2-event-feed.js';

const binary = process.env.KILO2_BINARY;
const suite = binary ? describe : describe.skip;

suite('real Kilo v2 harness', () => {
  it('streams real messages, retains context across a process restart, executes tools, answers questions, and interrupts', async () => {
    if (!binary) throw new Error('KILO2_BINARY is required');
    if (process.env.KILO_RUNTIME_HARNESS !== 'kilo2')
      throw new Error('Run this suite with KILO_RUNTIME_HARNESS=kilo2');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kilo2-harness-')));
    const directory = path.join(root, 'workspace');
    const events: KiloFeedEvent[] = [];
    const requests: string[] = [];
    let archivedMessages: unknown[] = [];
    const previousControlUrl = process.env.SANDBOX_CONTROL_URL;
    let serverUrl = '';
    let mode: 'text' | 'tool' | 'question' | 'hold' = 'text';
    let toolSent = false;
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/api/runtime-credential-proxy/history/page') {
          expect(request.method).toBe('POST');
          expect(request.headers.get('authorization')).toBe('Bearer local-test');
          return Response.json({
            kind: 'success',
            source: archivedMessages.length
              ? { version: 'v2', session: { id: sessionId } }
              : { version: 'v1' },
            info: { id: sessionId },
            messages: archivedMessages,
            nextCursor: null,
            omittedItemCount: 0,
          });
        }
        if (new URL(request.url).pathname.endsWith('/models'))
          return Response.json({
            data: [
              {
                id: 'fake-deterministic',
                name: 'Local contract',
                context_length: 128000,
                max_completion_tokens: 4096,
                isFree: true,
                pricing: { prompt: '0', completion: '0' },
                opencode: { ai_sdk_provider: 'openai-compatible' },
              },
            ],
          });
        if (!new URL(request.url).pathname.endsWith('/chat/completions')) return Response.json({});
        const body = await request.text();
        requests.push(body);
        if (mode === 'hold') {
          await new Promise<void>(resolve => {
            request.signal.addEventListener('abort', () => resolve(), { once: true });
            setTimeout(resolve, 15_000);
          });
        }
        let delta: Record<string, unknown> = {
          role: 'assistant',
          content: body.includes('amber-history-marker')
            ? 'remembered amber-history-marker'
            : 'done',
        };
        if (body.includes('## Work State') && body.includes('## Objective'))
          delta = {
            role: 'assistant',
            content:
              '## Objective\n- Retain amber-history-marker.\n\n## Requirements\n- Local tests.\n\n## Decisions\n- Use the harness.\n\n## Work State\n### Completed\n- Verified history.\n### Active\n- Verify compaction.\n### Blocked\n- (none)\n\n## Next Move\n1. Continue tests.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- The marker is amber-history-marker.',
          };
        let finish = 'stop';
        if ((mode === 'tool' || mode === 'question') && !toolSent) {
          toolSent = true;
          delta = {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'native_call',
                type: 'function',
                function: {
                  name: mode === 'tool' ? 'shell' : 'question',
                  arguments: JSON.stringify(
                    mode === 'tool'
                      ? { command: 'printf native-tool-ok', description: 'Local harness proof' }
                      : {
                          questions: [
                            {
                              question: 'Select a value',
                              header: 'Proof',
                              options: [
                                { label: 'Amber', description: 'Keep amber' },
                                { label: 'Blue', description: 'Use blue' },
                              ],
                            },
                          ],
                        }
                  ),
                },
              },
            ],
          };
          finish = 'tool_calls';
        }
        const chunk = (value: unknown, reason: string | null) =>
          `data: ${JSON.stringify({
            id: 'local',
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
      KILO_CONFIG_CONTENT: JSON.stringify({
        model: 'kilo/fake-deterministic',
        agents: { title: { disabled: true } },
        providers: { kilo: { settings: { baseURL: `${fake.url.origin}/v1` } } },
        permissions: [
          { action: '*', resource: '*', effect: 'allow' },
          { action: 'shell', resource: '*', effect: 'ask' },
        ],
        snapshots: false,
      }),
      KILO_AI_GATEWAY_URL: `${fake.url.origin}/v1`,
      KILO_DISABLE_MODELS_FETCH: '1',
      KILO_DISABLE_FFF: '1',
    };
    const makeRuntime = () =>
      createKiloRuntime({
        directory,
        env,
        timers: CONTROL_PLANE_TIMERS,
        pidfileDirectory: path.join(root, 'pids'),
        log: message => {
          if (process.env.KILO2_TEST_LOG) console.error(message);
        },
        onEvent: event => events.push(event),
        openFeed(source, callbacks) {
          serverUrl = source.server.url;
          return createKilo2EventFeed({ source, ...callbacks });
        },
      });
    let runtime = makeRuntime();
    const signal = AbortSignal.timeout(90_000);
    const sessionId = `ses_${'a'.repeat(26)}`;
    async function until(check: () => Promise<boolean>, label: string) {
      const deadline = Date.now() + 20_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await Bun.sleep(50);
      }
    }
    try {
      process.env.SANDBOX_CONTROL_URL = fake.url.origin;
      let harness = await runtime.ensure();
      expect((await fetch(`${serverUrl}/api/session`)).status).toBe(401);
      await harness.open({
        sessionId,
        cloudSessionId: 'workspace_local',
        directory,
        env,
        signal,
        restoreFiles: false,
        onRestore() {},
      });
      expect(
        await harness
          .open({
            sessionId,
            directory: path.join(root, 'foreign'),
            env,
            signal,
            restoreFiles: false,
            onRestore() {},
          })
          .catch(error => String(error))
      ).toContain('another directory');
      async function prompt(text: string) {
        const start = events.length;
        await harness.submit({
          sessionId,
          directory,
          messageId: createMessageId(),
          prompt: text,
          model: 'fake-deterministic',
          signal,
        });
        await until(
          async () =>
            events
              .slice(start)
              .some(
                event =>
                  event.type === 'session.turn.close' && event.properties.reason === 'completed'
              ),
          text
        );
        expect(runtime.sessionState(sessionId)).toBeUndefined();
      }
      await prompt('remember amber-history-marker');
      expect(events.some(event => event.type === 'message.part.delta')).toBe(true);
      expect(await fs.stat(path.join(root, 'data/kilo2'))).toBeDefined();
      await runtime.shutdown();
      runtime = makeRuntime();
      harness = await runtime.ensure();
      await harness.open({
        sessionId,
        directory,
        env,
        signal,
        restoreFiles: false,
        onRestore() {},
      });
      await prompt('recall the earlier marker');
      expect(requests.at(-1)).toContain('amber-history-marker');
      const history = await harness.reads.getRecentSessionMessages(sessionId, directory, signal);
      expect(history.filter(message => message.info.role === 'user')).toHaveLength(2);
      expect(
        history.some(message =>
          message.parts.some(part => part.type === 'text' && part.text.includes('remembered amber'))
        )
      ).toBe(true);
      archivedMessages = history.map(item => ({
        message: z.object({ kilo2: kilo2MessageSchema }).parse(item.info).kilo2,
        ...('parentID' in item.info ? { parentID: item.info.parentID } : {}),
      }));
      await runtime.shutdown();
      env.XDG_DATA_HOME = path.join(root, 'replacement-data');
      process.env.SANDBOX_CONTROL_URL = fake.url.origin;
      runtime = makeRuntime();
      harness = await runtime.ensure();
      let restored = false;
      await harness.open({
        sessionId,
        cloudSessionId: 'workspace_local',
        directory,
        env,
        signal,
        restoreFiles: false,
        onRestore() {
          restored = true;
        },
      });
      expect(restored).toBe(true);
      await prompt('recall the marker after native database replacement');
      expect(requests.at(-1)).toContain('amber-history-marker');
      mode = 'tool';
      toolSent = false;
      const toolTurn = prompt('run the native tool');
      await until(
        async () => (await harness.reads.getPermissions(directory, signal)).length > 0,
        'shell permission'
      );
      const permission = (await harness.reads.getPermissions(directory, signal))[0];
      await until(
        async () =>
          events.some(
            event => event.type === 'permission.asked' && event.properties.id === permission.id
          ),
        'permission identity'
      );
      expect(
        await harness.answer({
          directory,
          signal,
          interactive: true,
          reply: { action: 'permission', permissionId: permission.id, response: 'once' },
        })
      ).toBe(true);
      await toolTurn;
      expect(
        (await harness.reads.getRecentSessionMessages(sessionId, directory, signal)).some(message =>
          message.parts.some(
            part =>
              part.type === 'tool' &&
              part.state.status === 'completed' &&
              part.state.output.includes('native-tool-ok')
          )
        )
      ).toBe(true);
      mode = 'question';
      toolSent = false;
      const start = events.length;
      await harness.submit({
        sessionId,
        directory,
        messageId: createMessageId(),
        prompt: 'ask a question',
        model: 'fake-deterministic',
        signal,
      });
      await until(
        async () => (await harness.reads.getQuestions(directory, signal)).length > 0,
        'question'
      );
      const question = (await harness.reads.getQuestions(directory, signal))[0];
      expect(
        await harness.answer({
          directory,
          signal,
          reply: { action: 'answer', questionId: question.id, answers: [['Amber']] },
        })
      ).toBe(true);
      await until(
        async () =>
          events
            .slice(start)
            .some(
              event =>
                event.type === 'session.turn.close' && event.properties.reason === 'completed'
            ),
        'answer completion'
      );
      mode = 'hold';
      const count = requests.length;
      await harness.submit({
        sessionId,
        directory,
        messageId: createMessageId(),
        prompt: 'wait for interruption',
        model: 'fake-deterministic',
        signal,
      });
      await until(async () => requests.length > count, 'model request');
      expect(await harness.interrupt({ sessionId, directory, signal })).toBe(true);
      expect(
        (await harness.reads.getSessionStatuses(directory, signal))[sessionId]
      ).toBeUndefined();
      expect(
        await harness.observe({
          directory,
          observedDirectories: [],
          knownSessions: [{ id: sessionId, directory, messageIds: [] }],
          signal,
        })
      ).toHaveLength(1);
      mode = 'text';
      expect(
        await harness.compact({ sessionId, directory, model: 'fake-deterministic', signal })
      ).toBe(true);
      const pty = await harness.terminals.createPty({
        cwd: directory,
        title: 'Local v2 PTY',
        env: {},
      });
      expect(
        (await harness.terminals.resizePty(pty.id, { cols: 90, rows: 25 }, directory)).id
      ).toBe(pty.id);
      expect(await harness.terminals.deletePty(pty.id, directory)).toBe(true);
      expect(await harness.terminals.isIdle(directory, signal)).toBe(true);
      expect((await harness.release({ sessionId, directory, deadlineMs: 10_000, signal })).ok).toBe(
        true
      );
    } finally {
      if (previousControlUrl === undefined) delete process.env.SANDBOX_CONTROL_URL;
      else process.env.SANDBOX_CONTROL_URL = previousControlUrl;
      await runtime.shutdown();
      await fake.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
