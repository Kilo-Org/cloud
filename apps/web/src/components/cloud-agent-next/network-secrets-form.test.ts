import { describe, expect, it } from '@jest/globals';
import {
  emptyNetworkSecretForm,
  hasPendingNetworkSecret,
  buildNetworkSecretChanges,
} from './network-secrets-form';

describe('network secret form state', () => {
  it('blocks an outer save for every unsubmitted form field', () => {
    expect(hasPendingNetworkSecret(emptyNetworkSecretForm)).toBe(false);
    expect(hasPendingNetworkSecret({ ...emptyNetworkSecretForm, key: 'NPM_TOKEN' })).toBe(true);
    expect(hasPendingNetworkSecret({ ...emptyNetworkSecretForm, secret: 'synthetic-value' })).toBe(
      true
    );
    expect(hasPendingNetworkSecret({ ...emptyNetworkSecretForm, domains: 'example.com' })).toBe(
      true
    );
    expect(hasPendingNetworkSecret({ ...emptyNetworkSecretForm, replacing: true })).toBe(true);
  });
  it('keeps a saved value unchanged until an explicit replacement or deletion', () => {
    const saved = [
      {
        key: 'NPM_TOKEN',
        allowedHosts: ['npm.pkg.github.com'],
        locations: ['header'] as ['header'],
      },
    ];
    expect(buildNetworkSecretChanges(saved, saved)).toEqual([]);
    expect(buildNetworkSecretChanges(saved, [])).toEqual([{ key: 'NPM_TOKEN', delete: true }]);
  });
});
