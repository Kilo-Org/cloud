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
    expect(LinkableAuthProviders[0]?.id).toBe('anaconda');
    expect(OAuthProviderIds[0]).toBe('anaconda');
    expect(ProdNonSSOAuthProviders[0]).toBe('anaconda');
    expect(AllAuthMethodIds).toContain('anaconda');
  });
});
