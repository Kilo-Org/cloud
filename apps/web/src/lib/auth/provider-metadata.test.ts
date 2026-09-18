import { describe, expect, test } from '@jest/globals';
import { OpenAILogo } from '@/components/auth/OpenAILogo';
import {
  AllAuthMethodIds,
  AuthProviderIdSchema,
  LinkableAuthProviders,
  OAuthProviderIds,
  ProdNonSSOAuthProviders,
  getProviderById,
} from './provider-metadata';

describe('Anaconda provider metadata', () => {
  test('defines Anaconda as a linkable OAuth sign-in method', () => {
    expect(AuthProviderIdSchema.parse('anaconda')).toBe('anaconda');
    expect(getProviderById('anaconda')).toMatchObject({
      id: 'anaconda',
      name: 'Anaconda',
    });
    expect(LinkableAuthProviders[0]?.id).toBe('anaconda');
    expect(OAuthProviderIds[0]).toBe('anaconda');
    expect(ProdNonSSOAuthProviders[0]).toBe('anaconda');
    expect(AllAuthMethodIds).toContain('anaconda');
  });
});

describe('OpenAI provider metadata', () => {
  test('defines ChatGPT as a linkable OAuth sign-in method', () => {
    expect(AuthProviderIdSchema.parse('openai')).toBe('openai');
    expect(getProviderById('openai')).toMatchObject({
      id: 'openai',
      name: 'ChatGPT',
      signInLabel: 'Continue with ChatGPT',
    });
    expect(OAuthProviderIds).toContain('openai');
    expect(ProdNonSSOAuthProviders).toContain('openai');
    expect(AllAuthMethodIds).toContain('openai');
  });

  test('uses the OpenAI logo for the ChatGPT sign-in icon', () => {
    expect((getProviderById('openai').icon as { type?: unknown }).type).toBe(OpenAILogo);
  });
});
