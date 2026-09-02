import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGithubTools } from '../../src/github';
import {
  createKiloGatewayModel,
  DEFAULT_KILO_GATEWAY_URL as KILO_GATEWAY_URL,
  resolveKiloGatewayUrl,
  resolveIsolateReviewInference,
  resolveIsolateReviewInferenceFromCatalog,
  validateIsolateReviewInference,
  cleanStatelessResponsesBody,
} from '../../src/model';
import type { IsolateReviewInference } from '../../src/types';
import { DEFAULT_MODEL } from '../../src/prompt';

function responseBody() {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('Kilo gateway model', () => {
  it('uses OpenRouter for unconfigured diagnostics without claiming catalog parity', async () => {
    const fetchMock = vi.fn(async () => Response.json(responseBody()));
    const model = createKiloGatewayModel({
      runId: 'review-run',
      kiloToken: 'kilo-token',
      organizationId: 'org-123',
      fetchImpl: fetchMock,
    });

    await generateText({ model, prompt: 'hello' });

    const [request, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(request).toBe(`${KILO_GATEWAY_URL}/chat/completions`);
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer kilo-token');
    expect(headers.get('x-kilocode-feature')).toBe('code-review');
    expect(headers.get('x-kilo-session')).toBe('review-run');
    expect(headers.get('X-KiloCode-OrganizationId')).toBe('org-123');
  });

  it('defaults to production and accepts a local gateway override', async () => {
    expect(resolveKiloGatewayUrl(undefined)).toBe(KILO_GATEWAY_URL);
    expect(resolveKiloGatewayUrl('')).toBe(KILO_GATEWAY_URL);
    expect(resolveKiloGatewayUrl('  ')).toBe(KILO_GATEWAY_URL);

    const fetchMock = vi.fn(async () => Response.json(responseBody()));
    const model = createKiloGatewayModel({
      runId: 'review-run',
      kiloToken: 'kilo-token',
      gatewayUrl: 'http://localhost:3000/api/openrouter',
      fetchImpl: fetchMock,
    });

    await generateText({ model, prompt: 'hello' });

    const [request] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(request).toBe('http://localhost:3000/api/openrouter/chat/completions');
  });

  it('uses the default model and accepts a per-run override', () => {
    expect(createKiloGatewayModel({ runId: 'review-run', kiloToken: 'token' }).modelId).toBe(
      DEFAULT_MODEL
    );
    expect(
      createKiloGatewayModel({ runId: 'review-run', kiloToken: 'token', model: 'openai/gpt-5' })
        .modelId
    ).toBe('openai/gpt-5');
  });

  it('keeps GitHub tool schemas gateway-compatible with bodies only for inline comments and summaries', () => {
    const tools = createGithubTools({
      input: {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'git-token',
        kiloToken: 'kilo-token',
      },
      headSha: 'head-sha',
    });
    const strippedKeywords = [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'minLength',
      'maxLength',
      'maxItems',
      'uniqueItems',
      'contains',
      'minProperties',
      'maxProperties',
      'patternProperties',
      'propertyNames',
      'dependentRequired',
      'unevaluatedProperties',
      'not',
      'if',
      'then',
      'else',
    ];
    const schemas = Object.values(tools).map(({ inputSchema }) =>
      z.toJSONSchema(inputSchema as never)
    );

    for (const keyword of strippedKeywords) {
      expect(JSON.stringify(schemas)).not.toContain(`"${keyword}":`);
    }

    const reviewSchema = z.toJSONSchema(tools.submit_review?.inputSchema as never);
    const summarySchema = z.toJSONSchema(tools.upsert_summary?.inputSchema as never);
    expect(reviewSchema.properties).not.toHaveProperty('body');
    expect(reviewSchema).toHaveProperty('properties.comments.items.properties.body.type', 'string');
    expect(summarySchema).toHaveProperty('properties.body.type', 'string');
  });

  it('accepts omitted GitHub read arguments without making them nullable', () => {
    const tools = createGithubTools({
      input: {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'fixture-git-token',
        kiloToken: 'fixture-kilo-token',
      },
      headSha: 'a'.repeat(40),
      tools: ['pr_view', 'pr_file'],
    });
    const viewSchema = tools.pr_view.inputSchema as z.ZodType;
    const fileSchema = tools.pr_file.inputSchema as z.ZodType;
    const fileInput = { path: 'src/index.ts', revision: 'head' };

    expect(viewSchema.parse({})).toEqual({});
    expect(fileSchema.parse(fileInput)).toEqual(fileInput);
    expect(() => viewSchema.parse({ bodyHash: null })).toThrow();
    expect(() => viewSchema.parse({ offset: null })).toThrow();
    expect(() => fileSchema.parse({ ...fileInput, commitSha: null })).toThrow();
    expect(() => fileSchema.parse({ ...fileInput, offset: null })).toThrow();
    expect(() => fileSchema.parse({ path: fileInput.path })).toThrow();
    expect(() => fileSchema.parse({ revision: fileInput.revision })).toThrow();
  });
});

const catalogModel = {
  id: 'anthropic/claude-sonnet-4.6',
  context_length: 1_000_000,
  top_provider: { max_completion_tokens: 128_000 },
  supported_parameters: ['tools', 'reasoning'],
  opencode: {
    ai_sdk_provider: 'anthropic',
    variants: {
      none: { reasoning: { enabled: false, effort: 'none' } },
      high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
      max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
    },
  },
};

function catalogFetch() {
  return vi.fn<typeof fetch>(async () => Response.json({ data: [catalogModel] }));
}

const resolved = {
  modelId: catalogModel.id,
  provider: 'anthropic',
  thinkingEffort: 'high',
  variant: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
  reasoningSupported: true,
  maxOutputTokens: 32_000,
} satisfies IsolateReviewInference;

function diagnosticModel(options: Partial<Parameters<typeof createKiloGatewayModel>[0]> = {}) {
  return createKiloGatewayModel({ runId: 'root', kiloToken: 'fixture-token', ...options });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON body');
  return JSON.parse(init.body);
}

describe('isolate inference resolution', () => {
  it('distinguishes model default from explicit disabled reasoning and preserves the full variant', () => {
    expect(resolveIsolateReviewInferenceFromCatalog(catalogModel)).toMatchObject({
      modelId: catalogModel.id,
      thinkingEffort: null,
      variant: null,
      maxOutputTokens: 32_000,
    });
    expect(resolveIsolateReviewInferenceFromCatalog(catalogModel, 'none')).toMatchObject({
      thinkingEffort: 'none',
      variant: { reasoning: { enabled: false, effort: 'none' } },
    });
    expect(resolveIsolateReviewInferenceFromCatalog(catalogModel, 'high')).toEqual(resolved);
  });

  it.each([
    ['qwen/qwen3.7-plus', ['tools', 'temperature', 'top_p'], 0.55, 1],
    ['qwen/qwen3.7-plus', ['tools', 'temperature'], 0.55, undefined],
    ['qwen/qwen3.7-plus', ['tools', 'top_p'], undefined, 1],
    ['qwen/qwen3.7-plus', ['tools'], undefined, undefined],
    ['qwen/qwen3.7-plus', undefined, undefined, undefined],
    ['QWEN/Qwen3.7-plus', ['tools', 'temperature', 'top_p'], 0.55, 1],
    ['qwen/north-mini-code', ['tools', 'temperature', 'top_p'], undefined, 1],
    ['anthropic/claude-sonnet-5', ['tools', 'temperature', 'top_p'], undefined, undefined],
    ['kilo-auto/efficient', ['tools', 'temperature', 'top_p'], undefined, undefined],
    ['kilo-auto/org', ['tools', 'temperature', 'top_p'], undefined, undefined],
    ['kilo-auto/qwen', ['tools', 'temperature', 'top_p'], undefined, undefined],
  ] as const)(
    'adopts only advertised Qwen sampling defaults for %s with %j',
    (id, supportedParameters, temperature, topP) => {
      const inference = resolveIsolateReviewInferenceFromCatalog({
        ...catalogModel,
        id,
        supported_parameters: supportedParameters,
        opencode: {},
      });
      expect(inference.temperature).toBe(temperature);
      expect(inference.topP).toBe(topP);
      if (temperature === undefined) expect(inference).not.toHaveProperty('temperature');
      if (topP === undefined) expect(inference).not.toHaveProperty('topP');
    }
  );

  it('leaves unadvertised topP unset rather than copying the unconditional CLI 7.4.20 topP fallback', () => {
    const inference = resolveIsolateReviewInferenceFromCatalog({
      ...catalogModel,
      id: 'qwen/qwen3.7-plus',
      supported_parameters: ['tools', 'temperature'],
      opencode: {},
    });
    expect(inference.temperature).toBe(0.55);
    expect(inference).not.toHaveProperty('topP');
  });

  it('applies frozen Qwen sampling to parent, child, and resumed-child generation', async () => {
    const model = {
      ...catalogModel,
      id: 'qwen/qwen3.7-plus',
      supported_parameters: ['tools', 'temperature', 'top_p'],
      opencode: {},
    };
    const inference = JSON.parse(
      JSON.stringify(resolveIsolateReviewInferenceFromCatalog(model))
    ) as IsolateReviewInference;
    model.supported_parameters = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(requestBody(init));
      return Response.json(responseBody());
    };
    for (const mode of ['code', 'general', 'general'] as const) {
      await generateText({
        model: diagnosticModel({
          inference,
          fetchImpl,
          mode,
          sessionId: mode === 'code' ? 'root' : 'child',
          parentSessionId: mode === 'code' ? undefined : 'root',
        }),
        prompt: 'fixture',
        maxRetries: 0,
      });
    }
    expect(bodies).toHaveLength(3);
    for (const body of bodies)
      expect(body).toMatchObject({ model: model.id, temperature: 0.55, top_p: 1 });
  });

  it('looks up exact advertised keys rather than accepting family-level effort guesses', () => {
    expect(() => resolveIsolateReviewInferenceFromCatalog(catalogModel, 'xhigh')).toThrow(
      'Unknown thinking variant'
    );
    expect(() => resolveIsolateReviewInferenceFromCatalog(catalogModel, 'toString')).toThrow(
      'Unknown thinking variant'
    );
  });

  it.each(['kilo-auto/efficient', 'kilo-auto/frontier', 'kilo-auto/org'])(
    'allows router-owned defaults but rejects explicit effort for %s before fetching',
    async model => {
      const fetchMock = catalogFetch();
      await expect(
        resolveIsolateReviewInference({
          kiloToken: 'fixture',
          model,
          thinkingEffort: 'high',
          fetchImpl: fetchMock,
        })
      ).rejects.toThrow('Auto models');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        resolveIsolateReviewInferenceFromCatalog({ ...catalogModel, id: model }, null).variant
      ).toBeNull();
    }
  );

  it('uses only the authenticated personal catalog without an anonymous fallback', async () => {
    const fetchMock = catalogFetch();
    expect(
      await resolveIsolateReviewInference({ kiloToken: 'fixture', fetchImpl: fetchMock })
    ).toMatchObject({ modelId: catalogModel.id });
    expect(fetchMock).toHaveBeenCalledWith(
      `${KILO_GATEWAY_URL}/models`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fixture' }),
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('uses the organization catalog and organization attribution together', async () => {
    const fetchMock = catalogFetch();
    await resolveIsolateReviewInference({
      kiloToken: 'fixture',
      organizationId: 'org-123',
      model: catalogModel.id,
      thinkingEffort: 'max',
      gatewayUrl: 'http://localhost:3200/api/openrouter',
      fetchImpl: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3200/api/organizations/org-123/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fixture',
          'X-KiloCode-OrganizationId': 'org-123',
        }),
      })
    );
  });

  it.each([401, 403, 302])(
    'fails closed on catalog HTTP %i without exposing its body',
    async status => {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response('private upstream error', { status })
      );
      await expect(
        resolveIsolateReviewInference({ kiloToken: 'fixture', fetchImpl: fetchMock })
      ).rejects.toThrow(`Model catalog request failed (${status})`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('does not include malformed catalog response content in errors', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('private malformed JSON'));
    await expect(
      resolveIsolateReviewInference({ kiloToken: 'fixture', fetchImpl: fetchMock })
    ).rejects.toThrow(/^Invalid model catalog response$/);
  });

  it('rejects missing credentials and unavailable models', async () => {
    const fetchMock = catalogFetch();
    await expect(
      resolveIsolateReviewInference({ kiloToken: '', fetchImpl: fetchMock })
    ).rejects.toThrow('authenticated');
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      resolveIsolateReviewInference({
        kiloToken: 'fixture',
        model: 'private/unavailable',
        fetchImpl: fetchMock,
      })
    ).rejects.toThrow('not available');
  });

  it('bounds catalog bytes while consuming the response', async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
            },
            cancel,
          })
        )
    );
    await expect(
      resolveIsolateReviewInference({ kiloToken: 'fixture', fetchImpl: fetchMock })
    ).rejects.toThrow('response limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('uses smaller output limits and the pinned CLI context-derived fallback', () => {
    expect(
      resolveIsolateReviewInferenceFromCatalog({
        ...catalogModel,
        top_provider: { max_completion_tokens: 8_000 },
      }).maxOutputTokens
    ).toBe(8_000);
    expect(
      resolveIsolateReviewInferenceFromCatalog({
        ...catalogModel,
        top_provider: {},
        context_length: 10_000,
      }).maxOutputTokens
    ).toBe(2_000);
    expect(
      resolveIsolateReviewInferenceFromCatalog({
        ...catalogModel,
        top_provider: {},
        max_completion_tokens: 4_000,
      }).maxOutputTokens
    ).toBe(4_000);
  });

  it('rejects explicit no-tool capability and unknown provider metadata', () => {
    expect(() =>
      resolveIsolateReviewInferenceFromCatalog({
        ...catalogModel,
        supported_parameters: ['reasoning'],
      })
    ).toThrow('review tools');
    expect(() =>
      resolveIsolateReviewInferenceFromCatalog({
        ...catalogModel,
        opencode: { ai_sdk_provider: 'arbitrary' },
      })
    ).toThrow();
  });

  it('preserves the existing identifier bounds', () => {
    expect(
      resolveIsolateReviewInferenceFromCatalog({ ...catalogModel, id: 'm'.repeat(512) }).modelId
    ).toHaveLength(512);
    expect(() =>
      resolveIsolateReviewInferenceFromCatalog({ ...catalogModel, id: 'm'.repeat(513) })
    ).toThrow();
    expect(() => resolveIsolateReviewInferenceFromCatalog(catalogModel, 'a'.repeat(51))).toThrow();
  });
});

describe('prepared inference validation', () => {
  it.each([
    { ...resolved, headers: { authorization: 'not-allowed' } },
    { ...resolved, gatewayUrl: 'https://not-allowed.invalid' },
    { ...resolved, providerOptions: { arbitrary: true } },
    { ...resolved, variant: { ...resolved.variant, extraBody: {} } },
    { ...resolved, variant: { reasoning: { enabled: true, effort: 'high', max_tokens: 1000 } } },
    { ...resolved, maxOutputTokens: 32_001 },
    { ...resolved, temperature: -0.01 },
    { ...resolved, temperature: 2.01 },
    { ...resolved, temperature: NaN },
    { ...resolved, temperature: '0.55' },
    { ...resolved, topP: -0.01 },
    { ...resolved, topP: 1.01 },
    { ...resolved, topP: Infinity },
    { ...resolved, top_p: 1 },
    { ...resolved, thinkingEffort: null },
    { ...resolved, variant: null },
    { ...resolved, provider: 'openai', variant: { verbosity: 'max' } },
    { ...resolved, provider: 'openai-compatible', variant: { reasoning: { enabled: true } } },
    { ...resolved, variant: { reasoning: { enabled: false, effort: 'high' } } },
    { ...resolved, variant: { reasoning: { enabled: true, effort: 'none' } } },
    { ...resolved, reasoningSupported: false },
    { ...resolved, variant: { reasoning: { enabled: true, effort: 'high' } } },
    { ...resolved, variant: { reasoning: { effort: 'high' }, verbosity: 'high' } },
  ])('rejects unsupported or unowned settings before inference: %#', value => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(() =>
      diagnosticModel({ inference: value as IsolateReviewInference, fetchImpl: fetchMock })
    ).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fall back when prepared model metadata conflicts or is absent', () => {
    expect(() => diagnosticModel({ inference: resolved, model: 'another/model' })).toThrow(
      'does not match'
    );
    expect(() => diagnosticModel({ inference: { ...resolved, modelId: '' } })).toThrow();
  });

  it('accepts the bounded sampling endpoints without accepting extra request fields', () => {
    expect(validateIsolateReviewInference({ ...resolved, temperature: 0, topP: 0 })).toMatchObject({
      temperature: 0,
      topP: 0,
    });
    expect(validateIsolateReviewInference({ ...resolved, temperature: 2, topP: 1 })).toMatchObject({
      temperature: 2,
      topP: 1,
    });
    expect(() =>
      validateIsolateReviewInference({ ...resolved, temperature: 0.55, topP: 1, headers: {} })
    ).toThrow();
  });

  it.each(['kilo-auto/efficient', 'kilo-auto/org'])(
    'rejects prepared sampling overrides for router-owned alias %s',
    modelId => {
      const inference = {
        ...resolved,
        modelId,
        provider: 'openrouter',
        thinkingEffort: null,
        variant: null,
      };
      expect(() => validateIsolateReviewInference({ ...inference, temperature: 0.55 })).toThrow(
        'sampling settings'
      );
      expect(() => validateIsolateReviewInference({ ...inference, topP: 1 })).toThrow(
        'sampling settings'
      );
    }
  );

  it('clones validated settings instead of retaining mutable caller objects', () => {
    const validated = validateIsolateReviewInference(resolved);
    expect(validated).toEqual(resolved);
    expect(validated.variant).not.toBe(resolved.variant);
    expect(validated.variant?.reasoning).not.toBe(resolved.variant.reasoning);
  });
});

describe('stateless Responses cleanup', () => {
  it('removes item IDs and references without deleting function call IDs or encrypted state', () => {
    const body = {
      store: false,
      model: 'openai/gpt-5.4-mini',
      input: [
        { type: 'item_reference', id: 'ref-1' },
        { type: 'reasoning', id: 'rs-1', encrypted_content: 'fixture-encrypted', summary: [] },
        { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'result' },
      ],
    };
    const original = JSON.stringify(body);
    expect(JSON.parse(cleanStatelessResponsesBody(original))).toEqual({
      ...body,
      input: [
        { type: 'reasoning', encrypted_content: 'fixture-encrypted', summary: [] },
        { type: 'function_call', call_id: 'call-1', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'result' },
      ],
    });
    expect(JSON.stringify(body)).toBe(original);
    expect(() => cleanStatelessResponsesBody(JSON.stringify({ ...body, store: true }))).toThrow();
  });
});

describe('inference request identity', () => {
  it('isolates concurrent child headers and reuses their session identity on resume', async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const ids: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(ids).toContain(headers.get('x-kilo-request'));
      requests.push({ headers, body: requestBody(init) });
      return Response.json(responseBody());
    };
    const inference: IsolateReviewInference = {
      ...resolved,
      modelId: 'kilo-auto/efficient',
      provider: 'openrouter',
      thinkingEffort: null,
      variant: null,
    };
    const child = (sessionId: string, mode: 'general' | 'explore') =>
      diagnosticModel({
        inference,
        sessionId,
        parentSessionId: 'root',
        mode,
        organizationId: 'org-123',
        fetchImpl,
        onRequestId: async id => {
          ids.push(id);
        },
      });
    await Promise.all([
      generateText({ model: child('child-a', 'general'), prompt: 'a', maxRetries: 0 }),
      generateText({ model: child('child-b', 'explore'), prompt: 'b', maxRetries: 0 }),
    ]);
    await generateText({ model: child('child-a', 'general'), prompt: 'resume', maxRetries: 0 });
    expect(new Set(ids).size).toBe(3);
    expect(requests.map(({ headers }) => headers.get('x-kilocode-taskid')).sort()).toEqual([
      'child-a',
      'child-a',
      'child-b',
    ]);
    for (const { headers, body } of requests) {
      const id = headers.get('x-kilocode-taskid');
      expect(headers.get('x-kilo-session')).toBe(id);
      expect(headers.get('x-kilocode-parent-taskid')).toBe('root');
      expect(headers.get('x-kilocode-mode')).toBe(id === 'child-a' ? 'general' : 'explore');
      expect(headers.get('x-kilocode-feature')).toBe('code-review');
      expect(headers.get('x-kilocode-organizationid')).toBe('org-123');
      expect(headers.get('user-agent')).toContain('kilo-isolate-review');
      expect(body.reasoning).toBeUndefined();
    }
  });

  it('assigns a distinct correlation ID to an actual transport retry', async () => {
    const ids: string[] = [];
    const wireIds: Array<string | null> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      wireIds.push(new Headers(init?.headers).get('x-kilo-request'));
      if (wireIds.length === 1)
        return Response.json({ error: { message: 'retry fixture' } }, { status: 503 });
      return Response.json(responseBody());
    };
    await generateText({
      model: diagnosticModel({
        fetchImpl,
        onRequestId: id => {
          ids.push(id);
        },
      }),
      prompt: 'hello',
      maxRetries: 1,
    });
    expect(ids).toHaveLength(2);
    expect(wireIds).toEqual(ids);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not submit inference if correlation persistence fails or aborts', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      generateText({
        model: diagnosticModel({
          fetchImpl,
          onRequestId: async () => {
            throw new Error('checkpoint failed');
          },
        }),
        prompt: 'hello',
        maxRetries: 0,
      })
    ).rejects.toThrow('checkpoint failed');
    const controller = new AbortController();
    await expect(
      generateText({
        model: diagnosticModel({ fetchImpl, onRequestId: () => controller.abort() }),
        prompt: 'hello',
        abortSignal: controller.signal,
        maxRetries: 0,
      })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
