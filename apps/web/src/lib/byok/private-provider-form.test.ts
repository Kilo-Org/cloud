import { describe, expect, test } from '@jest/globals';
import { BYOK_PRIVATE_PROVIDER_MAX_MODELS } from '@kilocode/db/schema-types';
import {
  EMPTY_PRIVATE_PROVIDER_CREDENTIALS_FORM,
  addToImportSelection,
  buildPrivateProviderCredentials,
  buildPrivateProviderDefinition,
  getImportCapacity,
  mergeImportedModels,
  sendsPromptCacheKeyOver,
  setPrivateModelFlag,
  toPrivateProviderForm,
  toPrivateModelRow,
} from './private-provider-form';

const MODEL = {
  id: 'my-model',
  internal_id: 'My-Model',
  context_length: 100000,
  max_completion_tokens: 8000,
};

describe('sendsPromptCacheKeyOver', () => {
  test('applies to Chat Completions and Responses only', () => {
    expect(sendsPromptCacheKeyOver(['messages', 'responses'])).toBe(true);
    expect(sendsPromptCacheKeyOver(['chat_completions'])).toBe(true);
    expect(sendsPromptCacheKeyOver(['messages'])).toBe(false);
  });
});

describe('buildPrivateProviderDefinition', () => {
  test('builds a definition and leaves unset overrides out', () => {
    const form = {
      ...toPrivateProviderForm(null),
      name: ' Gateway ',
      base_url: ' https://api.example.com/v1 ',
      models: [toPrivateModelRow(MODEL)],
    };

    expect(buildPrivateProviderDefinition(form)).toEqual({
      success: true,
      data: {
        name: 'Gateway',
        base_url: 'https://api.example.com/v1',
        api_kinds: ['chat_completions'],
        client_provider: 'openrouter',
        reasoning_format: 'reasoning-details',
        models: [MODEL],
      },
    });
  });

  test('round-trips a stored definition with model overrides', () => {
    const definition = {
      name: 'Gateway',
      base_url: 'https://api.example.com/v1',
      api_kinds: ['chat_completions' as const, 'messages' as const],
      client_provider: 'anthropic' as const,
      reasoning_format: 'reasoning-content' as const,
      send_prompt_cache_key: true,
      models: [
        {
          ...MODEL,
          name: 'Mine',
          flags: ['vision' as const, 'recommended' as const],
          api_kinds: ['chat_completions' as const],
          client_provider: 'openrouter' as const,
          send_prompt_cache_key: false,
        },
      ],
    };

    expect(buildPrivateProviderDefinition(toPrivateProviderForm(definition))).toEqual({
      success: true,
      data: definition,
    });
  });

  test('names the model and field of each problem', () => {
    const form = {
      ...toPrivateProviderForm(null),
      name: 'Gateway',
      base_url: 'https://api.example.com/v1/',
      models: [toPrivateModelRow({ ...MODEL, id: 'Bad ID' }), toPrivateModelRow()],
    };

    const result = buildPrivateProviderDefinition(form);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Base URL: must not end with a slash',
        'Model 1 (Bad ID), Model ID: Model IDs may only contain lowercase letters, digits, and . / _ -',
        expect.stringMatching(/^Model 2, Upstream model ID: /),
        expect.stringMatching(/^Model 2, Context window: /),
      ])
    );
  });
});

describe('setPrivateModelFlag', () => {
  test('sets and clears one flag and keeps the others', () => {
    expect(setPrivateModelFlag(['recommended'], 'reasoning', true)).toEqual([
      'recommended',
      'reasoning',
    ]);
    expect(setPrivateModelFlag(['reasoning', 'vision'], 'reasoning', true)).toEqual([
      'vision',
      'reasoning',
    ]);
    expect(setPrivateModelFlag(['reasoning', 'vision'], 'vision', false)).toEqual(['reasoning']);
  });

  test('builds a definition with the flags of a row', () => {
    const row = toPrivateModelRow(MODEL);
    const form = {
      ...toPrivateProviderForm(null),
      name: 'Gateway',
      base_url: 'https://api.example.com/v1',
      models: [{ ...row, flags: setPrivateModelFlag(row.flags, 'reasoning', true) }],
    };

    const result = buildPrivateProviderDefinition(form);

    expect(result.success && result.data.models).toEqual([{ ...MODEL, flags: ['reasoning'] }]);
  });
});

describe('buildPrivateProviderCredentials', () => {
  test('keeps the stored credentials only when the user chose to keep them', () => {
    expect(
      buildPrivateProviderCredentials(EMPTY_PRIVATE_PROVIDER_CREDENTIALS_FORM, { keepSaved: true })
    ).toEqual({ success: true, data: null });
  });

  test('requires credentials once the user replaces them, whatever the authentication type', () => {
    for (const type of ['api_key', 'x-api-key', 'aws_bedrock', 'service_account'] as const) {
      expect(
        buildPrivateProviderCredentials(
          { ...EMPTY_PRIVATE_PROVIDER_CREDENTIALS_FORM, type },
          { keepSaved: false }
        )
      ).toEqual({ success: false, errors: ['Enter the private provider credentials.'] });
    }
  });

  test('builds x-api-key and AWS credentials', () => {
    expect(
      buildPrivateProviderCredentials(
        { ...EMPTY_PRIVATE_PROVIDER_CREDENTIALS_FORM, type: 'x-api-key', api_key: ' secret ' },
        { keepSaved: false }
      )
    ).toEqual({ success: true, data: { type: 'x-api-key', api_key: 'secret' } });
    expect(
      buildPrivateProviderCredentials(
        { ...EMPTY_PRIVATE_PROVIDER_CREDENTIALS_FORM, type: 'aws_bedrock', region: 'us-east-1' },
        { keepSaved: false }
      ).success
    ).toBe(false);
  });

  test('reports a service account key that is not JSON', () => {
    expect(
      buildPrivateProviderCredentials(
        {
          ...EMPTY_PRIVATE_PROVIDER_CREDENTIALS_FORM,
          type: 'service_account',
          service_account_json: '{',
        },
        { keepSaved: false }
      )
    ).toEqual({ success: false, errors: ['The service account key is not valid JSON.'] });
  });
});

describe('mergeImportedModels', () => {
  test('replaces the empty row, skips listed upstream ids, and renames taken ids', () => {
    const existing = [toPrivateModelRow(MODEL), toPrivateModelRow()];

    const merged = mergeImportedModels(existing, [
      { ...MODEL },
      { ...MODEL, internal_id: 'my-model' },
      { ...MODEL, id: 'other', internal_id: 'Other' },
    ]);

    expect(merged.map(row => [row.id, row.internal_id])).toEqual([
      ['my-model', 'My-Model'],
      ['my-model-2', 'my-model'],
      ['other', 'Other'],
    ]);
  });

  test('keeps renamed ids within the length limit', () => {
    const longId = 'a'.repeat(200);
    const existing = [toPrivateModelRow({ ...MODEL, id: longId, internal_id: 'first' })];

    const merged = mergeImportedModels(existing, [
      { ...MODEL, id: longId, internal_id: 'second' },
      { ...MODEL, id: longId, internal_id: 'third' },
    ]);

    expect(merged.map(row => row.id)).toEqual([
      longId,
      `${'a'.repeat(198)}-2`,
      `${'a'.repeat(198)}-3`,
    ]);
    expect(merged.every(row => row.id.length <= 200)).toBe(true);
  });
});

describe('import capacity', () => {
  test('counts only the rows with content against the model limit', () => {
    expect(getImportCapacity([toPrivateModelRow()])).toBe(BYOK_PRIVATE_PROVIDER_MAX_MODELS);
    expect(getImportCapacity([toPrivateModelRow(MODEL), toPrivateModelRow()])).toBe(
      BYOK_PRIVATE_PROVIDER_MAX_MODELS - 1
    );
  });

  test('is never negative', () => {
    const rows = Array.from({ length: BYOK_PRIVATE_PROVIDER_MAX_MODELS + 1 }, (_, index) =>
      toPrivateModelRow({ ...MODEL, id: `model-${index}`, internal_id: `model-${index}` })
    );

    expect(getImportCapacity(rows)).toBe(0);
  });

  test('stops adding to a selection at capacity', () => {
    const next = addToImportSelection(new Set(['a']), ['a', 'b', 'c', 'd'], 3);

    expect([...next]).toEqual(['a', 'b', 'c']);
  });

  test('leaves a selection at capacity unchanged', () => {
    expect([...addToImportSelection(new Set(['a', 'b']), ['c'], 2)]).toEqual(['a', 'b']);
  });
});
