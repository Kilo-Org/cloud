import { describe, expect, test } from '@jest/globals';
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
    expect(LinkableAuthProviders.map(provider => provider.id)).toContain('anaconda');
    expect(OAuthProviderIds).toContain('anaconda');
    expect(ProdNonSSOAuthProviders).toContain('anaconda');
    expect(AllAuthMethodIds).toContain('anaconda');
  });
});
