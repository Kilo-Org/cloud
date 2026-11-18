import {
  buildEnvironmentVariableChanges,
  parseEnvironmentVariables,
} from './environment-variables';
import {
  omitUnresolvedSeededSecrets,
  secretReferenceUrl,
  seedPendingSecretKeys,
} from './environment-setup-secrets';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';

function request(
  key: string,
  state: 'pending' | 'provided' | 'skipped' = 'pending'
): SetupRunResponse['secretRequests'][number] {
  return {
    key,
    state,
    reason: 'Required for setup',
    references: [],
    highPrivilege: false,
    requestedAt: '2026-11-04T00:00:00Z',
  };
}

describe('pending setup secrets', () => {
  it('accepts an empty value and seeds only missing pending keys', () => {
    expect(parseEnvironmentVariables('MISSING=')).toEqual([{ key: 'MISSING', value: '' }]);
    expect(
      seedPendingSecretKeys('EXISTING=<unchanged>', [
        request('EXISTING'),
        request('FIRST'),
        request('PROVIDED', 'provided'),
        request('SKIPPED', 'skipped'),
      ])
    ).toEqual({ text: 'EXISTING=<unchanged>\nFIRST=', seededKeys: ['FIRST'] });
  });

  it('saves a partial entry without creating an empty secret for an untouched request', () => {
    const seeded = seedPendingSecretKeys('EXISTING=<unchanged>', [
      request('FIRST'),
      request('SECOND'),
    ]);
    const text = seeded.text.replace('FIRST=', 'FIRST=restricted-value');
    const changes = buildEnvironmentVariableChanges(
      omitUnresolvedSeededSecrets(text, seeded.seededKeys, []),
      [],
      ['EXISTING']
    );
    expect(changes.secrets).toEqual([{ key: 'FIRST', value: 'restricted-value' }]);
    expect(changes.keys).toEqual(['FIRST', 'EXISTING']);
  });

  it('omits explicitly skipped seeded values even when they were entered', () => {
    const filtered = omitUnresolvedSeededSecrets(
      'FIRST=discard-this-value\nSECOND=',
      ['FIRST', 'SECOND'],
      ['FIRST']
    );
    expect(buildEnvironmentVariableChanges(filtered, [], []).secrets).toEqual([]);
  });

  it('keeps the general empty-value contract for variables that were not seeded', () => {
    const filtered = omitUnresolvedSeededSecrets('EMPTY=\nPENDING=', ['PENDING'], []);
    expect(buildEnvironmentVariableChanges(filtered, [], []).secrets).toEqual([
      { key: 'EMPTY', value: '' },
    ]);
  });

  it('deletes a previously saved seeded secret when Skip follows a failed resolution call', () => {
    const filtered = omitUnresolvedSeededSecrets('FIRST=previously-saved', ['FIRST'], ['FIRST']);
    expect(buildEnvironmentVariableChanges(filtered, [], ['FIRST']).secrets).toEqual([
      { key: 'FIRST', delete: true },
    ]);
  });

  it('retains multiline values and hidden secrets when filtering pending keys', () => {
    const filtered = omitUnresolvedSeededSecrets(
      'CONFIG="first\nsecond"\nHIDDEN=<unchanged>\nPENDING=',
      ['PENDING'],
      []
    );
    expect(parseEnvironmentVariables(filtered)).toEqual([
      { key: 'CONFIG', value: 'first\nsecond' },
      { key: 'HIDDEN', value: '<unchanged>', unchanged: true },
    ]);
  });

  it('links references to the default branch', () => {
    const reference = { repoFullName: 'org/repo', path: 'config/.env.example', line: 4 };
    expect(secretReferenceUrl(reference)).toBe(
      'https://github.com/org/repo/blob/HEAD/config/.env.example#L4'
    );
  });
});
