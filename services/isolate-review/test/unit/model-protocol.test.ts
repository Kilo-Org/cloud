import {
  convertToModelMessages,
  generateText,
  jsonSchema,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGithubTools } from '../../src/github';
import { createKiloGatewayModel, resolveIsolateReviewInferenceFromCatalog } from '../../src/model';
import type { IsolateReviewInference } from '../../src/types';

vi.mock('../../src/prompt', () => ({ DEFAULT_MODEL: 'fixture/unused-default' }));

type Variant = NonNullable<IsolateReviewInference['variant']>;
type Provider = IsolateReviewInference['provider'];
type CatalogFixture = {
  id: string;
  context_length: number;
  top_provider: { max_completion_tokens: number };
  supported_parameters: string[];
  opencode: { ai_sdk_provider: Provider; variants: Record<string, Variant> };
};
type WireBody = {
  model: string;
  stream?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  thinking?: { type: string };
  output_config?: { effort: string };
  reasoning?: { enabled?: boolean; effort?: string; summary?: string };
  reasoning_effort?: string;
  verbosity?: string;
  text?: { verbosity?: string };
  store?: boolean;
  include?: string[];
  tools?: Array<{
    type?: string;
    name?: string;
    strict?: boolean;
    parameters?: { required?: string[] };
    function?: { strict?: boolean };
  }>;
  messages?: Array<Record<string, unknown>>;
  input?: Array<Record<string, unknown>>;
  providerOptions?: unknown;
};

const claudeVariants = {
  none: { reasoning: { enabled: false, effort: 'none' } },
  low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
  medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
  high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'xhigh' },
  max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
} satisfies Record<string, Variant>;
const binaryVariants = {
  instant: { reasoning: { enabled: false, effort: 'none' } },
  thinking: { reasoning: { enabled: true, effort: 'high' } },
} satisfies Record<string, Variant>;

function catalog(
  id: string,
  provider: Provider,
  variants: Record<string, Variant>
): CatalogFixture {
  return {
    id,
    context_length: 1_000_000,
    top_provider: { max_completion_tokens: 128_000 },
    supported_parameters: ['tools', 'reasoning'],
    opencode: { ai_sdk_provider: provider, variants },
  };
}

const catalogFixtures = [
  catalog('anthropic/claude-sonnet-5', 'anthropic', claudeVariants),
  catalog('anthropic/claude-sonnet-4.6', 'anthropic', {
    none: claudeVariants.none,
    low: claudeVariants.low,
    medium: claudeVariants.medium,
    high: claudeVariants.high,
    max: claudeVariants.max,
  }),
  catalog(
    'openai/gpt-5.4-mini',
    'openai',
    Object.fromEntries(
      ['none', 'low', 'medium', 'high', 'xhigh'].map(effort => [
        effort,
        { reasoning: claudeVariants[effort as keyof typeof claudeVariants].reasoning },
      ])
    )
  ),
  {
    ...catalog('qwen/qwen3.7-plus', 'openrouter', binaryVariants),
    supported_parameters: ['tools', 'reasoning', 'temperature', 'top_p'],
  },
  {
    ...catalog('kilo-auto/efficient', 'openrouter', {}),
    supported_parameters: ['tools', 'reasoning', 'temperature', 'top_p'],
  },
  catalog('fixture/compatible-no-live-catalog-claim', 'openai-compatible', {
    ...claudeVariants,
    minimal: { reasoning: { enabled: true, effort: 'minimal' } },
    ...binaryVariants,
  }),
];

const messages: ModelMessage[] = [{ role: 'user', content: 'Inspect the fixture, then finish.' }];
const tools = {
  inspect: tool({
    inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
    execute: async () => 'fixture result',
  }),
};
const reasoningDetails = [
  {
    type: 'reasoning.text',
    text: 'fixture thought',
    signature: 'fixture-signature',
    format: 'anthropic-claude-v1',
    id: 'rd-1',
    index: 0,
  },
  {
    type: 'reasoning.encrypted',
    data: 'fixture-encrypted',
    format: 'anthropic-claude-v1',
    id: 'rd-2',
    index: 1,
  },
];

function eventStream(events: unknown[]) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function messagesReply(model: string, first: boolean, streaming: boolean) {
  const content = first
    ? [
        { type: 'thinking', thinking: 'fixture thought', signature: 'fixture-text-signature' },
        { type: 'thinking', thinking: '', signature: 'fixture-signature' },
        { type: 'redacted_thinking', data: 'fixture-redacted' },
        { type: 'tool_use', id: 'call_fixture', name: 'inspect', input: {} },
      ]
    : [{ type: 'text', text: 'done' }];
  const response = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: first ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!streaming) return Response.json(response);
  const events: unknown[] = [
    { type: 'message_start', message: { ...response, content: [], stop_reason: null } },
  ];
  for (const [index, block] of content.entries()) {
    events.push({
      type: 'content_block_start',
      index,
      content_block:
        block.type === 'text'
          ? { type: 'text', text: '' }
          : block.type === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : block,
    });
    if (block.type === 'thinking') {
      if (block.thinking) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        });
      }
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    }
    if (block.type === 'tool_use')
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      });
    if (block.type === 'text')
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    events.push({ type: 'content_block_stop', index });
  }
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: response.usage,
    },
    { type: 'message_stop' }
  );
  return eventStream(events);
}

function responsesReply(
  model: string,
  first: boolean,
  streaming: boolean,
  functionCall = { name: 'inspect', arguments: '{}' }
) {
  const output = first
    ? [
        {
          type: 'reasoning',
          id: 'rs_fixture',
          encrypted_content: 'fixture-encrypted',
          summary: [],
        },
        {
          type: 'function_call',
          id: 'fc_fixture',
          call_id: 'call_fixture',
          ...functionCall,
          status: 'completed',
        },
      ]
    : [
        {
          type: 'message',
          id: 'msg_fixture',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done', annotations: [] }],
          status: 'completed',
        },
      ];
  const response = {
    id: 'resp_fixture',
    created_at: 1,
    model,
    output,
    status: 'completed',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  if (!streaming) return Response.json(response);
  const events: unknown[] = [
    {
      type: 'response.created',
      response: { id: response.id, created_at: response.created_at, model },
    },
  ];
  for (const [index, item] of output.entries()) {
    events.push({ type: 'response.output_item.added', output_index: index, item });
    if (item.type === 'function_call') {
      events.push({
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: index,
        delta: functionCall.arguments,
      });
    }
    if (item.type === 'message') {
      events.push({
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: 'done',
      });
    }
    events.push({ type: 'response.output_item.done', output_index: index, item });
  }
  events.push({ type: 'response.completed', response });
  return eventStream(events);
}

function chatReply(
  model: string,
  first: boolean,
  streaming: boolean,
  compatible: boolean,
  emptyDetails: boolean
) {
  const reasoning = first
    ? compatible
      ? { reasoning_content: 'fixture thought', reasoning_details: reasoningDetails }
      : { reasoning_details: emptyDetails ? [] : reasoningDetails }
    : {};
  const base = { id: 'chat_fixture', model, created: 1 };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!streaming)
    return Response.json({
      ...base,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: first ? null : 'done',
            ...reasoning,
            ...(first
              ? {
                  tool_calls: [
                    {
                      id: 'call_fixture',
                      type: 'function',
                      function: { name: 'inspect', arguments: '{}' },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: first ? 'tool_calls' : 'stop',
        },
      ],
      usage,
    });
  return eventStream([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', ...(first ? reasoning : { content: 'done' }) },
          finish_reason: null,
        },
      ],
    },
    ...(first
      ? [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_fixture',
                      type: 'function',
                      function: { name: 'inspect', arguments: '{' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
                finish_reason: null,
              },
            ],
          },
        ]
      : []),
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
      usage,
    },
  ]);
}

function createFixture(inference: IsolateReviewInference, emptyDetails = false) {
  const requests: Array<{ url: string; headers: Headers; body: WireBody }> = [];
  const requestIds: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url.startsWith('https://offline.invalid/api/openrouter/')).toBe(true);
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON body');
    const body = JSON.parse(init.body) as WireBody;
    const headers = new Headers(init.headers);
    expect(requestIds).toContain(headers.get('x-kilo-request'));
    requests.push({ url, headers, body });
    const first = requests.length === 1;
    if (inference.provider === 'anthropic')
      return messagesReply(inference.modelId, first, body.stream === true);
    if (inference.provider === 'openai')
      return responsesReply(inference.modelId, first, body.stream === true);
    return chatReply(
      inference.modelId,
      first,
      body.stream === true,
      inference.provider === 'openai-compatible',
      emptyDetails
    );
  };
  const model = createKiloGatewayModel({
    runId: 'root',
    kiloToken: 'fixture-token',
    organizationId: 'fixture-org',
    inference,
    gatewayUrl: 'https://offline.invalid/api/openrouter',
    fetchImpl,
    onRequestId: async id => {
      requestIds.push(id);
    },
  });
  return { model, requests, requestIds };
}

function expectWireOptions(inference: IsolateReviewInference, body: WireBody) {
  expect(body.model).toBe(inference.modelId);
  expect(body.providerOptions).toBeUndefined();
  expect(body.temperature).toBe(inference.temperature);
  expect(body.top_p).toBe(inference.topP);
  for (const tool of body.tools ?? []) {
    expect(tool.strict).toBe(inference.provider === 'openai' ? false : undefined);
    expect(tool.function?.strict).toBeUndefined();
  }
  const reasoning = inference.variant?.reasoning;
  const verbosity = inference.variant?.verbosity;
  if (inference.provider === 'anthropic') {
    expect(body.max_tokens).toBe(32_000);
    expect(body.thinking).toEqual(
      reasoning?.enabled === undefined
        ? undefined
        : { type: reasoning.enabled ? 'adaptive' : 'disabled' }
    );
    expect(body.output_config).toEqual(verbosity ? { effort: verbosity } : undefined);
  } else if (inference.provider === 'openai') {
    expect(body.max_output_tokens).toBe(32_000);
    expect(body.store).toBe(false);
    expect(body.include).toContain('reasoning.encrypted_content');
    expect(body.reasoning?.effort).toBe(reasoning?.effort);
    expect(body.reasoning?.summary).toBe(
      reasoning?.effort && reasoning.effort !== 'none' ? 'auto' : undefined
    );
    expect(body.text?.verbosity).toBe(verbosity);
  } else {
    expect(body.max_tokens).toBe(32_000);
    expect(body.verbosity).toBe(verbosity);
    if (inference.provider === 'openrouter') expect(body.reasoning).toEqual(reasoning);
    else expect(body.reasoning_effort).toBe(reasoning?.effort);
  }
}

function expectContinuation(provider: Provider, body: WireBody, emptyDetails = false) {
  if (provider === 'openai') {
    expect(body.input).toContainEqual({
      type: 'reasoning',
      encrypted_content: 'fixture-encrypted',
      summary: [],
    });
    expect(body.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_fixture',
      name: 'inspect',
      arguments: '{}',
    });
    expect(body.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_fixture',
      output: 'fixture result',
    });
    for (const item of body.input ?? []) {
      expect(item.id).toBeUndefined();
      expect(item.type).not.toBe('item_reference');
    }
    return;
  }
  const assistant = body.messages?.find(message => message.role === 'assistant');
  if (provider === 'anthropic') {
    expect(assistant?.content).toEqual([
      { type: 'thinking', thinking: 'fixture thought', signature: 'fixture-text-signature' },
      { type: 'thinking', thinking: '', signature: 'fixture-signature' },
      { type: 'redacted_thinking', data: 'fixture-redacted' },
      { type: 'tool_use', id: 'call_fixture', name: 'inspect', input: {} },
    ]);
    expect(body.messages?.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'fixture result' }],
    });
  } else {
    expect(assistant?.tool_calls).toEqual([
      { id: 'call_fixture', type: 'function', function: { name: 'inspect', arguments: '{}' } },
    ]);
    expect(body.messages?.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_fixture',
      content: 'fixture result',
    });
    if (provider === 'openrouter')
      expect(assistant?.reasoning_details).toEqual(emptyDetails ? [] : reasoningDetails);
    else {
      expect(assistant?.reasoning_content).toBe('fixture thought');
      expect(assistant?.reasoning_details).toBeUndefined();
    }
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network disabled in protocol fixtures');
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const cases = catalogFixtures.flatMap(model =>
  [null, ...Object.keys(model.opencode.variants)].flatMap(key =>
    [false, true].map(streaming => ({
      label: `${model.id}/${key ?? 'default'}/${streaming ? 'stream' : 'generate'}`,
      model,
      key,
      streaming,
    }))
  )
);

describe('installed SDK protocol fixtures without live model claims', () => {
  it.each(
    [
      { toolName: 'pr_view', input: {} },
      { toolName: 'pr_view', input: { offset: 0, bodyHash: '' } },
      { toolName: 'pr_file', input: { path: 'src/index.ts', revision: 'head' } },
      { toolName: 'pr_file', input: { path: 'src/index.ts', revision: 'merge-base' } },
    ].flatMap(call => [false, true].map(streaming => ({ ...call, streaming })))
  )(
    'Responses $toolName with $input round-trips initial retrieval arguments (stream=$streaming)',
    async ({ toolName, input, streaming }) => {
      const snapshot = {
        headSha: 'a'.repeat(40),
        baseTipSha: 'b'.repeat(40),
        mergeBaseSha: 'c'.repeat(40),
      };
      const githubFetch: typeof fetch = async (request, init) => {
        const url = new URL(request instanceof Request ? request.url : request.toString());
        expect(url.origin).toBe('https://github.offline.invalid');
        expect(init?.method ?? 'GET').toBe('GET');
        if (url.pathname === '/repos/acme/widget/pulls/42')
          return Response.json({
            head: { sha: snapshot.headSha },
            base: { sha: snapshot.baseTipSha },
            body: 'fixture description',
            changed_files: 1,
          });
        if (
          url.pathname === `/repos/acme/widget/compare/${snapshot.baseTipSha}...${snapshot.headSha}`
        )
          return Response.json({
            base_commit: { sha: snapshot.baseTipSha },
            merge_base_commit: { sha: snapshot.mergeBaseSha },
            files: [
              {
                sha: 'd'.repeat(40),
                filename: 'src/index.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                changes: 2,
                patch: '@@ -1 +1 @@\n-old\n+fixture file',
              },
            ],
          });
        if (url.pathname === '/repos/acme/widget/contents/src/index.ts') {
          expect(url.searchParams.get('ref')).toBe(
            input.revision === 'head' ? snapshot.headSha : snapshot.mergeBaseSha
          );
          return Response.json({
            type: 'file',
            path: 'src/index.ts',
            size: 'fixture file'.length,
            encoding: 'base64',
            content: btoa('fixture file'),
            sha: 'd'.repeat(40),
          });
        }
        throw new Error(`Unexpected fixture request: ${url.pathname}`);
      };
      const githubTools = createGithubTools({
        input: {
          owner: 'acme',
          repo: 'widget',
          pullNumber: 42,
          gitToken: 'fixture-git-token',
          kiloToken: 'fixture-kilo-token',
        },
        ...snapshot,
        tools: ['pr_view', 'pr_file'],
        apiUrl: 'https://github.offline.invalid',
        fetchImpl: githubFetch,
      });
      const inference = resolveIsolateReviewInferenceFromCatalog(catalogFixtures[2], 'high');
      const requests: WireBody[] = [];
      const functionCall = { name: toolName, arguments: JSON.stringify(input) };
      const fetchImpl: typeof fetch = async (request, init) => {
        expect(request).toBe('https://offline.invalid/api/openrouter/responses');
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON body');
        const body = JSON.parse(init.body) as WireBody;
        requests.push(body);
        return responsesReply(
          inference.modelId,
          requests.length === 1,
          body.stream === true,
          functionCall
        );
      };
      const options = {
        model: createKiloGatewayModel({
          runId: 'root',
          kiloToken: 'fixture-token',
          inference,
          gatewayUrl: 'https://offline.invalid/api/openrouter',
          fetchImpl,
        }),
        messages,
        tools: githubTools,
        stopWhen: stepCountIs(2),
        maxRetries: 0,
      };
      const result = streaming ? streamText(options) : await generateText(options);
      expect(await result.text).toBe('done');
      const steps = await result.steps;
      expect(steps).toHaveLength(2);
      expect(steps[0].toolResults).toHaveLength(1);
      expect(steps[0].toolResults[0]).toMatchObject({ toolName, input });
      const output = steps[0].toolResults[0].output;
      expect(output).toMatchObject(
        toolName === 'pr_view'
          ? { body: 'fixture description', bodyHash: expect.any(String) }
          : { body: 'fixture file', found: true }
      );
      expect(requests).toHaveLength(2);
      for (const body of requests) {
        expectWireOptions(inference, body);
        expect(body.tools).toHaveLength(2);
        const view = body.tools?.find(tool => tool.name === 'pr_view');
        expect(view).toMatchObject({
          type: 'function',
          strict: false,
          parameters: {
            properties: { offset: { type: 'number' }, bodyHash: { type: 'string' } },
          },
        });
        expect(view?.parameters?.required ?? []).toEqual([]);
        const file = body.tools?.find(tool => tool.name === 'pr_file');
        expect(file).toMatchObject({
          type: 'function',
          strict: false,
          parameters: {
            properties: { commitSha: { type: 'string' }, offset: { type: 'number' } },
            required: ['path', 'revision'],
          },
        });
      }
      expect(requests[1].input).toContainEqual({
        type: 'function_call',
        call_id: 'call_fixture',
        ...functionCall,
      });
      expect(requests[1].input).toContainEqual({
        type: 'function_call_output',
        call_id: 'call_fixture',
        output: JSON.stringify(output),
      });
    }
  );

  it('preserves explicitly configured Responses function-tool strictness', async () => {
    const fixture = createFixture(resolveIsolateReviewInferenceFromCatalog(catalogFixtures[2]));
    await generateText({
      model: fixture.model,
      messages,
      tools: { inspect: { ...tools.inspect, strict: true } },
      maxRetries: 0,
    });
    expect(fixture.requests[0].body.tools).toContainEqual(
      expect.objectContaining({ type: 'function', name: 'inspect', strict: true })
    );
  });

  it.each(cases)(
    '$label preserves wire settings and tool-result continuation',
    async ({ model, key, streaming }) => {
      const inference = resolveIsolateReviewInferenceFromCatalog(model, key);
      if (model.id === 'qwen/qwen3.7-plus') {
        expect(inference).toMatchObject({ temperature: 0.55, topP: 1 });
      }
      const fixture = createFixture(inference);
      const options = {
        model: fixture.model,
        messages,
        tools,
        stopWhen: stepCountIs(2),
        maxRetries: 0,
      };
      const result = streaming ? streamText(options) : await generateText(options);
      expect(await result.text).toBe('done');
      const steps = await result.steps;
      expect(steps).toHaveLength(2);
      expect(fixture.requests).toHaveLength(2);
      const endpoint =
        inference.provider === 'anthropic'
          ? 'messages'
          : inference.provider === 'openai'
            ? 'responses'
            : 'chat/completions';
      for (const { url, body, headers } of fixture.requests) {
        expect(url).toBe(`https://offline.invalid/api/openrouter/${endpoint}`);
        expect(body.stream === true).toBe(streaming);
        expectWireOptions(inference, body);
        expect(headers.get('x-kilocode-mode')).toBe('code');
        expect(headers.get('x-kilocode-taskid')).toBe('root');
        expect(headers.get('x-kilo-session')).toBe('root');
        expect(headers.has('x-kilocode-parent-taskid')).toBe(false);
        expect(headers.get('x-kilocode-feature')).toBe('code-review');
        expect(headers.get('x-kilocode-organizationid')).toBe('fixture-org');
        expect(headers.get('authorization')).toBe('Bearer fixture-token');
        expect(headers.get('user-agent')).toBe('kilo-isolate-review');
        if (inference.provider === 'anthropic') {
          expect(headers.get('anthropic-version')).toBe('2023-06-01');
          expect(headers.has('x-api-key')).toBe(false);
        }
      }
      expectContinuation(inference.provider, fixture.requests[1].body);
      const checkpoint = JSON.parse(JSON.stringify(steps[0].response.messages)) as ModelMessage[];
      await generateText({
        ...options,
        messages: [...messages, ...checkpoint],
        stopWhen: stepCountIs(1),
      });
      expectContinuation(inference.provider, fixture.requests[2].body);
      expectWireOptions(inference, fixture.requests[2].body);
      expect(new Set(fixture.requestIds).size).toBe(3);
    }
  );

  it.each(catalogFixtures.filter(model => model.opencode.ai_sdk_provider !== 'openai-compatible'))(
    '$id survives the parent UI-message persistence path',
    async model => {
      const inference = resolveIsolateReviewInferenceFromCatalog(
        model,
        model.opencode.variants.high ? 'high' : model.opencode.variants.thinking ? 'thinking' : null
      );
      const fixture = createFixture(inference);
      const result = streamText({
        model: fixture.model,
        messages,
        tools,
        stopWhen: stepCountIs(1),
        maxRetries: 0,
      });
      let ui: UIMessage | undefined;
      for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() }))
        ui = message;
      expect(ui).toBeDefined();
      if (!ui) throw new Error('Missing UI message');
      const restored = await convertToModelMessages([JSON.parse(JSON.stringify(ui)) as UIMessage], {
        tools,
      });
      await generateText({
        model: fixture.model,
        messages: [...messages, ...restored],
        tools,
        maxRetries: 0,
      });
      expectContinuation(inference.provider, fixture.requests[1].body);
      for (const request of fixture.requests) expectWireOptions(inference, request.body);
    }
  );

  it.each([false, true])(
    'preserves an empty OpenRouter reasoning_details signal (stream=%s)',
    async streaming => {
      const inference = resolveIsolateReviewInferenceFromCatalog(
        catalog('qwen/qwen3.7-plus', 'openrouter', binaryVariants),
        'thinking'
      );
      const fixture = createFixture(inference, true);
      const options = {
        model: fixture.model,
        messages,
        tools,
        stopWhen: stepCountIs(2),
        maxRetries: 0,
      };
      const result = streaming ? streamText(options) : await generateText(options);
      expect(await result.text).toBe('done');
      expectContinuation('openrouter', fixture.requests[1].body, true);
    }
  );

  it.each(['openai', 'openrouter'] as const)(
    'preserves independent verbosity on %s',
    async provider => {
      const model = catalog(
        provider === 'openai' ? 'openai/gpt-5.4-mini' : 'fixture/openrouter-verbosity',
        provider,
        {
          compact: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'low' },
        }
      );
      for (const streaming of [false, true]) {
        const inference = resolveIsolateReviewInferenceFromCatalog(model, 'compact');
        const fixture = createFixture(inference);
        const options = {
          model: fixture.model,
          messages,
          tools,
          stopWhen: stepCountIs(2),
          maxRetries: 0,
        };
        const result = streaming ? streamText(options) : await generateText(options);
        expect(await result.text).toBe('done');
        for (const request of fixture.requests) expectWireOptions(inference, request.body);
      }
    }
  );

  it.each([false, true])(
    'does not duplicate signed OpenRouter details for parallel tool calls (stream=%s)',
    async streaming => {
      const fixture = createFixture(
        resolveIsolateReviewInferenceFromCatalog(catalogFixtures[3], 'thinking')
      );
      const parallelMessages: ModelMessage[] = [
        ...messages,
        {
          role: 'assistant',
          content: ['call_a', 'call_b'].map(toolCallId => ({
            type: 'tool-call',
            toolCallId,
            toolName: 'inspect',
            input: {},
            providerOptions: { openrouter: { reasoning_details: reasoningDetails } },
          })),
        },
        {
          role: 'tool',
          content: ['call_a', 'call_b'].map(toolCallId => ({
            type: 'tool-result',
            toolCallId,
            toolName: 'inspect',
            output: { type: 'text', value: 'result' },
          })),
        },
      ];
      const options = { model: fixture.model, messages: parallelMessages, tools, maxRetries: 0 };
      const result = streaming ? streamText(options) : await generateText(options);
      await result.text;
      const assistant = fixture.requests[0].body.messages?.find(
        message => message.role === 'assistant'
      );
      expect(assistant?.reasoning_details).toEqual(reasoningDetails);
      expect(assistant?.tool_calls).toHaveLength(2);
    }
  );

  it('keeps default and disabled Anthropic distinct instead of reproducing CLI 7.4.20 / anthropic 3.0.82 disabled omission', () => {
    const model = catalogFixtures[0];
    expect(resolveIsolateReviewInferenceFromCatalog(model).variant).toBeNull();
    expect(
      resolveIsolateReviewInferenceFromCatalog(model, 'none').variant?.reasoning?.enabled
    ).toBe(false);
  });

  it('preserves default stateless reasoning for prefixed IDs instead of the CLI 7.4.20 capability miss', async () => {
    const fixture = createFixture(resolveIsolateReviewInferenceFromCatalog(catalogFixtures[2]));
    await generateText({
      model: fixture.model,
      system: 'Fixture review policy',
      messages,
      tools,
      maxRetries: 0,
    });
    expect(fixture.requests[0].body.reasoning).toBeUndefined();
    expect(fixture.requests[0].body.include).toEqual(['reasoning.encrypted_content']);
    expect(fixture.requests[0].body.input?.[0]).toMatchObject({ role: 'developer' });
  });

  it('serializes Responses none instead of reproducing CLI 7.4.20 forceReasoning:false suppression', async () => {
    const fixture = createFixture(
      resolveIsolateReviewInferenceFromCatalog(catalogFixtures[2], 'none')
    );
    await generateText({ model: fixture.model, messages, tools, maxRetries: 0 });
    expect(fixture.requests[0].body.reasoning?.effort).toBe('none');
  });

  it('records compatible reasoning_details loss as a transport limitation, not OpenRouter parity', async () => {
    const inference = resolveIsolateReviewInferenceFromCatalog(catalogFixtures[5], 'high');
    const fixture = createFixture(inference);
    await generateText({
      model: fixture.model,
      messages,
      tools,
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    const assistant = fixture.requests[1].body.messages?.find(
      message => message.role === 'assistant'
    );
    expect(assistant?.reasoning_content).toBe('fixture thought');
    expect(assistant?.reasoning_details).toBeUndefined();
  });
});
