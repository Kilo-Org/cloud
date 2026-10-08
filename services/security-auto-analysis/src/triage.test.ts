import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecurityFindingRecord } from './db/queries.js';
import { triageSecurityFinding } from './triage.js';

const finding = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  package_name: 'example-package',
  package_ecosystem: 'npm',
  severity: 'high',
  dependency_scope: 'runtime',
  cve_id: 'CVE-2026-1234',
  ghsa_id: 'GHSA-1234-5678',
  title: 'Example vulnerability',
  description: 'Example description',
  vulnerable_version_range: '<2.0.0',
  patched_version: '2.0.0',
  manifest_path: 'package.json',
  raw_data: null,
} as SecurityFindingRecord;

const triageResult = {
  needsSandboxAnalysis: true,
  needsSandboxReasoning: 'Runtime dependency requires usage analysis.',
  suggestedAction: 'analyze_codebase',
  confidence: 'high',
};

const backendBaseUrl = 'http://localhost:3000';

type RecordedRequest = { url: string; headers: Headers; body: Record<string, unknown> | null };

function stubGateway(options: {
  catalog: Response | (() => Promise<Response>);
  completion: Response;
}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (url.endsWith('/models')) {
        return typeof options.catalog === 'function' ? options.catalog() : options.catalog;
      }
      return options.completion;
    })
  );
  return requests;
}

function catalogWith(model: string, aiSdkProvider?: string) {
  return Response.json({
    data: [
      { id: 'other/model', opencode: { ai_sdk_provider: 'anthropic' } },
      { id: model, ...(aiSdkProvider ? { opencode: { ai_sdk_provider: aiSdkProvider } } : {}) },
    ],
  });
}

function chatCompletion(message: Record<string, unknown>) {
  return Response.json({
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function chatToolCall() {
  return chatCompletion({
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'submit_triage_result', arguments: JSON.stringify(triageResult) },
      },
    ],
  });
}

function triage(model: string) {
  return triageSecurityFinding({
    finding,
    authToken: 'test-token',
    model,
    backendBaseUrl,
    organizationId: 'org-1',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('triageSecurityFinding', () => {
  it('uses the Responses API for models the catalog maps to the openai AI SDK provider', async () => {
    const requests = stubGateway({
      catalog: catalogWith('x-ai/grok-code-fast-1', 'openai'),
      completion: Response.json({
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        model: 'x-ai/grok-code-fast-1',
        status: 'completed',
        incomplete_details: null,
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'submit_triage_result',
            arguments: JSON.stringify(triageResult),
            status: 'completed',
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    });

    const result = await triage('x-ai/grok-code-fast-1');

    expect(requests.map(request => request.url)).toEqual([
      `${backendBaseUrl}/api/openrouter/models`,
      `${backendBaseUrl}/api/openrouter/responses`,
    ]);
    expect(requests[1]?.body).toMatchObject({
      model: 'x-ai/grok-code-fast-1',
      tool_choice: 'auto',
      tools: [expect.objectContaining({ type: 'function', name: 'submit_triage_result' })],
    });
    expect(result).toMatchObject(triageResult);
  });

  it('uses the Messages API for models the catalog maps to the anthropic AI SDK provider', async () => {
    const requests = stubGateway({
      catalog: catalogWith('anthropic/claude-opus-4.6', 'anthropic'),
      completion: Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'anthropic/claude-opus-4.6',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'submit_triage_result', input: triageResult },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const result = await triage('anthropic/claude-opus-4.6');

    expect(requests[1]?.url).toBe(`${backendBaseUrl}/api/openrouter/messages`);
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer test-token');
    expect(requests[1]?.body).toMatchObject({
      model: 'anthropic/claude-opus-4.6',
      tool_choice: { type: 'auto' },
    });
    expect(result).toMatchObject(triageResult);
  });

  it('uses Chat Completions for models without an AI SDK provider in the catalog', async () => {
    const requests = stubGateway({
      catalog: catalogWith('kilo-auto/balanced'),
      completion: chatToolCall(),
    });

    const result = await triage('kilo-auto/balanced');

    expect(requests[1]?.url).toBe(`${backendBaseUrl}/api/openrouter/chat/completions`);
    expect(requests[1]?.body).toMatchObject({
      model: 'kilo-auto/balanced',
      tool_choice: 'auto',
      tools: [
        expect.objectContaining({
          function: expect.objectContaining({ name: 'submit_triage_result' }),
        }),
      ],
    });
    expect(result).toMatchObject(triageResult);
  });

  it.each([undefined, 'openai', 'anthropic', 'openai-compatible'])(
    'sends the triage identity and organization headers for AI SDK provider %s',
    async aiSdkProvider => {
      const requests = stubGateway({
        catalog: catalogWith('test/model', aiSdkProvider),
        completion: Response.json({ error: 'rejected' }, { status: 400 }),
      });

      await triage('test/model');

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.headers.get('user-agent')).toMatch(/^Kilo-Security-Triage\/5\.1\.0/);
        expect(request.headers.get('x-kilocode-version')).toBe('5.1.0');
        expect(request.headers.get('x-kilocode-organizationid')).toBe('org-1');
        expect(request.headers.get('authorization')).toBe('Bearer test-token');
      }
    }
  );

  it('falls back to Chat Completions when the model catalog is unavailable', async () => {
    const requests = stubGateway({
      catalog: Response.json({ error: 'Failed to fetch models' }, { status: 500 }),
      completion: chatToolCall(),
    });

    const result = await triage('x-ai/grok-code-fast-1');

    expect(requests[1]?.url).toBe(`${backendBaseUrl}/api/openrouter/chat/completions`);
    expect(result).toMatchObject(triageResult);
  });

  it('accepts a content-only JSON result when the model does not call the tool', async () => {
    stubGateway({
      catalog: catalogWith('kilo-auto/balanced'),
      completion: chatCompletion({ content: JSON.stringify(triageResult) }),
    });

    const result = await triage('kilo-auto/balanced');

    expect(result).toMatchObject(triageResult);
  });

  it('keeps the conservative fallback for malformed content', async () => {
    stubGateway({
      catalog: catalogWith('kilo-auto/balanced'),
      completion: chatCompletion({ content: 'Result: analyze the codebase.' }),
    });

    const result = await triage('kilo-auto/balanced');

    expect(result).toMatchObject({
      needsSandboxAnalysis: true,
      suggestedAction: 'analyze_codebase',
      confidence: 'low',
    });
  });

  it('keeps the conservative fallback when the gateway rejects the request', async () => {
    stubGateway({
      catalog: catalogWith('x-ai/grok-code-fast-1', 'openai'),
      completion: Response.json(
        { error: 'This model does not support the responses API' },
        { status: 400 }
      ),
    });

    const result = await triage('x-ai/grok-code-fast-1');

    expect(result).toMatchObject({
      needsSandboxAnalysis: true,
      needsSandboxReasoning: 'Triage failed: API error: 400. Defaulting to sandbox analysis.',
      suggestedAction: 'analyze_codebase',
      confidence: 'low',
    });
  });
});
