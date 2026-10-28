import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { CustomLlmDefinitionSchema } from '@kilocode/db/schema-types';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import {
  isCustomLlmDeniedInCountry,
  requestCountryCode,
  withoutCustomLlmsDeniedInCountry,
} from './country-deny-list';

describe('requestCountryCode', () => {
  test('reads and normalizes the Vercel IP country', () => {
    expect(requestCountryCode(new Headers({ 'x-vercel-ip-country': ' cu ' }))).toBe('CU');
  });

  test.each([
    ['missing', {}],
    ['empty', { 'x-vercel-ip-country': ' ' }],
  ])('returns null when the header is %s', (_name, headers) => {
    expect(requestCountryCode(new Headers(headers))).toBeNull();
  });
});

describe('isCustomLlmDeniedInCountry', () => {
  const definition = customLlmDefinition({ country_deny_list: ['CU'] });

  test('denies a listed country', () => {
    expect(isCustomLlmDeniedInCountry(definition, 'CU')).toBe(true);
  });

  test('allows an unlisted country, an unknown country, and a definition without a list', () => {
    expect(isCustomLlmDeniedInCountry(definition, 'US')).toBe(false);
    expect(isCustomLlmDeniedInCountry(definition, null)).toBe(false);
    expect(isCustomLlmDeniedInCountry(customLlmDefinition(), 'CU')).toBe(false);
  });
});

describe('country_deny_list schema', () => {
  test('accepts uppercase two-letter country codes', () => {
    expect(
      CustomLlmDefinitionSchema.safeParse(customLlmDefinition({ country_deny_list: ['CU', 'KP'] }))
        .success
    ).toBe(true);
  });

  test.each(['cu', 'CUB', 'C', ''])('rejects %j', code => {
    expect(
      CustomLlmDefinitionSchema.safeParse(customLlmDefinition({ country_deny_list: [code] }))
        .success
    ).toBe(false);
  });
});

describe('withoutCustomLlmsDeniedInCountry', () => {
  const models = [
    { id: 'acme/denied-model' },
    { id: 'acme/allowed-model' },
    { id: 'openai/gpt-5.4-mini' },
  ];

  beforeAll(async () => {
    await insertCustomLlmForTest(
      'acme/denied-model',
      publicCustomLlmDefinition(['acme'], { country_deny_list: ['CU'] })
    );
    await insertCustomLlmForTest('acme/allowed-model', publicCustomLlmDefinition(['acme']));
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/denied-model');
    await deleteCustomLlmForTest('acme/allowed-model');
  });

  test('removes custom LLMs denied in the country', async () => {
    await expect(withoutCustomLlmsDeniedInCountry(models, 'CU')).resolves.toEqual([
      { id: 'acme/allowed-model' },
      { id: 'openai/gpt-5.4-mini' },
    ]);
  });

  test.each([
    ['another country', 'US'],
    ['an unknown country', null],
  ])('keeps every model for %s', async (_name, countryCode) => {
    await expect(withoutCustomLlmsDeniedInCountry(models, countryCode)).resolves.toEqual(models);
  });
});
