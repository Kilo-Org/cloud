import { describe, expect, test } from '@jest/globals';
import { z } from 'zod';
import { formatZodIssue, formatZodIssues, formatZodError } from './format-zod-error';
import { deepStrict } from './deep-strict';
import { CustomLlmDefinitionSchema } from '@kilocode/db/schema-types';

describe('formatZodIssue', () => {
  test('formats issue with path', () => {
    const formatted = formatZodIssue({
      code: 'invalid_type',
      path: ['internal_id'],
      message: 'Too small',
    });
    expect(formatted).toBe('internal_id: Too small');
  });

  test('formats issue with empty path without leading colon', () => {
    const formatted = formatZodIssue({
      code: 'custom',
      path: [],
      message: 'Invalid configuration',
    });
    expect(formatted).toBe('Invalid configuration');
  });

  test('formats unrecognized_keys at top level', () => {
    const formatted = formatZodIssue({
      code: 'unrecognized_keys',
      path: [],
      keys: ['dispaly_name'],
    });
    expect(formatted).toBe('Unrecognized key: "dispaly_name"');
  });

  test('formats multiple unrecognized_keys with nested path', () => {
    const formatted = formatZodIssue({
      code: 'unrecognized_keys',
      path: ['pricing'],
      keys: ['extra1', 'extra2'],
    });
    expect(formatted).toBe('pricing: Unrecognized keys: "extra1", "extra2"');
  });
});

describe('formatZodIssues with unions', () => {
  const schema = deepStrict(CustomLlmDefinitionSchema);

  test('formats initial definition errors cleanly without ": Invalid input"', () => {
    const initialDefinition = {
      internal_id: '',
      display_name: '',
      context_length: 0,
      max_completion_tokens: 0,
      base_url: '',
      api_key: '',
      organization_ids: [],
    };

    const result = schema.safeParse(initialDefinition);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = formatZodIssues(result.error.issues);
      expect(messages).not.toContain(': Invalid input');
      expect(messages).not.toContain('Invalid input');
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining('internal_id'),
          expect.stringContaining('base_url'),
        ])
      );
    }
  });

  test('picks the API key branch when api_key is present and fields have typos', () => {
    const typoInput = {
      internal_id: 'model-1',
      dispaly_name: 'Typo Name',
      context_length: 1000,
      max_completion_tokens: 100,
      base_url: 'https://example.com',
      api_key: 'secret',
      organization_ids: [],
    };

    const result = schema.safeParse(typoInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = formatZodIssues(result.error.issues);
      expect(messages).not.toContain(': Invalid input');
      expect(messages).toContain('Unrecognized key: "dispaly_name"');
      expect(messages.some(m => m.includes('display_name'))).toBe(true);
      expect(messages.some(m => m.includes('google_service_account'))).toBe(false);
    }
  });

  test('picks the Google service account branch when google_service_account is present', () => {
    const gsaInput = {
      internal_id: 'model-1',
      display_name: 'Vertex Gemini',
      context_length: 1000,
      max_completion_tokens: 100,
      base_url: 'https://example.com',
      organization_ids: [],
      google_service_account: {
        type: 'service_account',
        project_id: 'proj',
        private_key_id: 'key-id',
        private_key: 'pk',
        client_email: 'invalid-email',
        client_id: '123',
        auth_uri: 'https://accounts.google.com',
        token_uri: 'https://oauth2.googleapis.com',
        auth_provider_x509_cert_url: 'https://example.com',
        client_x509_cert_url: 'https://example.com',
      },
    };

    const result = schema.safeParse(gsaInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = formatZodIssues(result.error.issues);
      expect(messages).not.toContain(': Invalid input');
      expect(messages.some(m => m.includes('google_service_account.client_email'))).toBe(true);
      expect(messages.some(m => m.includes('api_key'))).toBe(false);
    }
  });

  test('shows both authentication options when neither is provided', () => {
    const noAuthInput = {
      internal_id: 'model-1',
      display_name: 'Model 1',
      context_length: 1000,
      max_completion_tokens: 100,
      base_url: 'https://example.com',
      organization_ids: [],
    };

    const result = schema.safeParse(noAuthInput);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = formatZodIssues(result.error.issues);
      expect(messages).not.toContain(': Invalid input');
      expect(messages.some(m => m.includes('api_key'))).toBe(true);
      expect(messages.some(m => m.includes('google_service_account'))).toBe(true);
    }
  });

  test('handles nested unions with path prefixes', () => {
    const nestedSchema = z.object({
      config: z.union([
        z.object({ mode: z.literal('a'), aValue: z.string() }),
        z.object({ mode: z.literal('b'), bValue: z.number() }),
      ]),
    });

    const result = nestedSchema.safeParse({ config: { mode: 'a', aValue: 123 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = formatZodIssues(result.error.issues);
      expect(messages).toEqual(['config.aValue: Invalid input: expected string, received number']);
    }
  });
});

describe('formatZodError', () => {
  test('formats ZodError instance', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toBe('name: Invalid input: expected string, received number');
    }
  });

  test('formats JSON-encoded TRPC issues string', () => {
    const jsonError = JSON.stringify([
      {
        code: 'custom',
        message: 'public_id must start with "custom-llm/"',
        path: ['public_id'],
      },
    ]);
    const formatted = formatZodError(new Error(jsonError));
    expect(formatted).toBe('public_id: public_id must start with "custom-llm/"');
  });

  test('formats TRPC data.zodError shape', () => {
    const trpcError = {
      message: 'BAD_REQUEST',
      data: {
        zodError: {
          formErrors: [],
          fieldErrors: {
            public_id: ['public_id is required'],
          },
        },
      },
    };
    const formatted = formatZodError(trpcError);
    expect(formatted).toBe('public_id: public_id is required');
  });

  test('falls back to plain Error message', () => {
    const formatted = formatZodError(new Error('Network error'));
    expect(formatted).toBe('Network error');
  });
});
