import { describe, expect, test } from '@jest/globals';
import { hasActiveOrganizationModelPolicy } from './organization-auto-model-shared';

describe('hasActiveOrganizationModelPolicy', () => {
  test('is false without settings or restrictions', () => {
    expect(hasActiveOrganizationModelPolicy(undefined)).toBe(false);
    expect(hasActiveOrganizationModelPolicy({})).toBe(false);
    expect(hasActiveOrganizationModelPolicy({ model_deny_list: [] })).toBe(false);
    expect(hasActiveOrganizationModelPolicy({ disable_new_models: false })).toBe(false);
  });

  test('is true for a provider allow list, even an empty one', () => {
    expect(hasActiveOrganizationModelPolicy({ provider_allow_list: [] })).toBe(true);
    expect(hasActiveOrganizationModelPolicy({ provider_allow_list: ['openai'] })).toBe(true);
  });

  test('is true for a non-empty model deny list', () => {
    expect(hasActiveOrganizationModelPolicy({ model_deny_list: ['openai/gpt-4o'] })).toBe(true);
  });

  test('is false when only new models are disabled by default', () => {
    expect(hasActiveOrganizationModelPolicy({ disable_new_models: true })).toBe(false);
  });

  test('ignores the deny list the new models policy fills itself', () => {
    expect(
      hasActiveOrganizationModelPolicy({
        disable_new_models: true,
        model_deny_list: ['z-ai/glm-5.1'],
      })
    ).toBe(false);
  });

  test('still counts a provider allow list under the new models policy', () => {
    expect(
      hasActiveOrganizationModelPolicy({ disable_new_models: true, provider_allow_list: [] })
    ).toBe(true);
    expect(
      hasActiveOrganizationModelPolicy({
        disable_new_models: true,
        provider_allow_list: ['openai'],
        model_deny_list: ['z-ai/glm-5.1'],
      })
    ).toBe(true);
  });

  test('counts a deny list once the new models policy is off', () => {
    expect(
      hasActiveOrganizationModelPolicy({
        disable_new_models: false,
        model_deny_list: ['z-ai/glm-5.1'],
      })
    ).toBe(true);
  });
});
