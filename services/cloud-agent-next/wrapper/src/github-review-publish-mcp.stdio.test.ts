import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const TARGET = JSON.stringify({
  repo: 'acme/widgets',
  pullRequestNumber: 42,
  appType: 'standard',
  botUserId: '9001',
});

const LIST_DELAY_MS = 300;

type JsonRpcMessage = { id?: number | string; result?: unknown; error?: unknown };

function startFakeGitHub(): Promise<{ server: Server; port: number; requests: string[] }> {
  const requests: string[] = [];
  let storedBody: string | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    requests.push(`${req.method} ${url}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.includes('/issues/42/comments?')) {
      setTimeout(() => send(200, []), LIST_DELAY_MS);
      return;
    }
    if (req.method === 'POST' && url.endsWith('/issues/42/comments')) {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        storedBody = (JSON.parse(raw) as { body: string }).body;
        send(200, { id: 77, body: storedBody, user: { id: 9001 }, html_url: 'https://x/77' });
      });
      return;
    }
    if (req.method === 'GET' && url.endsWith('/issues/comments/77')) {
      send(200, { id: 77, body: storedBody, user: { id: 9001 }, html_url: 'https://x/77' });
      return;
    }
    send(404, { message: 'not found' });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve({ server, port: address.port, requests });
    });
  });
}

describe('github-review-publish-mcp stdio server', () => {
  let server: Server;
  let port = 0;
  let requests: string[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  const pending = new Map<string | number, (message: JsonRpcMessage) => void>();

  beforeAll(async () => {
    const fake = await startFakeGitHub();
    server = fake.server;
    port = fake.port;
    requests = fake.requests;

    const entry = fileURLToPath(new URL('./github-review-publish-mcp.ts', import.meta.url));
    const outdir = mkdtempSync(join(tmpdir(), 'grpm-'));
    const build = await Bun.build({
      entrypoints: [entry],
      outdir,
      naming: 'github-review-publish-mcp',
      target: 'bun',
      minify: true,
    });
    const outputPath = build.outputs[0]?.path;
    if (!build.success || !outputPath) throw new Error('publication binary build failed');
    const source = readFileSync(outputPath, 'utf8');
    if (!source.startsWith('#!/usr/bin/env bun')) {
      throw new Error('publication binary is missing its shebang');
    }
    chmodSync(outputPath, 0o755);

    child = spawn(outputPath, [], {
      env: {
        ...process.env,
        KILO_GITHUB_REVIEW_TARGET: TARGET,
        GH_TOKEN: 'ghs_test',
        KILO_GITHUB_REVIEW_API_BASE: `http://127.0.0.1:${port}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      const message = JSON.parse(line) as JsonRpcMessage;
      const id = message.id;
      if (id !== undefined) {
        pending.get(id)?.(message);
        pending.delete(id);
      }
    });
  });

  afterAll(() => {
    child?.kill();
    server.close();
  });

  function request(id: number, method: string, params?: unknown): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
      pending.set(id, message => {
        clearTimeout(timer);
        resolve(message);
      });
      child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(method: string, params?: unknown): void {
    child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  test('initializes, lists the tool, and publishes a verified summary from the built executable', async () => {
    const initialized = await request(1, 'initialize', { protocolVersion: '2024-11-05' });
    expect(initialized.result).toMatchObject({ serverInfo: { name: 'code_review' } });
    notify('notifications/initialized');

    const listed = await request(2, 'tools/list');
    expect(listed.result).toMatchObject({
      tools: [{ name: 'publish_review_summary' }],
    });

    const called = await request(3, 'tools/call', {
      name: 'publish_review_summary',
      arguments: { body: '## Code Review Summary\nLooks good.' },
    });
    const result = called.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? '') as {
      verified: boolean;
      commentId: number;
    };
    expect(parsed).toMatchObject({ verified: true, commentId: 77 });
    expect(requests).toContain('POST /repos/acme/widgets/issues/42/comments');
    expect(requests).toContain('GET /repos/acme/widgets/issues/comments/77');
  });

  test('returns an MCP isError result for an invalid tool input', async () => {
    const called = await request(4, 'tools/call', {
      name: 'publish_review_summary',
      arguments: {},
    });
    const result = called.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('rejected_body');
  });

  test('aborts an in-flight call on notifications/cancelled and returns an isError result', async () => {
    const writesBefore = requests.filter(
      entry => entry.startsWith('POST') || entry.startsWith('PATCH')
    ).length;
    const call = request(5, 'tools/call', {
      name: 'publish_review_summary',
      arguments: { body: '## Code Review Summary\nCancelled' },
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    notify('notifications/cancelled', { requestId: 5, reason: 'test' });

    const result = (await call).result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('unverified');
    expect(
      requests.filter(entry => entry.startsWith('POST') || entry.startsWith('PATCH')).length
    ).toBe(writesBefore);
  });

  test('aborts a queued call before it reaches GitHub', async () => {
    const countWrites = () =>
      requests.filter(entry => entry.startsWith('POST') || entry.startsWith('PATCH')).length;
    const writesBefore = countWrites();
    const first = request(6, 'tools/call', {
      name: 'publish_review_summary',
      arguments: { body: '## Code Review Summary\nFirst' },
    });
    const queued = request(7, 'tools/call', {
      name: 'publish_review_summary',
      arguments: { body: '## Code Review Summary\nQueued' },
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    notify('notifications/cancelled', { requestId: 7, reason: 'test' });
    await first;
    const writesAfterFirst = countWrites();
    expect(writesAfterFirst).toBe(writesBefore + 1);

    const result = (await queued).result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('unverified');
    expect(countWrites()).toBe(writesAfterFirst);
  });
});
