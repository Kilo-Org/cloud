/**
 * Unit tests for the E2E fake LLM server.
 *
 * The server itself lives under `test/e2e/` (alongside the other harness
 * primitives) but tests live under `test/unit/` because the vitest config
 * (`vitest.config.ts`) only globs `src/**` and `test/unit/**` — `test/e2e/`
 * files are driver-invoked, not picked up by `pnpm run test`.
 */

import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamEventSchema } from '../e2e/client.js';
import {
  extractLastUserMessageText,
  parseDirective,
  startFakeLlmServer,
  stripKiloPromptWrapping,
  type FakeLlmServerHandle,
} from '../e2e/fake-llm-server.js';
import {
  findControlPlaneKiloRuntime,
  stopOwnedControlPlaneSandbox,
  type DockerCommandExecutor,
} from '../e2e/sandbox-control.js';

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

describe('stripKiloPromptWrapping', () => {
  it('returns the prompt unchanged when no wrappers are present', () => {
    expect(stripKiloPromptWrapping('hello world')).toBe('hello world');
  });

  it('removes environment_details and trims leftover whitespace', () => {
    expect(
      stripKiloPromptWrapping(
        'hello world\n\n<environment_details>\nCurrent time: 2026-05-05T10:17:23+00:00\n</environment_details>'
      )
    ).toBe('hello world');
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

const advertisedFileTools = [
  {
    type: 'function',
    function: {
      name: 'write',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' }, content: { type: 'string' } },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'question',
      parameters: {
        type: 'object',
        properties: { questions: { type: 'array' } },
        required: ['questions'],
      },
    },
  },
];

async function postToolChat(
  url: string,
  prompt: string,
  history: Array<Record<string, unknown>> = [],
  tools: unknown[] = advertisedFileTools
): Promise<Response> {
  return fetch(`${url}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kilo/fake-deterministic',
      messages: [{ role: 'user', content: prompt }, ...history],
      tools,
      stream: true,
    }),
  });
}

async function parseSse(response: Response): Promise<Array<Record<string, unknown>>> {
  if (!response.body) throw new Error('Expected a streamed response body');
  const chunks = await readAllSse(response.body);
  expect(chunks.at(-1)?.data).toBe('[DONE]');
  return chunks.slice(0, -1).map(chunk => JSON.parse(chunk.data));
}

function extractToolCall(chunks: Array<Record<string, unknown>>): {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} {
  const firstChoice = chunks[0]?.choices;
  const secondChoice = chunks[1]?.choices;
  if (!Array.isArray(firstChoice) || !Array.isArray(secondChoice)) {
    throw new Error('Expected streamed tool-call choices');
  }
  const opening = firstChoice[0]?.delta?.tool_calls?.[0];
  const continuation = secondChoice[0]?.delta?.tool_calls?.[0];
  if (
    typeof opening?.id !== 'string' ||
    typeof opening?.function?.name !== 'string' ||
    typeof continuation?.function?.arguments !== 'string'
  ) {
    throw new Error('Expected streamed tool-call identity and arguments');
  }
  return {
    id: opening.id,
    name: opening.function.name,
    arguments: JSON.parse(continuation.function.arguments),
  };
}

async function postModelValidation(
  url: string,
  modelId: string,
  organizationId?: string
): Promise<Response> {
  const route = organizationId
    ? `/api/organizations/${organizationId}/models/validate`
    : '/api/openrouter/models/validate';
  return fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId }),
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

  it('validates a model without requiring the full catalogue response', async () => {
    const h = await start();

    const personalAvailable = await postModelValidation(h.url, 'fake-deterministic');
    await expect(personalAvailable.json()).resolves.toEqual({ valid: true });

    const personalMissing = await postModelValidation(h.url, 'does-not-exist');
    await expect(personalMissing.json()).resolves.toEqual({
      valid: false,
      reason: 'unavailable',
    });

    const organizationAvailable = await postModelValidation(h.url, 'fake-deterministic', 'org-1');
    await expect(organizationAvailable.json()).resolves.toEqual({ valid: true });
  });

  it('reports chat completion request counts for fail-fast assertions', async () => {
    const h = await start();
    const before = await fetch(`${h.url}/test/requests`);
    await expect(before.json()).resolves.toEqual({ chatCompletions: 0 });

    const response = await postChat(h.url, '__fake__:echo:hello');
    expect(response.status).toBe(200);

    const after = await fetch(`${h.url}/test/requests`);
    await expect(after.json()).resolves.toEqual({ chatCompletions: 1 });
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

  it('missing directive echoes the last user message', async () => {
    const h = await start();
    const res = await postChat(h.url, 'just some prompt with no directive');
    expect(res.status).toBe(200);
    const chunks = await readAllSse(res.body!);
    const parsed = chunks.slice(0, -1).map(c => JSON.parse(c.data));
    expect(parsed[0].choices[0].delta.content).toBe('just some prompt with no directive');
    expect(parsed[parsed.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('missing directive strips kilo environment_details from the echo', async () => {
    const h = await start();
    const res = await postChat(
      h.url,
      'hello world\n<environment_details>\nCurrent time: 2026-05-05T10:17:23+00:00\n</environment_details>'
    );
    expect(res.status).toBe(200);
    const chunks = await readAllSse(res.body!);
    const parsed = chunks.slice(0, -1).map(c => JSON.parse(c.data));
    expect(parsed[0].choices[0].delta.content).toBe('hello world');
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

  it('gate emits an attributable completion marker without changing legacy defaults', async () => {
    const h = await start();
    const response = await postChat(
      h.url,
      '__fake__:gate:attributed:root_a_complete<environment_details>private context</environment_details>'
    );
    expect(response.status).toBe(200);
    const release = await fetch(`${h.url}/test/release?tag=attributed`, { method: 'POST' });
    expect(release.status).toBe(204);
    const chunks = await parseSse(response);
    expect(chunks[0]?.choices).toEqual([
      expect.objectContaining({
        delta: { role: 'assistant', content: 'root_a_complete' },
      }),
    ]);
  });

  it('keeps distinct completion markers isolated while both gates are engaged', async () => {
    const h = await start();
    const [rootA, rootB] = await Promise.all([
      postChat(h.url, '__fake__:gate:root_a:only_root_a'),
      postChat(h.url, '__fake__:gate:root_b:only_root_b'),
    ]);
    const [statusA, statusB] = await Promise.all([
      fetch(`${h.url}/test/gate-status?tag=root_a`),
      fetch(`${h.url}/test/gate-status?tag=root_b`),
    ]);
    await expect(statusA.json()).resolves.toMatchObject({ engaged: true });
    await expect(statusB.json()).resolves.toMatchObject({ engaged: true });

    expect((await fetch(`${h.url}/test/release?tag=root_b`, { method: 'POST' })).status).toBe(204);
    const completedB = await parseSse(rootB);
    expect(completedB[0]?.choices).toEqual([
      expect.objectContaining({ delta: { role: 'assistant', content: 'only_root_b' } }),
    ]);
    const stillGatedA = await fetch(`${h.url}/test/gate-status?tag=root_a`);
    await expect(stillGatedA.json()).resolves.toMatchObject({ engaged: true });

    expect((await fetch(`${h.url}/test/release?tag=root_a`, { method: 'POST' })).status).toBe(204);
    const completedA = await parseSse(rootA);
    expect(completedA[0]?.choices).toEqual([
      expect.objectContaining({ delta: { role: 'assistant', content: 'only_root_a' } }),
    ]);
  });

  it('streams a real write call and gates only after its tool result', async () => {
    const h = await start();
    const prompt = '__fake__:write-then-gate:writer:shared.txt:private-content';
    const initial = await parseSse(await postToolChat(h.url, prompt));
    const call = extractToolCall(initial);
    expect(call).toMatchObject({
      name: 'write',
      arguments: { filePath: 'shared.txt', content: 'private-content' },
    });
    const finishChoices = initial.at(-1)?.choices;
    expect(finishChoices).toEqual([expect.objectContaining({ finish_reason: 'tool_calls' })]);

    const followup = await postToolChat(h.url, prompt, [
      { role: 'assistant', tool_calls: [{ id: call.id }] },
      { role: 'tool', tool_call_id: call.id, content: 'File written successfully' },
    ]);
    const statusResponse = await fetch(`${h.url}/test/scenario-status?tag=writer`);
    const status = await statusResponse.json();
    expect(status).toEqual({
      tag: 'writer',
      requests: 2,
      toolCalls: { write: 1, read: 0, edit: 0, question: 0 },
      toolResults: { write: 1, read: 0, edit: 0, question: 0 },
      unsupportedToolSchema: false,
    });
    expect(JSON.stringify(status)).not.toContain('private-content');

    const gate = await fetch(`${h.url}/test/gate-status?tag=writer`);
    await expect(gate.json()).resolves.toEqual({ tag: 'writer', engaged: true });
    expect((await fetch(`${h.url}/test/release?tag=writer`, { method: 'POST' })).status).toBe(204);
    const completed = await parseSse(followup);
    expect(completed[0]?.choices).toEqual([
      expect.objectContaining({ delta: { role: 'assistant', content: 'done-writer' } }),
    ]);
  });

  it('derives alternate write arguments from the advertised tool schema', async () => {
    const h = await start();
    const response = await postToolChat(
      h.url,
      '__fake__:write-then-gate:alternate:shared.txt:private-content',
      [],
      [
        {
          type: 'function',
          function: {
            name: 'write_file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' }, contents: { type: 'string' } },
              required: ['path', 'contents'],
            },
          },
        },
      ]
    );
    expect(extractToolCall(await parseSse(response))).toMatchObject({
      name: 'write_file',
      arguments: { path: 'shared.txt', contents: 'private-content' },
    });
  });

  it('reads through one real tool, edits through another, then gates', async () => {
    const h = await start();
    const prompt = '__fake__:read-edit-then-gate:reader:shared.txt:replacement';
    const readCall = extractToolCall(await parseSse(await postToolChat(h.url, prompt)));
    expect(readCall).toMatchObject({ name: 'read', arguments: { filePath: 'shared.txt' } });

    const readHistory = [
      { role: 'assistant', tool_calls: [{ id: readCall.id }] },
      {
        role: 'tool',
        tool_call_id: readCall.id,
        content:
          '<path>/private/shared.txt</path>\n<content>\n1: original-value\n\n(End of file - total 1 lines)\n</content>',
      },
    ];
    const editCall = extractToolCall(
      await parseSse(await postToolChat(h.url, prompt, readHistory))
    );
    expect(editCall).toMatchObject({
      name: 'edit',
      arguments: {
        filePath: 'shared.txt',
        oldString: 'original-value',
        newString: 'replacement',
      },
    });

    const gated = await postToolChat(h.url, prompt, [
      ...readHistory,
      { role: 'assistant', tool_calls: [{ id: editCall.id }] },
      { role: 'tool', tool_call_id: editCall.id, content: 'Edited successfully' },
    ]);
    const status = await fetch(`${h.url}/test/scenario-status?tag=reader`);
    await expect(status.json()).resolves.toMatchObject({
      toolCalls: { write: 0, read: 1, edit: 1, question: 0 },
      toolResults: { write: 0, read: 1, edit: 1, question: 0 },
    });
    expect((await fetch(`${h.url}/test/release?tag=reader`, { method: 'POST' })).status).toBe(204);
    const completed = await parseSse(gated);
    expect(completed[0]?.choices).toEqual([
      expect.objectContaining({ delta: { role: 'assistant', content: 'done-reader' } }),
    ]);
  });

  it('streams a real question and finishes only after its answered tool result', async () => {
    const h = await start();
    const prompt = '__fake__:question:asker:Choose a safe option: now';
    const call = extractToolCall(await parseSse(await postToolChat(h.url, prompt)));
    expect(call).toMatchObject({
      name: 'question',
      arguments: {
        questions: [
          {
            question: 'Choose a safe option: now',
            header: 'E2E',
            options: [{ label: 'Continue', description: 'Continue the E2E scenario' }],
          },
        ],
      },
    });

    const completed = await parseSse(
      await postToolChat(h.url, prompt, [
        { role: 'assistant', tool_calls: [{ id: call.id }] },
        { role: 'tool', tool_call_id: call.id, content: 'Continue' },
      ])
    );
    expect(completed[0]?.choices).toEqual([
      expect.objectContaining({ delta: { role: 'assistant', content: 'done-asker' } }),
    ]);
    const status = await fetch(`${h.url}/test/scenario-status?tag=asker`);
    await expect(status.json()).resolves.toMatchObject({
      toolCalls: { write: 0, read: 0, edit: 0, question: 1 },
      toolResults: { write: 0, read: 0, edit: 0, question: 1 },
      unsupportedToolSchema: false,
    });
  });

  it('finishes title-model requests without advertising or inventing a tool schema', async () => {
    const h = await start();
    const chunks = await parseSse(
      await postChat(h.url, '__fake__:write-then-gate:title:shared.txt:secret')
    );
    expect(chunks[0]?.choices).toEqual([
      expect.objectContaining({ delta: { role: 'assistant', content: 'done-title' } }),
    ]);
    const status = await fetch(`${h.url}/test/scenario-status?tag=title`);
    await expect(status.json()).resolves.toMatchObject({
      toolCalls: { write: 0, read: 0, edit: 0, question: 0 },
      unsupportedToolSchema: false,
    });
  });

  it('reports unsupported advertised tool schemas instead of inventing tool calls', async () => {
    const h = await start();
    const response = await postToolChat(
      h.url,
      '__fake__:write-then-gate:unsupported:shared.txt:secret',
      [],
      [
        {
          type: 'function',
          function: {
            name: 'write',
            parameters: {
              type: 'object',
              properties: { unexpected: { type: 'string' } },
              required: ['unexpected'],
            },
          },
        },
      ]
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'unsupported write tool schema', type: 'unsupported_tool_schema' },
    });
    const status = await fetch(`${h.url}/test/scenario-status?tag=unsupported`);
    await expect(status.json()).resolves.toMatchObject({ unsupportedToolSchema: true });
  });

  it('never logs directive contents, raw request bodies, or authorization headers', async () => {
    const h = await start();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const response = await fetch(`${h.url}/api/openrouter/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-authorization-value',
        },
        body: JSON.stringify({
          model: 'kilo/fake-deterministic',
          messages: [{ role: 'user', content: '__fake__:echo:secret-prompt-value' }],
          stream: true,
        }),
      });
      await parseSse(response);
      const logged = spy.mock.calls.flat().join(' ');
      expect(logged).not.toContain('secret-prompt-value');
      expect(logged).not.toContain('secret-authorization-value');
      expect(logged).not.toContain('messages":');
    } finally {
      spy.mockRestore();
    }
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

type ProcFixture = {
  pid: number;
  port: number;
  inode: string;
  directory: string;
  home: string;
  roots: string[];
  address?: string;
  state?: string;
  fdInode?: string;
  command?: string[];
  executable?: string;
  canonicalDirectory?: string;
  rootOverride?: Record<string, unknown>;
  bootstrapped?: boolean;
};

function discoveryFixture(processes: ProcFixture[], log?: string) {
  const requests: URL[] = [];
  const killed: string[] = [];
  const forbiddenReads: string[] = [];
  let afterFetch: (() => void) | undefined;
  const containers = new Map([
    ['owned', processes],
    ['unrelated', [] as ProcFixture[]],
  ]);
  const execute: DockerCommandExecutor = async args => {
    if (args[0] === 'ps') {
      return {
        stdout: [...containers.keys()]
          .map(id => `${id}\tcloud-agent-next-dev-Sandbox-${id}\timage`)
          .concat('proxy\tcloud-agent-next-dev-Sandbox-owned-proxy\timage')
          .join('\n'),
      };
    }
    if (args[0] === 'kill') {
      killed.push(args[1]);
      return { stdout: '' };
    }
    const entries = containers.get(args[1]);
    if (args[0] !== 'exec' || !entries) throw new Error('Unexpected container operation');
    const fs = {
      readFileSync(filename: string): string {
        if (filename === '/proc/net/tcp' || filename === '/proc/net/tcp6') {
          return (
            'header\n' +
            entries
              .filter(entry => (entry.address?.length ?? 8) > 8 === filename.endsWith('tcp6'))
              .map(
                entry =>
                  `0: ${entry.address ?? '0100007F'}:${entry.port.toString(16)} 00000000:0000 ${entry.state ?? '0A'} 0 0 0 0 0 ${entry.inode}`
              )
              .join('\n')
          );
        }
        const entry = entries.find(item => filename === `/proc/${item.pid}/cmdline`);
        if (entry)
          return (
            (
              entry.command ?? ['/usr/local/bin/kilo', 'serve', '--hostname=127.0.0.1', '--port=0']
            ).join('\0') + '\0'
          );
        const environmentEntry = entries.find(item => filename === `/proc/${item.pid}/environ`);
        if (environmentEntry) return `HOME=${environmentEntry.home}\0PATH=/usr/local/bin\0`;
        if (filename === '/tmp/kilocode-control-wrapper.log' && log !== undefined) return log;
        forbiddenReads.push(filename);
        throw new Error('Unexpected filesystem read');
      },
      readdirSync(directory: string): string[] {
        if (directory === '/proc') return entries.map(entry => String(entry.pid));
        if (directory === '/tmp') return log === undefined ? [] : ['kilocode-control-wrapper.log'];
        if (directory === '/workspace/worktrees')
          return entries.map(entry => path.basename(entry.directory));
        if (entries.some(entry => directory === `/proc/${entry.pid}/fd`)) return ['3', '4'];
        throw new Error('Unexpected directory read');
      },
      readlinkSync(filename: string): string {
        for (const entry of entries) {
          if (filename === `/proc/${entry.pid}/cwd`) return entry.directory;
          if (filename === `/proc/${entry.pid}/exe`)
            return entry.executable ?? '/opt/cli-linux-x64/bin/kilo';
          if (filename === `/proc/${entry.pid}/fd/3` || filename === `/proc/${entry.pid}/fd/4`) {
            return `socket:[${entry.fdInode ?? entry.inode}]`;
          }
        }
        throw new Error('Missing process');
      },
      realpathSync(directory: string): string {
        return (
          entries.find(entry => entry.directory === directory)?.canonicalDirectory ?? directory
        );
      },
      existsSync(filename: string): boolean {
        return entries.some(
          entry =>
            entry.bootstrapped !== false &&
            filename === `${entry.directory}/.kilo-bootstrap-complete`
        );
      },
      statSync: () => ({ isDirectory: () => true }),
    };
    const fetch = async (url: URL) => {
      requests.push(url);
      const entry = entries.find(item => String(item.port) === url.port);
      const rootId = decodeURIComponent(url.pathname.slice('/session/'.length));
      const matched =
        entry &&
        entry.roots.includes(rootId) &&
        url.searchParams.get('directory') === entry.directory;
      const root = matched
        ? { id: rootId, directory: entry.directory, ...entry.rootOverride }
        : null;
      afterFetch?.();
      return { ok: root !== null, json: async () => root };
    };
    let stdout = '';
    await runInNewContext(args[4].replace(/^import .*;\n/gm, ''), {
      fs,
      path: path.posix,
      fetch,
      URL,
      AbortSignal,
      process: {
        argv: ['bun', args[5]],
        stdout: {
          write: (text: string) => {
            stdout += text;
          },
        },
      },
      execFileSync: () => {
        throw new Error('Process execution is forbidden in discovery tests');
      },
    });
    return { stdout };
  };
  return {
    execute,
    requests,
    killed,
    forbiddenReads,
    containers,
    onFetch: (callback: () => void) => {
      afterFetch = callback;
    },
  };
}

function directoryProcesses(): ProcFixture[] {
  return [
    {
      pid: 101,
      port: 41001,
      inode: '501',
      directory: '/workspace/worktrees/worktree-a',
      home: '/tmp/kilo-worktrees/a1b2c3d4',
      roots: ['ses_a', 'ses_sibling'],
    },
    {
      pid: 202,
      port: 41002,
      inode: '502',
      directory: '/workspace/worktrees/worktree-b',
      home: '/tmp/kilo-worktrees/e5f6a7b8',
      roots: ['ses_b'],
      address: '00000000000000000000000001000000',
    },
  ];
}

describe('per-directory Kilo discovery', () => {
  it('discovers exact roots in distinct PID/cwd listeners without any server log', async () => {
    const fixture = discoveryFixture(directoryProcesses());
    const owner = vi.fn();
    const first = await findControlPlaneKiloRuntime('ses_a', fixture.execute, owner);
    const sibling = await findControlPlaneKiloRuntime('ses_sibling', fixture.execute);
    const second = await findControlPlaneKiloRuntime('ses_b', fixture.execute);
    expect(first).toMatchObject({
      container: { id: 'owned' },
      processId: 101,
      directory: '/workspace/worktrees/worktree-a',
      home: '/tmp/kilo-worktrees/a1b2c3d4',
      serverUrl: 'http://127.0.0.1:41001',
    });
    expect(sibling).toMatchObject({
      processId: first?.processId,
      directory: first?.directory,
      home: first?.home,
    });
    expect(second).toMatchObject({
      container: { id: 'owned' },
      processId: 202,
      directory: '/workspace/worktrees/worktree-b',
      home: '/tmp/kilo-worktrees/e5f6a7b8',
      serverUrl: 'http://[::1]:41002',
    });
    expect(first?.logPath).toBeUndefined();
    expect(owner.mock.calls.map(([container]) => container.id)).toEqual(['owned']);
    expect(fixture.requests.every(url => url.searchParams.has('directory'))).toBe(true);
    expect(fixture.forbiddenReads).toEqual([]);
  });

  it('uses an existing exact-root attach log only as optional evidence', async () => {
    const fixture = discoveryFixture(
      directoryProcesses(),
      'snapshot metadata validated status=valid expectedKiloSessionId=ses_a\nsession.attach ready directory=/workspace/worktrees/worktree-a\n'
    );
    expect((await findControlPlaneKiloRuntime('ses_a', fixture.execute))?.logPath).toBe(
      '/tmp/kilocode-control-wrapper.log'
    );
    expect(
      (await findControlPlaneKiloRuntime('ses_sibling', fixture.execute))?.logPath
    ).toBeUndefined();
  });

  it.each([
    { label: 'wrong root ID', rootOverride: { id: 'ses_other' } },
    { label: 'other directory', rootOverride: { directory: '/workspace/worktrees/worktree-b' } },
    {
      label: 'descendant directory',
      rootOverride: { directory: '/workspace/worktrees/worktree-a/nested' },
    },
    { label: 'child session', rootOverride: { parentID: 'ses_parent' } },
    { label: 'noncanonical cwd', canonicalDirectory: '/canonical/worktree-a' },
    { label: 'wrong inode', fdInode: '999' },
    { label: 'non-listening socket', state: '01' },
    { label: 'public listener', address: '00000000' },
    { label: 'other executable', executable: '/usr/bin/node' },
    { label: 'wrong command', command: ['/usr/bin/node', 'serve'] },
    { label: 'not Kilo serve', command: ['/usr/local/bin/kilo', 'run'] },
    { label: 'unprepared directory', bootstrapped: false },
  ])(
    'rejects $label instead of claiming container ownership',
    async ({ label: _label, ...override }) => {
      const entry = { ...directoryProcesses()[0], ...override };
      const fixture = discoveryFixture([entry]);
      const owner = vi.fn();
      expect(await findControlPlaneKiloRuntime('ses_a', fixture.execute, owner)).toBeNull();
      expect(owner).not.toHaveBeenCalled();
      expect(fixture.forbiddenReads).toEqual([]);
    }
  );

  it.each(['cwd', 'pid'])(
    'rejects ownership if the listener %s changes during the root query',
    async field => {
      const entries = directoryProcesses();
      const fixture = discoveryFixture(entries);
      fixture.onFetch(() => {
        if (field === 'cwd') entries[0].directory = '/workspace/worktrees/replacement';
        else entries[0].pid += 1;
      });
      expect(await findControlPlaneKiloRuntime('ses_a', fixture.execute)).toBeNull();
    }
  );

  it('rejects a socket inode held by multiple processes', async () => {
    const entries = directoryProcesses();
    entries[1].fdInode = entries[0].inode;
    const fixture = discoveryFixture(entries);
    expect(await findControlPlaneKiloRuntime('ses_a', fixture.execute)).toBeNull();
    expect(fixture.requests).toEqual([]);
  });

  it('discovers IPv4-mapped loopback sockets in tcp6', async () => {
    const entry = directoryProcesses()[0];
    entry.address = '0000000000000000FFFF00000100007F';
    const fixture = discoveryFixture([entry]);
    expect(await findControlPlaneKiloRuntime('ses_a', fixture.execute)).toMatchObject({
      serverUrl: 'http://127.0.0.1:41001',
      processId: 101,
    });
  });

  it('rejects ambiguous root ownership across listeners and containers', async () => {
    const entries = directoryProcesses();
    entries[1].roots = ['ses_a'];
    const fixture = discoveryFixture(entries);
    const owner = vi.fn();
    await expect(findControlPlaneKiloRuntime('ses_a', fixture.execute, owner)).rejects.toThrow(
      'Ambiguous Kilo root listener ownership'
    );
    const duplicate = discoveryFixture([directoryProcesses()[0]]);
    duplicate.containers.set('unrelated', [directoryProcesses()[0]]);
    await expect(findControlPlaneKiloRuntime('ses_a', duplicate.execute, owner)).rejects.toThrow(
      'Ambiguous Kilo root container ownership'
    );
    expect(owner).not.toHaveBeenCalled();
  });

  it('does not let stale log evidence establish ownership without a root listener', async () => {
    const fixture = discoveryFixture(
      [],
      'kilo server started at http://127.0.0.1:41001\nsnapshot metadata validated status=missing expectedKiloSessionId=ses_a\nsnapshot missing info.id — likely an error response'
    );
    const owner = vi.fn();
    expect(await findControlPlaneKiloRuntime('ses_a', fixture.execute, owner)).toBeNull();
    expect(owner).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual([]);
  });

  it('refuses container cleanup when another worktree shares that container', async () => {
    const fixture = discoveryFixture(directoryProcesses());
    const runtime = await findControlPlaneKiloRuntime('ses_a', fixture.execute);
    if (!runtime) throw new Error('Expected owned runtime');
    await expect(
      stopOwnedControlPlaneSandbox(runtime.container, 'ses_a', fixture.execute)
    ).rejects.toThrow('other worktrees');
    expect(fixture.killed).toEqual([]);
  });

  it('cleans only the proven exclusive container and its proxy', async () => {
    const fixture = discoveryFixture([directoryProcesses()[0]]);
    const runtime = await findControlPlaneKiloRuntime('ses_a', fixture.execute);
    if (!runtime) throw new Error('Expected owned runtime');
    await stopOwnedControlPlaneSandbox(runtime.container, 'ses_a', fixture.execute);
    expect(fixture.killed).toEqual(['owned', 'proxy']);
  });
});

describe('strict harness stream events', () => {
  const event = {
    eventId: 1,
    sessionId: 'workspace_a',
    streamEventType: 'kilocode',
    timestamp: '2026-08-29T00:00:00Z',
    data: { type: 'question.asked', properties: { id: 'question_b', sessionID: 'ses_b' } },
  };

  it('preserves sibling event fields and the inherited executionId default', () => {
    expect(streamEventSchema.parse(event)).toEqual({ ...event, executionId: null });
  });

  it.each([
    { ...event, eventId: '1' },
    { ...event, sessionId: undefined },
    { ...event, timestamp: undefined },
    { ...event, executionId: 1 },
    { ...event, data: [] },
  ])('rejects malformed stream envelopes', invalid => {
    expect(streamEventSchema.safeParse(invalid).success).toBe(false);
  });
});
