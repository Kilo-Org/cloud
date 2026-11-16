import { describe, expect, test } from '@jest/globals';
import {
  EMPTY_ENDPOINT_CREDENTIALS_FORM,
  buildEndpointCredentials,
  buildEndpointDefinition,
  mergeImportedModels,
  toEndpointForm,
  toEndpointModelRow,
} from './endpoint-form';

const MODEL = {
  id: 'my-model',
  internal_id: 'My-Model',
  context_length: 100000,
  max_completion_tokens: 8000,
};

describe('buildEndpointDefinition', () => {
  test('builds a definition and leaves unset overrides out', () => {
    const form = {
      ...toEndpointForm(null),
      name: ' Gateway ',
      base_url: ' https://api.example.com/v1 ',
      models: [toEndpointModelRow(MODEL)],
    };

    expect(buildEndpointDefinition(form)).toEqual({
      success: true,
      data: {
        name: 'Gateway',
        base_url: 'https://api.example.com/v1',
        api_kinds: ['chat_completions'],
        client_provider: 'openrouter',
        reasoning_format: 'reasoning-details',
        models: [{ ...MODEL, supports_image_input: false }],
      },
    });
  });

  test('round-trips a stored definition with model overrides', () => {
    const definition = {
      name: 'Gateway',
      base_url: 'https://api.example.com/{model}',
      api_kinds: ['chat_completions' as const, 'messages' as const],
      client_provider: 'anthropic' as const,
      reasoning_format: 'reasoning-content' as const,
      models: [
        {
          ...MODEL,
          name: 'Mine',
          supports_image_input: true,
          api_kinds: ['chat_completions' as const],
          client_provider: 'openrouter' as const,
        },
      ],
    };

    expect(buildEndpointDefinition(toEndpointForm(definition))).toEqual({
      success: true,
      data: definition,
    });
  });

  test('names the model and field of each problem', () => {
    const form = {
      ...toEndpointForm(null),
      name: 'Gateway',
      base_url: 'https://api.example.com/v1/',
      models: [toEndpointModelRow({ ...MODEL, id: 'Bad ID' }), toEndpointModelRow()],
    };

    const result = buildEndpointDefinition(form);

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

describe('buildEndpointCredentials', () => {
  test('keeps the stored credentials when an optional form is untouched', () => {
    expect(buildEndpointCredentials(EMPTY_ENDPOINT_CREDENTIALS_FORM, { optional: true })).toEqual({
      success: true,
      data: null,
    });
    expect(
      buildEndpointCredentials(EMPTY_ENDPOINT_CREDENTIALS_FORM, { optional: false }).success
    ).toBe(false);
  });

  test('builds x-api-key and AWS credentials', () => {
    expect(
      buildEndpointCredentials(
        { ...EMPTY_ENDPOINT_CREDENTIALS_FORM, type: 'x-api-key', api_key: ' secret ' },
        { optional: false }
      )
    ).toEqual({ success: true, data: { type: 'x-api-key', api_key: 'secret' } });
    expect(
      buildEndpointCredentials(
        { ...EMPTY_ENDPOINT_CREDENTIALS_FORM, type: 'aws_bedrock', region: 'us-east-1' },
        { optional: true }
      ).success
    ).toBe(false);
  });

  test('reports a service account key that is not JSON', () => {
    expect(
      buildEndpointCredentials(
        { ...EMPTY_ENDPOINT_CREDENTIALS_FORM, type: 'service_account', service_account_json: '{' },
        { optional: false }
      )
    ).toEqual({ success: false, errors: ['The service account key is not valid JSON.'] });
  });
});

describe('mergeImportedModels', () => {
  test('replaces the empty row, skips listed upstream ids, and renames taken ids', () => {
    const existing = [toEndpointModelRow(MODEL), toEndpointModelRow()];

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
    const existing = [toEndpointModelRow({ ...MODEL, id: longId, internal_id: 'first' })];

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
