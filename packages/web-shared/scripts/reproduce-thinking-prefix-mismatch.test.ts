import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRequest,
  classifyError,
  makeSeedScenario,
  parseOptions,
  preflight,
  sanitizeError,
  scenarios,
  validateMessage,
} from './reproduce-thinking-prefix-mismatch';

const history = [
  { role: 'user', content: 'synthetic question' },
  {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'synthetic private reasoning',
        signature: 'synthetic-signature',
      },
      { type: 'text', text: '38' },
    ],
  },
  { role: 'user', content: 'n + 1?' },
] satisfies Parameters<typeof buildRequest>[2];

function scenario(name: string) {
  const found = scenarios.find(entry => entry.name === name);
  assert.ok(found);
  return found;
}

function message() {
  return {
    type: 'message',
    role: 'assistant',
    content: structuredClone(history[1].content),
    stop_reason: 'end_turn',
    usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 0 },
    input_transformations: [],
  };
}

test('actual production helper adds drop_block and both beta headers for adaptive and omitted settings', () => {
  for (const target of ['anthropic', 'vercel'] as const) {
    for (const name of ['changed-adaptive', 'changed-absent']) {
      const { request, extraHeaders } = buildRequest(target, 'anthropic', history, scenario(name));
      assert.deepEqual(request.body.thinking, {
        type: 'adaptive',
        ...(name === 'changed-adaptive' && { display: 'summarized' }),
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      });
      assert.deepEqual(extraHeaders, {
        'anthropic-beta': 'thinking-binding-controls-2026-08-01',
        'x-anthropic-beta': 'thinking-binding-controls-2026-08-01',
      });
      assert.deepEqual(request.body.messages, history);
    }
  }
});

test('bypass controls do not acquire binding or beta headers and retain historical blocks', () => {
  for (const name of ['changed-adaptive-without-helper', 'changed-disabled-without-helper']) {
    const { request, extraHeaders } = buildRequest('vercel', 'anthropic', history, scenario(name));
    assert.equal(request.body.thinking?.block_binding, undefined);
    assert.deepEqual(extraHeaders, {});
    assert.deepEqual(request.body.messages, history);
  }
});

test('actual helper strips top-level historical thinking for explicit nonadaptive modes only', () => {
  const historyWithRedactedAndEmptyThinking = [
    { role: 'user', content: 'synthetic question' },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'synthetic private reasoning',
          signature: 'synthetic-signature',
        },
        { type: 'redacted_thinking', data: 'synthetic-redacted-reasoning' },
        { type: 'text', text: '38' },
        { type: 'tool_use', id: 'toolu_test', name: 'lookup', input: { query: 'synthetic' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'only reasoning', signature: 'synthetic-signature-2' },
      ],
    },
    { role: 'user', content: 'n + 1?' },
  ] satisfies Parameters<typeof buildRequest>[2];

  for (const name of ['changed-disabled', 'changed-enabled']) {
    const { request, extraHeaders } = buildRequest(
      'anthropic',
      'anthropic',
      historyWithRedactedAndEmptyThinking,
      scenario(name)
    );
    assert.deepEqual(
      request.body.thinking,
      name === 'changed-disabled' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: 1_024 }
    );
    assert.deepEqual(request.body.messages, [
      historyWithRedactedAndEmptyThinking[0],
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '38' },
          { type: 'tool_use', id: 'toolu_test', name: 'lookup', input: { query: 'synthetic' } },
        ],
      },
      historyWithRedactedAndEmptyThinking[3],
    ]);
    assert.deepEqual(extraHeaders, {
      'anthropic-beta': 'thinking-binding-controls-2026-08-01',
      'x-anthropic-beta': 'thinking-binding-controls-2026-08-01',
    });
  }
});

test('helper preserves explicit error behavior and still adds beta', () => {
  const { request, extraHeaders } = buildRequest(
    'anthropic',
    'anthropic',
    history,
    scenario('changed-adaptive-explicit-error')
  );
  assert.deepEqual(request.body.thinking?.block_binding, { prefix_mismatch_behavior: 'error' });
  assert.ok(extraHeaders['anthropic-beta'].includes('thinking-binding-controls-2026-08-01'));
});

test('beta-only control does not apply helper and routing is pinned for every Vercel provider', () => {
  for (const provider of ['anthropic', 'bedrock', 'vertex'] as const) {
    const { request, extraHeaders } = buildRequest(
      'vercel',
      provider,
      history,
      scenario('changed-adaptive-beta-only')
    );
    assert.equal(request.body.thinking?.block_binding, undefined);
    assert.deepEqual(extraHeaders, { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' });
    assert.deepEqual(request.body.providerOptions, {
      gateway: { only: [provider], sessionAffinity: false },
    });
  }
});

test('request construction clones whole history and changes only the requested system marker', () => {
  const before = structuredClone(history);
  const unchanged = buildRequest('anthropic', 'anthropic', history, scenario('unchanged-adaptive'));
  const changed = buildRequest('anthropic', 'anthropic', history, scenario('changed-adaptive'));
  assert.equal(
    unchanged.request.body.system,
    'This task involves multistep reasoning. Think carefully before responding. Session marker: A.'
  );
  assert.equal(
    changed.request.body.system,
    'This task involves multistep reasoning. Think carefully before responding. Session marker: B.'
  );
  assert.deepEqual(unchanged.request.body.messages, before);
  assert.deepEqual(changed.request.body.messages, before);
  assert.notEqual(unchanged.request.body.messages, history);
  unchanged.request.body.messages[0].content = 'local edit';
  assert.deepEqual(history, before);
  assert.deepEqual(changed.request.body.messages, before);
  assert.equal(unchanged.request.body.providerOptions, undefined);
});

test('validates signed seed and preserves complete content while projecting safe metadata', () => {
  const value = {
    ...message(),
    input_transformations: [
      {
        type: 'thinking_dropped',
        reason: 'prefix_binding_mismatch',
        path: 'messages.1.content.0',
        ignored: 'not projected',
      },
    ],
  };
  const parsed = validateMessage(value, true);
  assert.deepEqual(parsed.content, value.content);
  assert.deepEqual(parsed.input_transformations, [
    { type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.1.content.0' },
  ]);
  assert.deepEqual(parsed.usage, {
    input_tokens: 40,
    output_tokens: 20,
    cache_read_input_tokens: 0,
  });
});

test('accepts a valid signed thinking block even when the response text is empty', () => {
  const value = {
    ...message(),
    content: [
      {
        type: 'thinking',
        thinking: 'synthetic private reasoning',
        signature: 'synthetic-signature',
      },
      { type: 'text', text: '' },
    ],
  };
  assert.deepEqual(validateMessage(value, true).content, value.content);
});

test('rejects unsigned/truncated seeds and malformed external response data without echoing it', () => {
  for (const value of [
    null,
    { ...message(), content: [{ type: 'text', text: 'unsigned' }] },
    { ...message(), content: [{ type: 'thinking', thinking: 'private', signature: '' }] },
    { ...message(), stop_reason: 'max_tokens' },
    { ...message(), usage: { input_tokens: -1, output_tokens: 3 } },
    {
      ...message(),
      input_transformations: [
        { type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'private-data' },
      ],
    },
  ])
    assert.throws(() => validateMessage(value, true), /Invalid|Seed must/);
});

test('sanitizes supplied credentials and signed content before bounding output', () => {
  const secrets = ['synthetic-api-key', 'synthetic-signature', 'private reasoning'];
  const result = sanitizeError(
    `Invalid signature: ${secrets.join(' ')}\n${'x'.repeat(2_000)}`,
    secrets
  );
  for (const secret of secrets) assert.equal(result.includes(secret), false);
  assert.equal(result.includes('\n'), false);
  assert.ok(result.length <= 1_000);
  assert.equal(
    sanitizeError('Bearer synthetic_token sk-synthetic-token', []),
    '[REDACTED] [REDACTED]'
  );
});

test('prefix mismatch is not confused with mode incompatibility or a corrupted signature', () => {
  assert.deepEqual(
    classifyError(
      'Invalid `signature` in `thinking` block. The block is bound to a different conversation. That setting requires the `thinking-binding-controls-2026-08-01` value.'
    ),
    {
      prefixMismatch: true,
      betaRequirementMentioned: true,
      unsupportedThinkingMode: false,
    }
  );
  assert.equal(
    classifyError('thinking enabled is not supported; use adaptive').unsupportedThinkingMode,
    true
  );
  assert.equal(classifyError('Invalid `signature` in `thinking` block').prefixMismatch, false);
});

test('CLI validates options, help needs no credentials, and both credentials preflight together', () => {
  assert.deepEqual(parseOptions([]), {
    help: false,
    target: 'both',
    provider: 'anthropic',
    model: 'sonnet',
    seedThinking: 'adaptive',
    vercelByok: false,
  });
  assert.deepEqual(
    parseOptions([
      '--target',
      'vercel',
      '--vercel-provider',
      'bedrock',
      '--model',
      'fable',
      '--seed-thinking',
      'absent',
    ]),
    {
      help: false,
      target: 'vercel',
      provider: 'bedrock',
      model: 'fable',
      seedThinking: 'absent',
      vercelByok: false,
    }
  );
  assert.equal(parseOptions(['--model', 'haiku']).model, 'haiku');
  assert.equal(parseOptions(['--help']).help, true);
  assert.throws(
    () => parseOptions(['--target', 'https://unexpected.example']),
    /Expected --target/
  );
  assert.throws(() => parseOptions(['--seed-thinking', 'disabled']), /--seed-thinking/);
  assert.throws(
    () => preflight(['anthropic', 'vercel'], {}),
    /ANTHROPIC_API_KEY, VERCEL_AI_GATEWAY_API_KEY/
  );
  assert.throws(
    () => preflight(['anthropic', 'vercel'], { ANTHROPIC_API_KEY: 'present' }),
    /VERCEL_AI_GATEWAY_API_KEY/
  );
  assert.doesNotThrow(() => preflight(['anthropic'], { ANTHROPIC_API_KEY: 'present' }));
});

test('Haiku model mapping supports both endpoints and absent seed mode really omits thinking', () => {
  const seed = makeSeedScenario('absent');
  assert.equal(seed.helper, false);
  for (const target of ['anthropic', 'vercel'] as const) {
    const { request, extraHeaders } = buildRequest(target, 'anthropic', history, seed, 'haiku');
    assert.equal(
      request.body.model,
      target === 'anthropic' ? 'claude-haiku-5-5' : 'anthropic/claude-haiku-5.5'
    );
    assert.equal('thinking' in request.body, false);
    assert.deepEqual(request.body.messages, history);
    assert.deepEqual(extraHeaders, {});
  }
});

test('recognizes the Sonnet disabled-mode rejection without mistaking it for a signature error', () => {
  assert.deepEqual(
    classifyError(
      'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}. The model does not think before responding.'
    ),
    { prefixMismatch: false, betaRequirementMentioned: false, unsupportedThinkingMode: true }
  );
});

test('optional Vercel BYOK supplies the Anthropic account and preflights its extra credential', () => {
  assert.equal(parseOptions(['--vercel-byok', '--target', 'vercel']).vercelByok, true);
  assert.throws(() => parseOptions(['--vercel-byok', '--vercel-provider', 'vertex']), /requires/);
  assert.throws(
    () => preflight(['vercel'], { VERCEL_AI_GATEWAY_API_KEY: 'present' }, true),
    /ANTHROPIC_API_KEY/
  );
  const { request } = buildRequest(
    'vercel',
    'anthropic',
    history,
    scenario('changed-adaptive'),
    'fable',
    'synthetic-key'
  );
  assert.equal(request.body.model, 'anthropic/claude-fable-5.2');
  assert.deepEqual(request.body.providerOptions?.gateway?.byok, {
    anthropic: [{ apiKey: 'synthetic-key' }],
  });
});
