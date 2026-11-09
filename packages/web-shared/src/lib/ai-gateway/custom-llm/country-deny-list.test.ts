import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { CustomLlmDefinitionSchema } from '@kilocode/db/schema-types';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import { isCustomLlmDeniedInCountry, requestCountryCode } from './country-deny-list';
import { listAvailableCustomLlms } from './listAvailableCustomLlms';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';

describe('requestCountryCode', () => {
  test('reads and normalizes the Vercel IP country', () => {
    expect(requestCountryCode(new Headers({ 'x-vercel-ip-country': ' cu ' }))).toBe('CU');
  });

  test.each([
    ['missing', new Headers()],
    ['empty', new Headers({ 'x-vercel-ip-country': ' ' })],
    ['unavailable', undefined],
  ])('returns null when the header is %s', (_name, headers) => {
    expect(requestCountryCode(headers)).toBeNull();
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

describe('listAvailableCustomLlms', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest(
      'acme/country-denied-private',
      customLlmDefinition({ organization_ids: [ORG_ID], country_deny_list: ['CU'] })
    );
    await insertCustomLlmForTest(
      'acme/unrestricted-private',
      customLlmDefinition({ organization_ids: [ORG_ID] })
    );
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/country-denied-private');
    await deleteCustomLlmForTest('acme/unrestricted-private');
  });

  async function listedIds(countryCode: string | null) {
    return (await listAvailableCustomLlms(ORG_ID, [], countryCode)).map(model => model.id).sort();
  }

  test('leaves out private custom LLMs denied in the country', async () => {
    await expect(listedIds('CU')).resolves.toEqual(['acme/unrestricted-private']);
  });

  test.each([
    ['another country', 'US'],
    ['an unknown country', null],
  ])('lists every granted private custom LLM for %s', async (_name, countryCode) => {
    await expect(listedIds(countryCode)).resolves.toEqual([
      'acme/country-denied-private',
      'acme/unrestricted-private',
    ]);
  });
});
