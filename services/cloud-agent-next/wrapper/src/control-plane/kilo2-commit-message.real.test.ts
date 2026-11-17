import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PINNED_CLIS } from '../../../scripts/runtime-cli-artifact.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';
import { runAutoCommit } from '../auto-commit.js';
import { git } from '../utils.js';
import { createKiloRuntime } from './kilo-runtime.js';
import { createKilo2EventFeed } from './kilo2-event-feed.js';

const binary = process.env.KILO2_BINARY;
const suite = binary ? describe : describe.skip;

suite('real Kilo v2 commit messages', () => {
  it('uses the small model and repository prompt below a non-Git runtime directory', async () => {
    if (!binary) throw new Error('KILO2_BINARY is required');
    if (process.env.KILO_RUNTIME_HARNESS !== 'kilo2')
      throw new Error('Run this suite with KILO_RUNTIME_HARNESS=kilo2');
    const version = Bun.spawn([binary, '--version']);
    expect((await new Response(version.stdout).text()).trim()).toBe(
      PINNED_CLIS.kilo2.reportedVersion
    );
    expect(await version.exited).toBe(0);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo2-commit-message-'));
    const runtimeDirectory = path.join(root, 'workspace');
    const directory = path.join(runtimeDirectory, 'repository');
    const remote = path.join(root, 'remote.git');
    await fs.mkdir(directory, { recursive: true });
    const generatedMessage = 'docs: explain local commit verification';
    const customPrompt = 'Describe the documentation change with a concise conventional commit.';
    const requests: Array<{ model: string; prompt: string }> = [];
    let rejectGeneration = false;
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith('/models'))
          return Response.json({
            data: ['primary', 'commit-model'].map(id => ({
              id,
              name: id,
              context_length: 128000,
              max_completion_tokens: 4096,
              isFree: true,
              pricing: { prompt: '0', completion: '0' },
              opencode: { ai_sdk_provider: 'openai-compatible' },
            })),
          });
        if (!pathname.endsWith('/chat/completions')) return Response.json({});
        const body = await request.json();
        requests.push({ model: body.model, prompt: JSON.stringify(body.messages) });
        if (rejectGeneration)
          return Response.json(
            { error: { message: 'Synthetic provider rejection', type: 'invalid_request_error' } },
            { status: 400 }
          );
        return new Response(
          `data: ${JSON.stringify({
            id: 'local-commit',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: body.model === 'commit-model' ? generatedMessage : '',
                },
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
        model: 'kilo/primary',
        agents: { title: { model: 'kilo/commit-model' } },
        snapshots: false,
      }),
      KILO_DISABLE_MODELS_FETCH: '1',
      KILO_DISABLE_FFF: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Local Test',
      GIT_AUTHOR_EMAIL: 'local-test@example.com',
      GIT_COMMITTER_NAME: 'Local Test',
      GIT_COMMITTER_EMAIL: 'local-test@example.com',
    };
    const command = async (args: string[], cwd = directory) => {
      const result = await git(args, { cwd, env, inheritEnv: false, timeoutMs: 10_000 });
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    const runtime = createKiloRuntime({
      directory: runtimeDirectory,
      env,
      timers: CONTROL_PLANE_TIMERS,
      pidfileDirectory: path.join(root, 'pids'),
      log() {},
      onEvent() {},
      onHarnessActivity() {},
      openFeed: (source, callbacks) => createKilo2EventFeed({ source, ...callbacks }),
    });
    try {
      await command(['init', '--bare', remote]);
      await command(['init', '-b', 'feature/commit-message']);
      await command(['config', 'user.name', 'Local Test']);
      await command(['config', 'user.email', 'local-test@example.com']);
      await fs.writeFile(path.join(directory, 'README.md'), 'Local verification.\n');
      await fs.writeFile(
        path.join(directory, 'kilo.json'),
        JSON.stringify({ commit_message: { prompt: customPrompt } })
      );
      await command(['add', 'README.md', 'kilo.json']);
      await command(['commit', '-m', 'test: initialize local repository']);
      await command(['remote', 'add', 'origin', remote]);
      await fs.appendFile(path.join(directory, 'README.md'), 'Verify generated commit messages.\n');
      await fs.writeFile(
        path.join(directory, 'verification.md'),
        'Inspect the stored commit title.\n'
      );

      const harness = await runtime.ensure();
      const events: IngestEvent[] = [];
      expect(
        await runAutoCommit({
          workspacePath: directory,
          kiloClient: harness,
          env,
          onEvent: event => events.push(event),
          signal: AbortSignal.timeout(45_000),
        })
      ).toEqual({ success: true });
      expect(await command(['log', '-1', '--format=%s'])).toBe(generatedMessage);
      expect(
        await command(['--git-dir', remote, 'log', 'feature/commit-message', '-1', '--format=%s'])
      ).toBe(generatedMessage);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.model).toBe('commit-model');
      expect(requests[0]?.prompt).toContain(customPrompt);
      expect(requests[0]?.prompt).toContain('added verification.md');
      expect(
        events.find(event => event.streamEventType === 'autocommit_completed')?.data
      ).toMatchObject({ success: true, commitMessage: `${generatedMessage}\n` });
      expect(await command(['status', '--porcelain'])).toBe('');

      rejectGeneration = true;
      await fs.appendFile(
        path.join(directory, 'README.md'),
        'Preserve work when generation fails.\n'
      );
      expect(
        await runAutoCommit({
          workspacePath: directory,
          kiloClient: harness,
          env,
          onEvent() {},
          signal: AbortSignal.timeout(45_000),
        })
      ).toEqual({ success: true });
      expect(await command(['log', '-1', '--format=%s'])).toBe('wip');
      expect(requests).toHaveLength(2);
      expect(requests[1]?.model).toBe('commit-model');
      expect(await command(['status', '--porcelain'])).toBe('');
    } finally {
      await runtime.shutdown();
      await fake.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
