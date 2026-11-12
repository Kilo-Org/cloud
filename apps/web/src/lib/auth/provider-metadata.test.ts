import { describe, expect, test } from '@jest/globals';
import { OpenAILogo } from '@/components/auth/OpenAILogo';
import {
  AccountLinkingProviders,
  AllAuthMethodIds,
  AuthProviderIdSchema,
  LinkableAuthProviders,
  OAuthProviderIds,
  ProdNonSSOAuthProviders,
  getProviderById,
  isAccountLinkingProvider,
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

describe('account linking provider list', () => {
  test('offers Apple for linking through the pending completion bounce', () => {
    expect(OAuthProviderIds).toContain('apple');
    expect(ProdNonSSOAuthProviders).toContain('apple');
    expect(isAccountLinkingProvider('apple')).toBe(true);
    expect(AccountLinkingProviders.map(p => p.id)).toContain('apple');
  });

  test('offers every linkable provider for linking', () => {
    const offered = AccountLinkingProviders.map(p => p.id);
    for (const provider of LinkableAuthProviders) {
      expect(offered).toContain(provider.id);
      expect(isAccountLinkingProvider(provider.id)).toBe(true);
    }
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
