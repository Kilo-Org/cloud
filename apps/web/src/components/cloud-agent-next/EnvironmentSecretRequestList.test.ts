import { describe, expect, it } from '@jest/globals';
import {
  pendingSecretSave,
  secretReferenceUrl,
  variablesTextWithPendingKeys,
} from './EnvironmentSecretRequestList';

describe('variablesTextWithPendingKeys', () => {
  it('returns the text unchanged when there are no pending keys', () => {
    expect(variablesTextWithPendingKeys('EXISTING="a"', [])).toBe('EXISTING="a"');
  });

  it('appends an empty value line for each pending key', () => {
    expect(variablesTextWithPendingKeys('EXISTING="a"', ['API_KEY', 'DB_URL'])).toBe(
      'EXISTING="a"\nAPI_KEY=\nDB_URL='
    );
  });

  it('does not add a key that is already present', () => {
    expect(variablesTextWithPendingKeys('API_KEY="saved"', ['API_KEY'])).toBe('API_KEY="saved"');
  });

  it('adds a separating newline only when the text does not end with one', () => {
    expect(variablesTextWithPendingKeys('EXISTING="a"\n', ['API_KEY'])).toBe(
      'EXISTING="a"\nAPI_KEY='
    );
  });

  it('starts from an empty text without a leading newline', () => {
    expect(variablesTextWithPendingKeys('', ['API_KEY'])).toBe('API_KEY=');
  });
});

describe('pendingSecretSave', () => {
  it('blocks an untouched seeded line before saving', () => {
    expect(
      pendingSecretSave([{ key: 'API_KEY', value: '' }], ['API_KEY'], new Set())
    ).toEqual({
      secrets: [],
      error: 'Enter a value for API_KEY or skip it.',
    });
  });

  it('lists every untouched pending key', () => {
    expect(
      pendingSecretSave(
        [
          { key: 'A', value: '' },
          { key: 'B', value: '' },
        ],
        ['A', 'B'],
        new Set()
      )
    ).toEqual({
      secrets: [],
      error: 'Enter a value for A, B or skip them.',
    });
  });

  it('drops a skipped key even when its seeded line still has no value', () => {
    expect(
      pendingSecretSave(
        [
          { key: 'A', value: '' },
          { key: 'B', value: 'secret' },
        ],
        ['A', 'B'],
        new Set(['A'])
      )
    ).toEqual({ secrets: [{ key: 'B', value: 'secret' }], error: null });
  });

  it('keeps a provided pending key', () => {
    expect(pendingSecretSave([{ key: 'A', value: 'secret' }], ['A'], new Set())).toEqual({
      secrets: [{ key: 'A', value: 'secret' }],
      error: null,
    });
  });
});

describe('secretReferenceUrl', () => {
  it('links a reference to the setup pull request branch', () => {
    expect(
      secretReferenceUrl(
        { repoFullName: 'Kilo-Org/kilocode', path: 'apps/web/.env.example', line: 12 },
        'kilo/environment-setup-abc123'
      )
    ).toBe(
      'https://github.com/Kilo-Org/kilocode/blob/kilo/environment-setup-abc123/apps/web/.env.example#L12'
    );
  });
});
