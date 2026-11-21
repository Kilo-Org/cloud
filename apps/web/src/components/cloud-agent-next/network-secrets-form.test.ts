import { describe, expect, it } from '@jest/globals';
import {
  emptyNetworkSecretForm,
  hasPendingNetworkSecret,
  buildNetworkSecretChanges,
  draftAfterFailedSave,
  networkSecretSaveFailureMessage,
  saveNetworkSecretChanges,
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
  it('applies every change after a failure and retries only the failed change', async () => {
    const locations: ['header'] = ['header'];
    const saved = [{ key: 'OLD_TOKEN', allowedHosts: ['old.example.com'], locations }];
    const draft = [
      { key: 'NEW_TOKEN', allowedHosts: ['new.example.com'], locations, value: 'synthetic-new' },
      { key: 'API_KEY', allowedHosts: ['api.example.com'], locations, value: 'synthetic-api' },
    ];
    const applied: string[] = [];
    const failures = await saveNetworkSecretChanges(
      buildNetworkSecretChanges(saved, draft),
      async change => {
        applied.push(change.key);
        if (change.key === 'NEW_TOKEN') throw new Error('Profiles are limited to 50 variables');
      }
    );

    expect(applied).toEqual(['OLD_TOKEN', 'NEW_TOKEN', 'API_KEY']);
    expect(failures).toEqual([
      { key: 'NEW_TOKEN', message: 'Profiles are limited to 50 variables' },
    ]);
    expect(networkSecretSaveFailureMessage(failures, 3)).toBe(
      'Could not save NEW_TOKEN: Profiles are limited to 50 variables. Your other changes were saved.'
    );

    const savedAfter = [{ key: 'API_KEY', allowedHosts: ['api.example.com'], locations }];
    expect(buildNetworkSecretChanges(savedAfter, draftAfterFailedSave(draft, failures))).toEqual([
      { key: 'NEW_TOKEN', allowedHosts: ['new.example.com'], locations, value: 'synthetic-new' },
    ]);
  });
});
