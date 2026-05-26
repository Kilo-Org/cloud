/**
 * Unit tests for the E2E fake LLM server.
 *
 * The server itself lives under `test/e2e/` (alongside the other harness
 * primitives) but tests live under `test/unit/` because the vitest config
 * (`vitest.config.ts`) only globs `src/**` and `test/unit/**` — `test/e2e/`
 * files are driver-invoked, not picked up by `pnpm run test`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  extractLastUserMessageText,
  parseDirective,
  startFakeLlmServer,
  type FakeLlmServerHandle,
} from '../e2e/fake-llm-server.js';

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe('parseDirective', () => {
  it('returns null when the prefix is absent', () => {
    expect(parseDirective('hello')).toBeNull();
    expect(parseDirective('')).toBeNull();
  });

  it('handles a bare scenario with no args', () => {
    expect(parseDirective('__fake__:idle')).toEqual({ scenario: 'idle', args: [] });
    expect(parseDirective('__fake__:hang')).toEqual({ scenario: 'hang', args: [] });
  });

  it('returns prefix-only as empty scenario with no args', () => {
    // After stripping the `__fake__:` prefix, the remainder is empty, so
    // there's no scenario name and no args. Treated identically to an
    // unknown scenario by the HTTP handler (returns 402).
    expect(parseDirective('__fake__:')).toEqual({ scenario: '', args: [] });
  });

  it('preserves empty arg when a colon follows the scenario name', () => {
    // `__fake__:echo:` → scenario 'echo' with a single empty-string arg.
    expect(parseDirective('__fake__:echo:')).toEqual({ scenario: 'echo', args: [''] });
  });

  it('treats everything after the first colon as a single arg blob', () => {
    // Ensures `echo:hello:world` preserves the trailing colon in payload.
    expect(parseDirective('__fake__:echo:hello:world')).toEqual({
      scenario: 'echo',
      args: ['hello:world'],
    });
  });

  it('extracts a single-arg scenario', () => {
    expect(parseDirective('__fake__:error:bad things')).toEqual({
      scenario: 'error',
      args: ['bad things'],
    });
  });

  it('locates the directive anywhere in the text', () => {
    expect(parseDirective('please run __fake__:echo:hi for me')).toEqual({
      scenario: 'echo',
      args: ['hi for me'],
    });
  });
});

describe('extractLastUserMessageText', () => {
  it('returns empty when messages is missing or not an array', () => {
    expect(extractLastUserMessageText({})).toBe('');
    expect(extractLastUserMessageText({ messages: 'nope' })).toBe('');
    expect(extractLastUserMessageText(null)).toBe('');
  });

  it('returns the string content of the last user message', () => {
    const body = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
    };
    expect(extractLastUserMessageText(body)).toBe('hello');
  });

  it('concatenates text parts of an array-of-parts content', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'foo ' },
            { type: 'text', text: 'bar' },
          ],
        },
      ],
    };
    expect(extractLastUserMessageText(body)).toBe('foo bar');
  });

  it('skips non-user messages at the end', () => {
    const body = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    expect(extractLastUserMessageText(body)).toBe('hi');
  });

  it('returns empty when no user message exists', () => {
    expect(extractLastUserMessageText({ messages: [{ role: 'system', content: 'sys' }] })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// End-to-end HTTP tests against an ephemeral server
// ---------------------------------------------------------------------------

let handle: FakeLlmServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

async function start(): Promise<FakeLlmServerHandle> {
  handle = await startFakeLlmServer({ host: '127.0.0.1', port: 0 });
  return handle;
}

type SseChunk = { raw: string; data: string };

async function readAllSse(body: ReadableStream<Uint8Array>): Promise<SseChunk[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const chunks: SseChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = event.split('\n');
      const dataLine = lines.find(l => l.startsWith('data: '));
      if (dataLine) {
        chunks.push({ raw: event, data: dataLine.slice('data: '.length) });
      }
      idx = buffer.indexOf('\n\n');
    }
  }
  return chunks;
}

async function postChat(url: string, prompt: string): Promise<Response> {
  return fetch(`${url}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kilo/fake-deterministic',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  });
}

describe('fake-llm-server HTTP', () => {
  it('serves the models catalogue with a tools-capable entry', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/openrouter/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; supported_parameters?: string[] }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    const fake = body.data.find(m => m.id === 'fake-deterministic');
    expect(fake).toBeDefined();
    expect(fake?.supported_parameters).toContain('tools');
  });

  it('returns HTTP 404 for routes outside the fake gateway contract', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/missing`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not found: GET /missing');
  });

  it('echo scenario emits a content chunk, stop chunk, then [DONE]', async () => {
    const h = await start();
    const res = await postChat(h.url, '__fake__:echo:hello');
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    const chunks = await readAllSse(res.body!);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const last = chunks[chunks.length - 1];
    expect(last.data).toBe('[DONE]');
    const parsed = chunks.slice(0, -1).map(c => JSON.parse(c.data));
    expect(parsed[0].choices[0].delta.content).toBe('hello');
    const finish = parsed[parsed.length - 1];
    expect(finish.choices[0].finish_reason).toBe('stop');
    expect(finish.usage.completion_tokens).toBe(5);
  });

  it('echo strips kilo prompt-wrapping so it does not contaminate session history', async () => {
    const h = await start();
    const res = await postChat(
      h.url,
      '__fake__:echo:hello<environment_details>\nCurrent time: 2026-05-05T10:17:23+00:00\n</environment_details>'
    );
    const chunks = await readAllSse(res.body!);
    const parsed = chunks.slice(0, -1).map(c => JSON.parse(c.data));
    expect(parsed[0].choices[0].delta.content).toBe('hello');
  });

  it('idle scenario emits empty delta, stop, [DONE]', async () => {
    const h = await start();
    const res = await postChat(h.url, '__fake__:idle');
    const chunks = await readAllSse(res.body!);
    expect(chunks[chunks.length - 1].data).toBe('[DONE]');
    const parsed = chunks.slice(0, -1).map(c => JSON.parse(c.data));
    expect(parsed[0].choices[0].delta.content).toBeUndefined();
    expect(parsed[parsed.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('idle accepts kilo prompt-wrapping after the bare scenario name', async () => {
    const h = await start();
    const res = await postChat(
      h.url,
      '__fake__:idle<environment_details>\nCurrent time: 2026-05-05T10:17:23+00:00\n</environment_details>'
    );
    expect(res.status).toBe(200);
    const chunks = await readAllSse(res.body!);
    expect(chunks[chunks.length - 1].data).toBe('[DONE]');
  });

  it('error scenario returns HTTP 402 with OpenAI-shaped error', async () => {
    const h = await start();
    const res = await postChat(h.url, '__fake__:error:too broke');
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { message: string; code: number; type: string } };
    expect(body.error.message).toBe('too broke');
    expect(body.error.code).toBe(402);
    expect(body.error.type).toBe('insufficient_quota');
  });

  it('unknown scenario returns HTTP 402', async () => {
    const h = await start();
    const res = await postChat(h.url, '__fake__:nosuch');
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('unknown fake scenario: nosuch');
  });

  it('missing directive returns HTTP 402', async () => {
    const h = await start();
    const res = await postChat(h.url, 'just some prompt with no directive');
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('missing directive');
  });

  it('invalid JSON body returns HTTP 400', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code: number; type: string };
    };
    expect(body.error).toEqual({
      message: 'invalid JSON body',
      code: 400,
      type: 'invalid_request',
    });
  });

  it('gate without a tag returns HTTP 402', async () => {
    const h = await start();
    const res = await postChat(h.url, '__fake__:gate');
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error: { message: string; code: number; type: string };
    };
    expect(body.error).toEqual({
      message: 'gate directive requires a tag',
      code: 402,
      type: 'invalid_request',
    });
  });

  it('slow:3:5 emits three content chunks', async () => {
    const h = await start();
    const res = await postChat(h.url, '__fake__:slow:3:5');
    const chunks = await readAllSse(res.body!);
    expect(chunks[chunks.length - 1].data).toBe('[DONE]');
    const parsed = chunks.slice(0, -1).map(c => JSON.parse(c.data));
    // 1 role-only opener + 3 content pieces + 1 stop = 5
    const contentChunks = parsed.filter(p => typeof p.choices[0].delta.content === 'string');
    expect(contentChunks.length).toBeGreaterThanOrEqual(3);
  });

  it('gate:<tag> blocks until POST /test/release?tag=<tag>', async () => {
    const h = await start();
    const chatPromise = postChat(h.url, '__fake__:gate:t1').then(async res => {
      expect(res.status).toBe(200);
      return readAllSse(res.body!);
    });

    // Poll briefly for the gate to be registered, then release.
    // The server handles `gate` synchronously on request receipt, so by the
    // time fetch() resolves with a response the gate is registered.
    await new Promise(r => setTimeout(r, 50));

    const releaseRes = await fetch(`${h.url}/test/release?tag=t1`, { method: 'POST' });
    expect(releaseRes.status).toBe(204);

    const chunks = await chatPromise;
    expect(chunks[chunks.length - 1].data).toBe('[DONE]');
    const parsed = chunks.slice(0, -1).map(c => JSON.parse(c.data));
    const contentPieces = parsed
      .map(p => p.choices[0].delta.content)
      .filter((c): c is string => typeof c === 'string');
    expect(contentPieces.join('')).toBe('done');
  });

  it('gate normalizes contaminated tags so concurrent kilo calls share one waiter', async () => {
    const h = await start();
    // Real kilo primary-code calls arrive with `<environment_details>` tacked
    // onto the user message. The title-model call arrives without it. Both
    // must park on the same normalized tag so a single /test/release frees
    // them both.
    const bareAc = new AbortController();
    const contaminatedAc = new AbortController();
    const bareChatP = fetch(`${h.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [{ role: 'user', content: '__fake__:gate:shared' }],
        stream: true,
      }),
      signal: bareAc.signal,
    });
    const contaminatedChatP = fetch(`${h.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [
          {
            role: 'user',
            content:
              '__fake__:gate:shared<environment_details>\nCurrent time: 2026-05-05T10:17:23+00:00\n</environment_details>',
          },
        ],
        stream: true,
      }),
      signal: contaminatedAc.signal,
    });

    // Wait for both waiters to register under the same tag.
    let waiterCount = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 25));
      const snap = await fetch(`${h.url}/test/waiters`);
      const body = (await snap.json()) as { tags: Array<{ tag: string; count: number }> };
      const entry = body.tags.find(t => t.tag === 'shared');
      waiterCount = entry?.count ?? 0;
      if (waiterCount === 2) break;
    }
    expect(waiterCount).toBe(2);

    // One release drains both.
    const releaseRes = await fetch(`${h.url}/test/release?tag=shared`, { method: 'POST' });
    expect(releaseRes.status).toBe(204);

    const drain = async (p: Promise<Response>): Promise<void> => {
      const res = await p;
      const reader = res.body!.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    };
    await Promise.all([drain(bareChatP), drain(contaminatedChatP)]);

    const after = (await (await fetch(`${h.url}/test/waiters`)).json()) as {
      tags: Array<{ tag: string; count: number }>;
    };
    expect(after.tags.find(t => t.tag === 'shared')).toBeUndefined();
    bareAc.abort();
    contaminatedAc.abort();
  });

  it('lets one sequential contaminated gate call drain after the tag is released', async () => {
    const h = await start();
    const firstGate = postChat(h.url, '__fake__:gate:sequential').then(async res => {
      expect(res.status).toBe(200);
      return readAllSse(res.body!);
    });

    await new Promise(r => setTimeout(r, 50));
    const releaseRes = await fetch(`${h.url}/test/release?tag=sequential`, { method: 'POST' });
    expect(releaseRes.status).toBe(204);
    await firstGate;

    const lateRes = await postChat(
      h.url,
      '__fake__:gate:sequential<environment_details>\nCurrent time: 2026-05-05T10:17:23+00:00\n</environment_details>'
    );
    const lateChunks = await Promise.race([
      readAllSse(lateRes.body!),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('late sequential gate did not finish')), 250);
      }),
    ]);

    expect(lateChunks[lateChunks.length - 1].data).toBe('[DONE]');
    const after = (await (await fetch(`${h.url}/test/waiters`)).json()) as {
      tags: Array<{ tag: string; count: number }>;
    };
    expect(after.tags.find(t => t.tag === 'sequential')).toBeUndefined();
  });

  it('POST /test/release without a tag returns 400', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/test/release`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('tag query param required');
  });

  it('POST /test/release with unknown tag returns 404', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/test/release?tag=nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('GET /test/gate-status reports engaged flag', async () => {
    const h = await start();

    // Before any gate request: not engaged.
    const beforeRes = await fetch(`${h.url}/test/gate-status?tag=status1`);
    expect(beforeRes.status).toBe(200);
    const beforeBody = (await beforeRes.json()) as { tag: string; engaged: boolean };
    expect(beforeBody).toEqual({ tag: 'status1', engaged: false });

    // Open a gate request; it will block until released or the server closes.
    const chatPromise = postChat(h.url, '__fake__:gate:status1').then(async res => {
      expect(res.status).toBe(200);
      return readAllSse(res.body!);
    });

    // Poll the status endpoint until the gate is registered.
    let engaged = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 25));
      const statusRes = await fetch(`${h.url}/test/gate-status?tag=status1`);
      const statusBody = (await statusRes.json()) as { engaged: boolean };
      if (statusBody.engaged) {
        engaged = true;
        break;
      }
    }
    expect(engaged).toBe(true);

    // Release it and confirm the status flips back.
    const releaseRes = await fetch(`${h.url}/test/release?tag=status1`, { method: 'POST' });
    expect(releaseRes.status).toBe(204);

    await chatPromise;

    const afterRes = await fetch(`${h.url}/test/gate-status?tag=status1`);
    const afterBody = (await afterRes.json()) as { engaged: boolean };
    expect(afterBody.engaged).toBe(false);
  });

  it('GET /test/gate-status without tag returns 400', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/test/gate-status`);
    expect(res.status).toBe(400);
  });

  it('hang scenario produces no chunks within a short window', async () => {
    const h = await start();
    const ac = new AbortController();
    const res = await fetch(`${h.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [{ role: 'user', content: '__fake__:hang' }],
        stream: true,
      }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const raceResult = await Promise.race([
      reader.read(),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 100)),
    ]);
    expect(raceResult).toBe('timeout');
    ac.abort();
    // Swallow the cancellation noise.
    await reader.cancel().catch(() => undefined);
  });

  it('GET /test/waiters reports parked gate waiters per tag', async () => {
    const h = await start();

    // No activity: empty snapshot.
    const before = await fetch(`${h.url}/test/waiters`);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      tags: Array<{ tag: string; count: number }>;
      liveResponses: number;
    };
    expect(beforeBody.tags).toEqual([]);
    expect(beforeBody.liveResponses).toBe(0);

    // Park one waiter.
    const ac = new AbortController();
    const gatePromise = fetch(`${h.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [{ role: 'user', content: '__fake__:gate:waiters-test' }],
        stream: true,
      }),
      signal: ac.signal,
    });

    // Wait until the gate is registered.
    let engaged = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 25));
      const snap = await fetch(`${h.url}/test/waiters`);
      const body = (await snap.json()) as { tags: Array<{ tag: string; count: number }> };
      const entry = body.tags.find(t => t.tag === 'waiters-test');
      if (entry && entry.count === 1) {
        engaged = true;
        break;
      }
    }
    expect(engaged).toBe(true);

    // Release and confirm snapshot drains.
    await fetch(`${h.url}/test/release?tag=waiters-test`, { method: 'POST' });
    await gatePromise.then(r => r.body?.cancel()).catch(() => undefined);

    const after = await fetch(`${h.url}/test/waiters`);
    const afterBody = (await after.json()) as {
      tags: Array<{ tag: string; count: number }>;
    };
    expect(afterBody.tags.find(t => t.tag === 'waiters-test')).toBeUndefined();
  });

  it('close() tears down gate connections cleanly', async () => {
    const h = await start();
    const ac = new AbortController();
    const gatePromise = fetch(`${h.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [{ role: 'user', content: '__fake__:gate:cleanup' }],
        stream: true,
      }),
      signal: ac.signal,
    }).then(async res => {
      const reader = res.body!.getReader();
      // Drain until stream ends.
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // Expected: server-side destroy propagates here.
      }
    });

    await new Promise(r => setTimeout(r, 50));
    await h.close();
    handle = null;
    await gatePromise.catch(() => undefined);
    ac.abort();
  });

  it('close() tears down hang connections cleanly', async () => {
    const h = await start();
    const ac = new AbortController();
    const hangPromise = fetch(`${h.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [{ role: 'user', content: '__fake__:hang' }],
        stream: true,
      }),
      signal: ac.signal,
    }).then(async res => {
      const reader = res.body!.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // Expected: server-side destroy propagates here.
      }
    });

    let parked = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 25));
      const snap = await fetch(`${h.url}/test/waiters`);
      const body = (await snap.json()) as { liveResponses: number };
      if (body.liveResponses === 1) {
        parked = true;
        break;
      }
    }
    expect(parked).toBe(true);

    await h.close();
    handle = null;
    await hangPromise.catch(() => undefined);
    ac.abort();
  });
});
