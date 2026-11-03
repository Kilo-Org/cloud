import { createVercelProviderMetadataCollector } from '@kilocode/web-shared/lib/r2/vercel-provider-metadata';

test('walks Chat JSON root then every choice message, preserving the raw object', () => {
  const collector = createVercelProviderMetadataCollector();
  const json = {
    id: 'gen_root',
    provider_metadata: { root: true },
    choices: [
      { message: { id: 'gen_first', provider_metadata: { first: true } } },
      { message: { providerMetadata: { final: { unknown: [null, false, 'retained'] } } } },
    ],
  };
  const original = structuredClone(json);

  collector.capture(json, 'chat_completions');

  expect(collector.snapshot()).toEqual({
    generation_id: 'gen_first',
    metadata: { final: { unknown: [null, false, 'retained'] } },
  });
  expect(json).toEqual(original);
});

test('walks every Chat stream delta before the root', () => {
  const collector = createVercelProviderMetadataCollector();
  collector.capture(
    {
      id: 'gen_root',
      providerMetadata: { root: true },
      choices: [
        { delta: { id: 'gen_first', provider_metadata: { first: true } } },
        { delta: { id: 'gen_second', provider_metadata: { second: true } } },
      ],
    },
    'chat_completions'
  );

  expect(collector.snapshot()).toEqual({ generation_id: 'gen_root', metadata: { root: true } });
});

test('retains metadata from a later Chat choice even without usage or top-level metadata', () => {
  const collector = createVercelProviderMetadataCollector();
  collector.capture(
    {
      choices: [
        { delta: { id: 'gen_first', provider_metadata: { first: true } } },
        { delta: { id: 'gen_second', providerMetadata: { second: true } } },
      ],
    },
    'chat_completions'
  );

  expect(collector.snapshot()).toEqual({
    generation_id: 'gen_second',
    metadata: { second: true },
  });
});

test('walks Messages start message before root and captures top-level metadata on every event', () => {
  const collector = createVercelProviderMetadataCollector();
  collector.capture(
    {
      type: 'message_start',
      message: { id: 'gen_nested', provider_metadata: { nested: true } },
      providerMetadata: { root: true },
    },
    'messages'
  );
  expect(collector.snapshot()).toEqual({ generation_id: 'gen_nested', metadata: { root: true } });

  for (const type of ['content_block_start', 'content_block_delta', 'message_delta']) {
    collector.capture({ type, provider_metadata: { latest: type } }, 'messages');
    expect(collector.snapshot()).toEqual({
      generation_id: 'gen_nested',
      metadata: { latest: type },
    });
  }
  collector.capture({ type: 'message_stop', providerMetadata: { stopped: true } }, 'messages');
  expect(collector.snapshot()).toEqual({
    generation_id: 'gen_nested',
    metadata: { stopped: true },
  });
});

test('ignores Messages nested message outside message_start', () => {
  const collector = createVercelProviderMetadataCollector();
  collector.capture(
    {
      type: 'message_delta',
      message: { id: 'not-a-generation', provider_metadata: { invalid: true } },
    },
    'messages'
  );
  expect(collector.snapshot()).toBeUndefined();
});

test('walks every Responses nested response before top-level metadata', () => {
  const collector = createVercelProviderMetadataCollector();
  for (const type of ['response.created', 'response.in_progress', 'response.output_text.delta']) {
    collector.capture(
      {
        type,
        response: { id: `gen_${type}`, providerMetadata: { nested: true } },
        provider_metadata: { latest: type },
      },
      'responses'
    );
    expect(collector.snapshot()).toEqual({
      generation_id: `gen_${type}`,
      metadata: { latest: type },
    });
  }
  collector.capture(
    {
      type: 'response.completed',
      response: { id: 'gen_terminal', provider_metadata: { terminal: { retained: true } } },
    },
    'responses'
  );
  expect(collector.snapshot()).toEqual({
    generation_id: 'gen_terminal',
    metadata: { terminal: { retained: true } },
  });
});

test.each(['messages', 'responses'] as const)(
  'captures %s non-stream JSON root metadata',
  apiKind => {
    const collector = createVercelProviderMetadataCollector();
    collector.capture({ id: 'gen_json', provider_metadata: { unknown: 'retained' } }, apiKind);
    expect(collector.snapshot()).toEqual({
      generation_id: 'gen_json',
      metadata: { unknown: 'retained' },
    });
  }
);

test('replaces metadata instead of merging and retains the last nonempty id on metadata-free frames', () => {
  const collector = createVercelProviderMetadataCollector();
  collector.capture({ id: 'gen_initial' }, 'chat_completions');
  collector.capture({ provider_metadata: { first: true } }, 'chat_completions');
  collector.capture({ providerMetadata: { second: true } }, 'chat_completions');
  collector.capture({ id: 'gen_latest', choices: [] }, 'chat_completions');
  for (const id of ['', null, false, 42, undefined]) {
    collector.capture({ id }, 'chat_completions');
  }
  expect(collector.snapshot()).toEqual({
    generation_id: 'gen_latest',
    metadata: { second: true },
  });
});

test('prefers valid snake_case metadata to valid camelCase metadata', () => {
  const collector = createVercelProviderMetadataCollector();
  collector.capture(
    { provider_metadata: { snake: true }, providerMetadata: { camel: true } },
    'chat_completions'
  );
  expect(collector.snapshot()).toEqual({ generation_id: null, metadata: { snake: true } });
});

test.each([undefined, null, false, 42, 'invalid', []])(
  'ignores invalid metadata %p without clearing the previous object',
  invalid => {
    const collector = createVercelProviderMetadataCollector();
    collector.capture({ provider_metadata: { retained: true } }, 'chat_completions');
    collector.capture(
      { provider_metadata: invalid, providerMetadata: invalid },
      'chat_completions'
    );
    expect(collector.snapshot()).toEqual({ generation_id: null, metadata: { retained: true } });
  }
);

test.each([undefined, null])(
  'falls back to valid camelCase metadata when snake_case is %p',
  invalid => {
    const collector = createVercelProviderMetadataCollector();
    collector.capture(
      { provider_metadata: invalid, providerMetadata: { valid: true } },
      'chat_completions'
    );
    expect(collector.snapshot()).toEqual({ generation_id: null, metadata: { valid: true } });
  }
);

test.each([false, 42, 'invalid', []])(
  'does not fall back to camelCase when non-null snake_case is invalid: %p',
  invalid => {
    const collector = createVercelProviderMetadataCollector();
    collector.capture({ provider_metadata: { retained: true } }, 'chat_completions');
    collector.capture(
      { provider_metadata: invalid, providerMetadata: { ignored: true } },
      'chat_completions'
    );
    expect(collector.snapshot()).toEqual({ generation_id: null, metadata: { retained: true } });
  }
);

test('ignores non-object frames, unrelated subtrees, and invalid choice nodes', () => {
  const collector = createVercelProviderMetadataCollector();
  for (const value of [undefined, null, true, 42, 'not-json', []]) {
    collector.capture(value, 'chat_completions');
  }
  collector.capture(
    {
      output: [{ provider_metadata: { ignored: true } }],
      choices: [null, 42, {}, { delta: [], message: false }],
    },
    'chat_completions'
  );
  expect(collector.snapshot()).toBeUndefined();
});

test('does not treat a finish_reason or mismatched protocol event as metadata completion', async () => {
  const collector = createVercelProviderMetadataCollector();
  const completed = jest.fn();
  void collector.completed.then(completed);
  collector.capture({ choices: [{ finish_reason: 'stop' }] }, 'chat_completions');
  collector.capture({ type: 'error' }, 'chat_completions');
  collector.capture({ type: 'response.completed' }, 'chat_completions');
  collector.capture({ type: 'message_stop' }, 'responses');
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();

  collector.capture({ id: 'gen_late', provider_metadata: { retained: true } }, 'chat_completions');
  collector.capture('[DONE]', 'chat_completions');
  await collector.completed;
  expect(completed).toHaveBeenCalledTimes(1);
  expect(collector.snapshot()).toEqual({ generation_id: 'gen_late', metadata: { retained: true } });
});

test('captures a terminal error envelope before freezing and ignores all subsequent metadata', async () => {
  const collector = createVercelProviderMetadataCollector();
  collector.capture(
    { type: 'error', id: 'gen_error', provider_metadata: { error: { unknown: 'retained' } } },
    'messages'
  );
  collector.capture({ id: 'gen_ignored', provider_metadata: { ignored: true } }, 'messages');
  await collector.completed;
  expect(collector.snapshot()).toEqual({
    generation_id: 'gen_error',
    metadata: { error: { unknown: 'retained' } },
  });
});
