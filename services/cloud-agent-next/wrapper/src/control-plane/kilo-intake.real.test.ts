import { describe, expect, it } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk/v2/client';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;

suite('pinned Kilo 7.8.1 ordered admission prerequisite', () => {
  it('allows a later prompt to overtake command preprocessing, so concurrent HTTP is not ordered admission', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    const version = Bun.spawnSync([binary, '--version']);
    expect(version.stdout.toString().trim()).toBe('7.8.1');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilo-intake-781-'));
    const preprocessing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let modelRequested = Promise.withResolvers<void>();
    let finishModel = Promise.withResolvers<void>();
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/preprocess') {
          preprocessing.resolve();
          await release.promise;
          return new Response('command A');
        }
        if (url.pathname.endsWith('/chat/completions')) {
          modelRequested.resolve();
          await finishModel.promise;
          return new Response(
            'data: {"id":"fake","object":"chat.completion.chunk","created":1,"model":"fake-deterministic","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\ndata: {"id":"fake","object":"chat.completion.chunk","created":1,"model":"fake-deterministic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
          );
        }
        return Response.json({ data: [] });
      },
    });
    const config = {
      model: 'contract/fake-deterministic',
      small_model: 'contract/fake-deterministic',
      share: 'disabled',
      agent: { title: { disable: true } },
      provider: {
        contract: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Contract Fake',
          options: { baseURL: `${fake.url}v1`, apiKey: 'local-test' },
          models: {
            'fake-deterministic': { name: 'Fake', limit: { context: 128000, output: 4096 } },
          },
        },
      },
      command: { held: { template: `!\`curl -s ${fake.url}preprocess\`` } },
    };
    const proc = Bun.spawn([binary, 'serve', '--hostname=127.0.0.1', '--port=0'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_STATE_HOME: path.join(root, 'state'),
        KILO_CONFIG_CONTENT: JSON.stringify(config),
      },
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const timeout = AbortSignal.timeout(30_000);
    const expired = new Promise<never>((_, reject) => {
      timeout.addEventListener(
        'abort',
        () => reject(new Error('Pinned Kilo intake test timed out')),
        { once: true }
      );
    });
    try {
      const reader = proc.stdout.getReader();
      let output = '';
      let url: string | undefined;
      while (!url) {
        const next = await Promise.race([reader.read(), expired]);
        if (next.done) throw new Error('Pinned Kilo exited before listening');
        output += new TextDecoder().decode(next.value);
        url = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      }
      const client = createKiloClient({ baseUrl: url, directory: root });
      expect((await client.global.health({ signal: timeout })).data?.version).toBe('7.8.1');
      const created = await client.session.create(
        { title: 'Ordered admission discriminator', directory: root },
        { signal: timeout }
      );
      const sessionID = created.data?.id;
      if (!sessionID) throw new Error('Pinned Kilo did not create a session');
      let commandSettled = false;
      const command = client.session
        .command(
          {
            sessionID,
            directory: root,
            command: 'held',
            arguments: '',
            model: 'contract/fake-deterministic',
          },
          { signal: timeout }
        )
        .finally(() => {
          commandSettled = true;
        });
      await Promise.race([
        preprocessing.promise,
        new Promise((_, reject) =>
          timeout.addEventListener(
            'abort',
            () => reject(new Error('Command never reached preprocessing')),
            { once: true }
          )
        ),
      ]);
      const prompt = await client.session.promptAsync(
        {
          sessionID,
          directory: root,
          noReply: true,
          model: { providerID: 'contract', modelID: 'fake-deterministic' },
          parts: [{ type: 'text', text: 'prompt B' }],
        },
        { signal: timeout }
      );
      expect(prompt.error).toBeUndefined();
      let before = await client.session.messages(
        { sessionID, directory: root },
        { signal: timeout }
      );
      while (!before.data?.some(message => message.info.role === 'user')) {
        timeout.throwIfAborted();
        await Bun.sleep(10);
        before = await client.session.messages({ sessionID, directory: root }, { signal: timeout });
      }
      expect(
        before.data
          ?.filter(message => message.info.role === 'user')
          .flatMap(message =>
            message.parts.filter(part => part.type === 'text').map(part => part.text)
          )
      ).toEqual(['prompt B']);
      expect(commandSettled).toBe(false);
      release.resolve();
      await Promise.race([
        modelRequested.promise,
        new Promise((_, reject) =>
          timeout.addEventListener(
            'abort',
            () => reject(new Error('Command never reached model execution')),
            { once: true }
          )
        ),
      ]);
      expect(commandSettled).toBe(false);
      const after = await client.session.messages(
        { sessionID, directory: root },
        { signal: timeout }
      );
      expect(
        after.data
          ?.filter(message => message.info.role === 'user')
          .flatMap(message =>
            message.parts.filter(part => part.type === 'text').map(part => part.text)
          )
      ).toEqual(['prompt B', 'command A']);
      await client.session.promptAsync(
        {
          sessionID,
          directory: root,
          noReply: true,
          model: { providerID: 'contract', modelID: 'fake-deterministic' },
          parts: [{ type: 'text', text: 'follow-up during command execution' }],
        },
        { signal: timeout }
      );
      let duringCommand = await client.session.messages(
        { sessionID, directory: root },
        { signal: timeout }
      );
      while (
        !duringCommand.data?.some(message =>
          message.parts.some(
            part => part.type === 'text' && part.text === 'follow-up during command execution'
          )
        )
      ) {
        timeout.throwIfAborted();
        await Bun.sleep(10);
        duringCommand = await client.session.messages(
          { sessionID, directory: root },
          { signal: timeout }
        );
      }
      expect(commandSettled).toBe(false);
      finishModel.resolve();
      expect((await command).error).toBeUndefined();
      modelRequested = Promise.withResolvers<void>();
      finishModel = Promise.withResolvers<void>();
      let summarySettled = false;
      const summary = client.session
        .summarize(
          { sessionID, directory: root, providerID: 'contract', modelID: 'fake-deterministic' },
          { signal: timeout }
        )
        .finally(() => {
          summarySettled = true;
        });
      await Promise.race([
        modelRequested.promise,
        new Promise((_, reject) =>
          timeout.addEventListener(
            'abort',
            () => reject(new Error('Summary never reached model execution')),
            { once: true }
          )
        ),
      ]);
      expect(summarySettled).toBe(false);
      await client.session.promptAsync(
        {
          sessionID,
          directory: root,
          noReply: true,
          model: { providerID: 'contract', modelID: 'fake-deterministic' },
          parts: [{ type: 'text', text: 'follow-up during summary execution' }],
        },
        { signal: timeout }
      );
      let duringSummary = await client.session.messages(
        { sessionID, directory: root },
        { signal: timeout }
      );
      while (
        !duringSummary.data?.some(message =>
          message.parts.some(
            part => part.type === 'text' && part.text === 'follow-up during summary execution'
          )
        )
      ) {
        timeout.throwIfAborted();
        await Bun.sleep(10);
        duringSummary = await client.session.messages(
          { sessionID, directory: root },
          { signal: timeout }
        );
      }
      expect(summarySettled).toBe(false);
      finishModel.resolve();
      expect((await summary).data).toBe(true);
    } finally {
      release.resolve();
      finishModel.resolve();
      proc.kill();
      await proc.exited;
      await fake.stop(true);
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
