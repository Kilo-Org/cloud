import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createMessageId } from '../../../src/shared/message-id.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import { createKiloRuntime } from './kilo-runtime.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';
import { createKilo2EventFeed } from './kilo2-event-feed.js';
import { createKilo2Api, kilo2MessageSchema, kilo2SessionPath } from './kilo2-api.js';
import { createKilo2Reads } from './kilo2-reads.js';
import type { HarnessActivityEvent } from './harness-activity.js';
import type { KiloServer } from '../kilo-server-auth.js';
import {
  createRuntimeProfileMaterializer,
  withRuntimeProfileEnvironment,
} from './runtime-profile.js';
import { buildWorktreeKiloEnvironment } from '../control/worktree-runtime.js';
import { buildCloudAgentRules } from '../../../src/shared/cloud-agent-rules.js';
import { createTurnManager } from './turn.js';
import { runtimeKey } from './prepare.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';

const binary = process.env.KILO2_BINARY;
const suite = binary ? describe : describe.skip;

suite('real Kilo v2 harness', () => {
  it('accepts the pinned empty compaction error and replays the same compact ID after a restart', async () => {
    if (!binary) throw new Error('KILO2_BINARY is required');
    if (process.env.KILO_RUNTIME_HARNESS !== 'kilo2')
      throw new Error('Run this suite with KILO_RUNTIME_HARNESS=kilo2');
    const version = Bun.spawn([binary, '--version']);
    expect((await new Response(version.stdout).text()).trim()).toBe('kilo2 v0.0.0-v2-77');
    expect(await version.exited).toBe(0);
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kilo2-compact-')));
    const directory = path.join(root, 'workspace');
    await fs.mkdir(directory);
    const summary =
      '## Objective\n- Verify compaction identity.\n\n## Requirements\n- Local tests.\n\n## Decisions\n- Use the harness.\n\n## Work State\n### Completed\n- Created history.\n### Active\n- Verify replay.\n### Blocked\n- (none)\n\n## Next Move\n1. Verify replay.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- This is synthetic history.';
    let modelRequests = 0;
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith('/models'))
          return Response.json({
            data: [
              {
                id: 'fake-deterministic',
                name: 'Local compaction contract',
                context_length: 128000,
                max_completion_tokens: 4096,
                isFree: true,
                pricing: { prompt: '0', completion: '0' },
                opencode: { ai_sdk_provider: 'openai-compatible' },
              },
            ],
          });
        if (!pathname.endsWith('/chat/completions')) return Response.json({});
        modelRequests++;
        return new Response(
          `data: ${JSON.stringify({
            id: 'local',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake-deterministic',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: summary },
                finish_reason: 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
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
      KILO_CONFIG_CONTENT: JSON.stringify({
        model: 'kilo/fake-deterministic',
        agents: { title: { disabled: true } },
        snapshots: false,
      }),
      KILO_DISABLE_MODELS_FETCH: '1',
      KILO_DISABLE_FFF: '1',
    };
    let server: KiloServer | undefined;
    const events: KiloFeedEvent[] = [];
    const makeRuntime = () =>
      createKiloRuntime({
        directory,
        env,
        timers: CONTROL_PLANE_TIMERS,
        pidfileDirectory: path.join(root, 'pids'),
        log(message) {
          if (process.env.KILO2_TEST_LOG) console.error(message);
        },
        onEvent(event) {
          events.push(event);
        },
        onHarnessActivity() {},
        openFeed(source, callbacks) {
          server = source.server;
          return createKilo2EventFeed({ source, ...callbacks });
        },
      });
    const signal = AbortSignal.timeout(60_000);
    const sessionId = `ses_${'c'.repeat(26)}`;
    const emptyId = createMessageId();
    const compactId = createMessageId();
    const open = { sessionId, directory, env, signal, restoreFiles: false, onRestore() {} };
    const compact = {
      sessionId,
      directory,
      messageId: compactId,
      model: 'fake-deterministic',
      signal,
    };
    const api = () => {
      if (!server) throw new Error('Kilo v2 server is not started');
      return createKilo2Api(server);
    };
    const readMessage = async (id: string) =>
      kilo2MessageSchema.parse(
        await api().data(`${kilo2SessionPath(sessionId)}/message/${id}`, { signal })
      );
    let runtime = makeRuntime();
    try {
      let harness = await runtime.ensure();
      await harness.open(open);
      expect(await harness.compact({ ...compact, messageId: emptyId })).toBe('executed');
      expect(await readMessage(emptyId)).toMatchObject({
        id: emptyId,
        type: 'compaction',
        status: 'failed',
        error: { type: 'compaction.unavailable', message: 'Nothing to compact yet' },
      });
      expect(modelRequests).toBe(0);
      await harness.submit({
        sessionId,
        directory,
        messageId: createMessageId(),
        prompt: 'Create synthetic compaction history',
        model: 'fake-deterministic',
        signal,
      });
      await api().request(`/api/experimental/session/${sessionId}/wait`, {
        method: 'POST',
        signal,
      });
      expect(await harness.compact(compact)).toBe('executed');
      const before = await readMessage(compactId);
      expect(before).toMatchObject({
        id: compactId,
        type: 'compaction',
        status: 'completed',
        summary,
      });
      const requestsBeforeReplay = modelRequests;
      await runtime.shutdown();
      events.length = 0;
      runtime = makeRuntime();
      harness = await runtime.ensure();
      await harness.open(open);
      expect(await harness.compact(compact)).toBe('replayed');
      expect(await readMessage(compactId)).toEqual(before);
      expect(modelRequests).toBe(requestsBeforeReplay);
      await Bun.sleep(100);
      expect(
        events.filter(
          event =>
            event.properties.sessionID === sessionId &&
            (event.type === 'session.turn.open' || event.type === 'session.turn.close')
        )
      ).toEqual([]);
      const messages = (await createKilo2Reads(api(), directory).messages(sessionId, signal))
        .messages;
      expect(messages.filter(message => message.id === compactId)).toHaveLength(1);
      expect(
        messages.filter(message => message.type === 'compaction' && message.status === 'completed')
      ).toHaveLength(1);
    } finally {
      await runtime.shutdown();
      await fake.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('streams real messages, retains context across a process restart, executes tools, answers questions, and interrupts', async () => {
    if (!binary) throw new Error('KILO2_BINARY is required');
    if (process.env.KILO_RUNTIME_HARNESS !== 'kilo2')
      throw new Error('Run this suite with KILO_RUNTIME_HARNESS=kilo2');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kilo2-harness-')));
    const directory = path.join(root, 'workspace');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'AGENTS.md'), 'SYNTHETIC_REPOSITORY_INSTRUCTION');
    await createRuntimeProfileMaterializer().materialize(root, {
      runtimeInstructions: [
        { name: 'disabled-proof', content: 'SYNTHETIC_DISABLED_PROFILE_INSTRUCTION' },
      ],
    });
    const profile = {
      runtimeInstructions: [
        { name: 'profile-proof', content: 'SYNTHETIC_ENABLED_PROFILE_INSTRUCTION' },
      ],
    };
    await createRuntimeProfileMaterializer().materialize(root, profile);
    const events: KiloFeedEvent[] = [];
    const activity: HarnessActivityEvent[] = [];
    const requests: string[] = [];
    let archivedMessages: unknown[] = [];
    const historyReads: Array<string | undefined> = [];
    const readHistoryPage = async (cursor: string | undefined) => {
      historyReads.push(cursor);
      return {
        kind: 'success',
        source: archivedMessages.length
          ? { version: 'v2', session: { id: sessionId } }
          : { version: 'v1' },
        info: { id: sessionId },
        messages: archivedMessages,
        nextCursor: null,
        omittedItemCount: 0,
      };
    };
    let serverUrl = '';
    let server: KiloServer | undefined;
    const nativeMessages = async () => {
      if (!server) throw new Error('Kilo v2 server is not started');
      return (await createKilo2Reads(createKilo2Api(server), directory).messages(sessionId, signal))
        .messages;
    };
    let mode: 'text' | 'tool' | 'question' | 'hold' = 'text';
    let toolSent = false;
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
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
        onHarnessActivity: event => activity.push(event),
        openFeed(source, callbacks) {
          serverUrl = source.server.url;
          server = source.server;
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
      let harness = await runtime.ensure();
      expect((await fetch(`${serverUrl}/api/session`)).status).toBe(401);
      await harness.open({
        sessionId,
        readHistoryPage,
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
      const callbackContext = '<cloud-agent-context session-id="workspace_callback-marker" />';
      const startupFailureNote =
        'Some startup commands failed during session preparation. The session started anyway.';
      const latestContextUpdate = () =>
        z
          .object({ messages: z.array(z.object({ content: z.string().nullish() })) })
          .parse(JSON.parse(requests.at(-1) ?? '{}'))
          .messages.filter(
            message =>
              message.content?.startsWith('<system-update>') &&
              message.content.includes('cloud-agent-context')
          )
          .at(-1)?.content;
      async function prompt(text: string, context?: string) {
        const start = events.length;
        await harness.submit({
          sessionId,
          directory,
          messageId: createMessageId(),
          prompt: text,
          context,
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
      await prompt('remember amber-history-marker', `${startupFailureNote}\n\n${callbackContext}`);
      expect(requests.at(-1)).toContain('SYNTHETIC_REPOSITORY_INSTRUCTION');
      expect(requests.at(-1)).toContain('SYNTHETIC_ENABLED_PROFILE_INSTRUCTION');
      expect(requests.at(-1)).not.toContain('SYNTHETIC_DISABLED_PROFILE_INSTRUCTION');
      const builtIn = buildCloudAgentRules({});
      expect(requests.at(-1)?.split(JSON.stringify(builtIn).slice(1, -1))).toHaveLength(2);
      expect(requests.at(-1)).toContain('workspace_callback-marker');
      expect(requests.at(-1)).toContain(startupFailureNote);
      expect(
        (await nativeMessages())
          .filter(message => message.type === 'user')
          .map(message => message.text)
      ).toEqual(['remember amber-history-marker']);
      expect(activity.some(event => event.activity.type === 'delta')).toBe(true);
      expect(events.some(event => event.type.startsWith('message.'))).toBe(false);
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
      await prompt('recall the earlier marker', callbackContext);
      expect(requests.at(-1)).toContain('SYNTHETIC_ENABLED_PROFILE_INSTRUCTION');
      expect(requests.at(-1)).toContain('SYNTHETIC_REPOSITORY_INSTRUCTION');
      expect(requests.at(-1)).toContain('amber-history-marker');
      expect(requests.at(-1)).toContain('workspace_callback-marker');
      // V2 preserves the original prompt prefix and supersedes changed context in-band.
      expect(latestContextUpdate()).toContain('supersedes the previous value');
      expect(latestContextUpdate()).toContain('workspace_callback-marker');
      expect(latestContextUpdate()).not.toContain(startupFailureNote);
      const history = await nativeMessages();
      expect(history.filter(message => message.type === 'user')).toHaveLength(2);
      expect(
        history.some(message =>
          (message.content ?? []).some(
            item => item.type === 'text' && item.text?.includes('remembered amber')
          )
        )
      ).toBe(true);
      archivedMessages = history.map(message => ({ message }));
      await runtime.shutdown();
      env.XDG_DATA_HOME = path.join(root, 'replacement-data');
      runtime = makeRuntime();
      harness = await runtime.ensure();
      let restored = false;
      await harness.open({
        sessionId,
        readHistoryPage,
        directory,
        env,
        signal,
        restoreFiles: false,
        onRestore() {
          restored = true;
        },
      });
      expect(restored).toBe(true);
      expect(historyReads).toEqual([undefined, undefined]);
      await prompt('recall the marker after native database replacement', callbackContext);
      expect(requests.at(-1)).toContain('SYNTHETIC_ENABLED_PROFILE_INSTRUCTION');
      expect(requests.at(-1)).toContain('SYNTHETIC_REPOSITORY_INSTRUCTION');
      expect(requests.at(-1)).toContain('amber-history-marker');
      expect(requests.at(-1)).toContain('workspace_callback-marker');
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
      expect(latestContextUpdate()).toBeDefined();
      expect(latestContextUpdate()).not.toContain('workspace_callback-marker');
      expect(
        (await nativeMessages()).some(message =>
          (message.content ?? []).some(
            item =>
              item.type === 'tool' &&
              item.state?.status === 'completed' &&
              (item.state.content ?? []).some(part => part.text?.includes('native-tool-ok'))
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
        await harness.compact({
          sessionId,
          directory,
          messageId: createMessageId(),
          model: 'fake-deterministic',
          signal,
        })
      ).toBe('executed');
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
      await runtime.shutdown();
      await fake.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('discovers profile skills and agents and executes profile commands through production configuration', async () => {
    if (!binary) throw new Error('KILO2_BINARY is required');
    if (process.env.KILO_RUNTIME_HARNESS !== 'kilo2')
      throw new Error('Run this suite with KILO_RUNTIME_HARNESS=kilo2');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kilo2-profile-')));
    const directory = path.join(root, 'workspace');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'AGENTS.md'), 'SYNTHETIC_REPOSITORY_INSTRUCTION');
    const materializer = createRuntimeProfileMaterializer();
    await materializer.materialize(root, {
      runtimeInstructions: [
        { name: 'disabled-proof', content: 'SYNTHETIC_DISABLED_PROFILE_INSTRUCTION' },
      ],
    });
    materializer.release(root);
    const profile = {
      runtimeInstructions: [
        { name: 'profile-proof', content: 'SYNTHETIC_ENABLED_PROFILE_INSTRUCTION' },
      ],
      kiloCommands: [
        {
          name: 'profile-command',
          template: 'Run the profile command $ARGUMENTS',
          agent: 'profile-reviewer',
        },
        {
          name: 'profile-subtask',
          template: 'Run a profile subtask',
          agent: 'profile-helper',
          subtask: true,
        },
      ],
      runtimeAgents: [
        {
          slug: 'profile-reviewer',
          name: 'Profile reviewer',
          config: {
            mode: 'primary' as const,
            prompt: 'SYNTHETIC_PROFILE_AGENT',
            model: 'kilo/fake-deterministic',
            temperature: 0.25,
            top_p: 0.8,
            steps: 4,
            permission: { bash: 'deny' },
          },
        },
        {
          slug: 'profile-helper',
          name: 'Profile helper',
          config: { mode: 'subagent' as const, prompt: 'SYNTHETIC_PROFILE_HELPER' },
        },
      ],
      runtimeSkills: [
        {
          name: 'profile-review',
          rawMarkdown:
            '---\nname: profile-review\ndescription: SYNTHETIC_PROFILE_SKILL\n---\nReview profile fixtures.',
          files: { 'scripts/check.sh': 'echo synthetic-profile-skill' },
        },
      ],
    };
    await materializer.materialize(root, profile);
    const requests: string[] = [];
    let mcpAuthenticated = false;
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/mcp') {
          if (request.method !== 'POST') return new Response(null, { status: 405 });
          const rpc = z
            .object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
            .parse(await request.json());
          if (rpc.id === undefined) return new Response(null, { status: 202 });
          mcpAuthenticated = request.headers.get('x-profile-proof') === 'synthetic-mcp-value';
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            result:
              rpc.method === 'initialize'
                ? {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'synthetic-profile', version: '1' },
                  }
                : {
                    tools: [
                      {
                        name: 'profile-proof',
                        description: 'SYNTHETIC_PROFILE_MCP',
                        inputSchema: { type: 'object', properties: {} },
                      },
                    ],
                  },
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
        requests.push(await request.text());
        const chunk = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({
            id: 'local',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake-deterministic',
            choices: [{ index: 0, delta, finish_reason: reason }],
          })}\n\n`;
        return new Response(
          chunk({ role: 'assistant', content: 'done' }, null) +
            chunk({}, 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        );
      },
    });
    const env: Record<string, string> = {
      ...withRuntimeProfileEnvironment(
        buildWorktreeKiloEnvironment(
          directory,
          root,
          {
            scopeId: 'local-scope',
            token: 'local-test',
            targets: {
              backendBaseUrl: fake.url.origin,
              providerBaseUrl: `${fake.url.origin}/api/openrouter`,
              sessionIngestBaseUrl: fake.url.origin,
            },
          },
          {},
          { PATH: `${path.dirname(binary)}:${process.env.PATH ?? ''}` },
          {
            'profile-proof': {
              type: 'remote',
              url: `${fake.url.origin}/mcp`,
              headers: { 'x-profile-proof': 'synthetic-mcp-value' },
            },
          }
        ),
        profile
      ),
      KILO_DISABLE_MODELS_FETCH: '1',
      KILO_DISABLE_FFF: '1',
    };
    expect(env.KILO_CONFIG).toBe(path.join(root, '.config', 'kilo', 'profile.json'));
    expect(Object.keys(JSON.parse(env.KILO_CONFIG_CONTENT))).toContain('permission');
    const events: KiloFeedEvent[] = [];
    let profileServer: KiloServer | undefined;
    const runtime = createKiloRuntime({
      directory,
      env,
      timers: CONTROL_PLANE_TIMERS,
      pidfileDirectory: path.join(root, 'pids'),
      log: message => {
        if (process.env.KILO2_TEST_LOG) console.error(message);
      },
      onEvent(event) {
        events.push(event);
        manager.observeKiloEvent({ ...event, runtimeKey: runtimeKey(route) });
      },
      onHarnessActivity() {},
      openFeed(source, callbacks) {
        profileServer = source.server;
        return createKilo2EventFeed({ source, ...callbacks });
      },
    });
    const signal = AbortSignal.timeout(60_000);
    const sessionId = `ses_${'b'.repeat(26)}`;
    const route = {
      sessionId: 'workspace_profile',
      kiloSessionId: sessionId,
      directory,
      attemptId: 'profile',
    };
    const frames: ControlPlaneWrapperFrame[] = [];
    const manager = createTurnManager({
      timers: CONTROL_PLANE_TIMERS,
      runtimes: { get: key => (key === runtimeKey(route) ? runtime : undefined) },
      emit: frame => frames.push(frame),
    });
    manager.registerRoute(route);
    async function until(check: () => Promise<boolean>, label: string) {
      const deadline = Date.now() + 20_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await Bun.sleep(50);
      }
    }
    try {
      const harness = await runtime.ensure();
      await harness.open({
        sessionId,
        directory,
        env,
        signal,
        restoreFiles: false,
        onRestore() {},
      });
      await harness.submit({
        sessionId,
        directory,
        messageId: createMessageId(),
        prompt: 'confirm profile instructions',
        model: 'fake-deterministic',
        signal,
      });
      const turnClose = () => events.find(event => event.type === 'session.turn.close');
      await until(async () => Boolean(turnClose()), 'profile instruction turn');
      expect(turnClose()?.properties.reason).toBe('completed');
      await until(
        async () =>
          frames.some(
            frame =>
              frame.type === 'session.events' &&
              frame.events.some(
                event =>
                  event.type === 'commands.available' &&
                  JSON.stringify(event.properties.commands).includes('profile-command')
              )
          ),
        'native command.updated catalog publication'
      );
      expect(events.some(event => event.type === 'command.updated')).toBe(true);
      expect(requests.at(-1)).toContain('SYNTHETIC_REPOSITORY_INSTRUCTION');
      expect(requests.at(-1)).toContain('SYNTHETIC_ENABLED_PROFILE_INSTRUCTION');
      expect(requests.at(-1)).not.toContain('SYNTHETIC_DISABLED_PROFILE_INSTRUCTION');
      expect((await harness.listCommands()).commands).toContainEqual(
        expect.objectContaining({ name: 'profile-command' })
      );
      if (!profileServer) throw new Error('Profile runtime did not start');
      const api = createKilo2Api(profileServer);
      const query = `location[directory]=${encodeURIComponent(directory)}`;
      await until(
        async () =>
          z
            .array(
              z.object({
                name: z.string(),
                status: z.object({ status: z.string() }),
              })
            )
            .parse(await api.data(`/api/mcp?${query}`))
            .some(
              server => server.name === 'profile-proof' && server.status.status === 'connected'
            ),
        'profile MCP connection'
      );
      expect(mcpAuthenticated).toBe(true);
      expect(await api.data(`/api/agent?${query}`)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'profile-reviewer',
            steps: 4,
            request: expect.objectContaining({ body: { temperature: 0.25, top_p: 0.8 } }),
            permissions: expect.arrayContaining([
              { action: 'shell', resource: '*', effect: 'deny' },
            ]),
          }),
        ])
      );
      expect(await api.data(`/api/skill?${query}`)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'profile-review',
            description: 'SYNTHETIC_PROFILE_SKILL',
          }),
        ])
      );
      const start = events.length;
      await harness.command({
        sessionId,
        directory,
        command: 'profile-command',
        args: 'SYNTHETIC_ARGUMENT',
        model: 'fake-deterministic',
        signal,
      });
      await until(
        async () => events.slice(start).some(event => event.type === 'session.turn.close'),
        'profile command turn'
      );
      expect(requests.at(-1)).toContain('Run the profile command SYNTHETIC_ARGUMENT');
      expect(requests.at(-1)).toContain('SYNTHETIC_PROFILE_AGENT');
      const siblingId = `ses_${'c'.repeat(26)}`;
      await harness.open({
        sessionId: siblingId,
        directory,
        env,
        signal,
        restoreFiles: false,
        onRestore() {},
      });
      await harness.command({
        sessionId: siblingId,
        directory,
        command: 'profile-command',
        args: 'SYNTHETIC_SIBLING_ARGUMENT',
        model: 'fake-deterministic',
        signal,
      });
      await until(
        async () =>
          requests.some(
            request =>
              request.includes('SYNTHETIC_SIBLING_ARGUMENT') &&
              request.includes('SYNTHETIC_PROFILE_AGENT')
          ),
        'sibling profile command'
      );
      const siblingRequest = requests.find(
        request =>
          request.includes('SYNTHETIC_SIBLING_ARGUMENT') &&
          request.includes('SYNTHETIC_PROFILE_AGENT')
      );
      expect(siblingRequest).toContain('SYNTHETIC_ENABLED_PROFILE_INSTRUCTION');
      expect(siblingRequest).toContain('SYNTHETIC_PROFILE_SKILL');
      await harness.command({
        sessionId,
        directory,
        command: 'profile-subtask',
        model: 'fake-deterministic',
        signal,
      });
      const children = () => api.data(`/api/session?${query}`);
      await until(
        async () =>
          z
            .array(z.object({ parentID: z.string().optional() }))
            .parse(await children())
            .some(child => child.parentID === sessionId),
        'profile subtask child'
      );
    } finally {
      await runtime.shutdown();
      await fake.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
