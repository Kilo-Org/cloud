import { describe, expect, it } from 'vitest';

import { resolveCloneImportFailureKey } from './remote-instance-spawn-classifier';

// The bare strings below are the CLI's pinned deliverable literals, written
// out by hand (not read from `CLOUD_SESSION_*_LITERAL`). If a constant drifts
// off its pinned string, the classifier no longer matches these inputs and
// falls back to the import-failed key, so every assertion here fails on the
// drift.
describe('resolveCloneImportFailureKey', () => {
  it('maps cloud session not found to the not-found key', () => {
    expect(resolveCloneImportFailureKey('cloud session not found')).toBe('common.notFound');
  });

  it('maps cloud session import unauthorized to the access-denied key', () => {
    expect(resolveCloneImportFailureKey('cloud session import unauthorized')).toBe(
      'common.accessDenied'
    );
  });

  it('maps cloud session import access denied to the access-denied key', () => {
    expect(resolveCloneImportFailureKey('cloud session import access denied')).toBe(
      'common.accessDenied'
    );
  });

  it('maps cloud session import failed to the import-failed key', () => {
    expect(resolveCloneImportFailureKey('cloud session import failed')).toBe(
      'agentChat.newSession.importFailed'
    );
  });

  it('maps every other delivered string to the import-failed key', () => {
    expect(resolveCloneImportFailureKey('some unrelated delivered error')).toBe(
      'agentChat.newSession.importFailed'
    );
  });
});
