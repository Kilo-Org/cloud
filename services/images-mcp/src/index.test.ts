import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { MAX_REQUEST_BODY_BYTES, MAX_TOOL_INPUT_ELEMENTS } from './mcp-limits';

const SECRET = 'test-secret';

const env = {
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
  R2_ENDPOINT: 'https://r2.test',
  BUCKET_PUBLIC_URLS: JSON.stringify({ 'dst-bucket': 'https://assets.test' }),
  NEXTAUTH_SECRET: { get: async () => SECRET },
} as unknown as Env;

const token = jwt.sign(
  {
    src_bucket: 'src-bucket',
    src_prefix: 'project/uploads/',
    dst_bucket: 'dst-bucket',
    dst_prefix: 'project/public/',
    project_id: 'project-1',
    user_id: 'user-1',
  },
  SECRET,
  { algorithm: 'HS256' }
);

type JsonRpcReply = {
  result?: {
    isError?: boolean;
    content: Array<{ type: string; text?: string; mimeType?: string }>;
  };
  error?: { code: number; message: string };
};

function postMcp(body: string): Request {
  return new Request('https://images-mcp.test/mcp', {
    method: 'POST',
    headers: {
      Host: 'images-mcp.test',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body,
  });
}

function toolCall(args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_image', arguments: args },
  });
}

async function readReply(response: Response): Promise<JsonRpcReply> {
  const text = await response.text();
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice('data: '.length) : text) as JsonRpcReply;
}

describe('images-mcp request limits', () => {
  let r2Fetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    r2Fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves a tool call with a single argument', async () => {
    const response = await worker.fetch(postMcp(toolCall({ sourcePath: 'logo.png' })), env);
    const reply = await readReply(response);

    expect(response.status).toBe(200);
    expect(reply.result?.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(r2Fetch).toHaveBeenCalledTimes(1);
  });

  it('serves a tool call whose arguments are exactly at the element limit', async () => {
    const extra = Array.from({ length: MAX_TOOL_INPUT_ELEMENTS - 2 }, (_, index) => index);
    const response = await worker.fetch(postMcp(toolCall({ sourcePath: 'logo.png', extra })), env);
    const reply = await readReply(response);

    expect(reply.result?.content[0]).toMatchObject({ type: 'image' });
    expect(r2Fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects tool arguments over the element limit before the tool runs', async () => {
    const extra = Array.from({ length: MAX_TOOL_INPUT_ELEMENTS - 1 }, (_, index) => index);
    const response = await worker.fetch(postMcp(toolCall({ sourcePath: 'logo.png', extra })), env);
    const reply = await readReply(response);

    const failure = reply.error?.message ?? reply.result?.content[0]?.text;
    expect(failure).toContain(`maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`);
    expect(r2Fetch).not.toHaveBeenCalled();
  });

  it('answers 413 to a request body over the size limit', async () => {
    const padding = 'x'.repeat(MAX_REQUEST_BODY_BYTES);
    const response = await worker.fetch(postMcp(toolCall({ sourcePath: padding })), env);

    expect(response.status).toBe(413);
    expect(r2Fetch).not.toHaveBeenCalled();
  });
});
