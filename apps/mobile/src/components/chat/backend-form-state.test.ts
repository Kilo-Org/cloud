import { describe, expect, it, vi } from 'vitest';

import {
  backendConnectionFromFields,
  backendDraftFromFields,
  type BackendFormFields,
} from './backend-form-state';

vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const fields: BackendFormFields = {
  name: ' Manual ',
  baseUrl: 'https://models.example/v1/',
  apiKey: '',
  headers: '{}',
  apiKind: 'messages',
  completionTokenField: 'max_completion_tokens',
  models: [
    {
      key: 'row',
      id: 'manual-model',
      name: 'My model',
      contextWindow: '',
      maxOutputTokens: '',
      tools: false,
      images: false,
    },
  ],
};

describe('backend form boundary', () => {
  it('saves manual models without discovery and leaves unknown tool support off', () => {
    expect(backendDraftFromFields(fields, false)).toMatchObject({
      name: 'Manual',
      baseUrl: 'https://models.example/v1',
      models: [
        { id: 'manual-model', tools: false, contextWindow: undefined, maxOutputTokens: undefined },
      ],
    });
  });

  it('discovery connection fields do not require a name or a manual model', () => {
    expect(backendConnectionFromFields({ ...fields, name: '', models: [] }, false)).toMatchObject({
      baseUrl: 'https://models.example/v1',
      apiKind: 'messages',
    });
    expect(() => backendDraftFromFields({ ...fields, models: [] }, false)).toThrow('invalidInput');
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '2e3', '123junk', '9007199254740992'])(
    'rejects malformed token limits: %s',
    contextWindow => {
      expect(() =>
        backendDraftFromFields(
          { ...fields, models: fields.models.map(model => ({ ...model, contextWindow })) },
          false
        )
      ).toThrow('invalidInput');
    }
  );

  it('accepts positive whole token limits and explicit tool and image support', () => {
    expect(
      backendDraftFromFields(
        {
          ...fields,
          models: fields.models.map(model => ({
            ...model,
            contextWindow: '8192',
            maxOutputTokens: '1024',
            tools: true,
            images: true,
          })),
        },
        false
      ).models[0]
    ).toMatchObject({ contextWindow: 8192, maxOutputTokens: 1024, tools: true, images: true });
  });

  it('saves a model with the image flag off as text-only', () => {
    expect(backendDraftFromFields(fields, false).models[0]).toMatchObject({ images: false });
  });

  it.each(['max_completion_tokens', 'max_tokens'] as const)(
    'retains %s for saves and connection checks',
    completionTokenField => {
      const selected = { ...fields, apiKind: 'chat_completions' as const, completionTokenField };
      expect(backendDraftFromFields(selected, false).completionTokenField).toBe(
        completionTokenField
      );
      expect(backendConnectionFromFields(selected, false).completionTokenField).toBe(
        completionTokenField
      );
    }
  );

  it.each([
    'not-json-secret',
    '[]',
    'null',
    '{"Authorization": 42}',
    '{"x-kilocode-feature":"mobile-chat"}',
    '{"bad header":"private"}',
    String.raw`{"Authorization":"private\r\nsecond: header"}`,
  ])('refuses invalid headers without echoing input: %s', headers => {
    expect(() => backendDraftFromFields({ ...fields, headers }, false)).toThrow('invalidInput');
    expect(() => backendConnectionFromFields({ ...fields, headers }, false)).toThrow(
      'invalidInput'
    );
  });

  it('requires approval before saving an otherwise valid local HTTP profile', () => {
    expect(() =>
      backendDraftFromFields({ ...fields, baseUrl: 'http://localhost:8080/v1' }, false)
    ).toThrow('httpApprovalRequired');
    expect(
      backendDraftFromFields({ ...fields, baseUrl: 'http://localhost:8080/v1' }, true)
        .allowLocalHttp
    ).toBe(true);
  });
});
