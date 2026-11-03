import { describe, expect, it } from 'vitest';

import {
  buildCreateRemoteSessionInput,
  resolveCloneCapabilityRefusal,
  resolveCloneImportFailureKey,
} from './remote-instance-spawn-classifier';

// The bare strings below are the CLI's pinned deliverable literals, written
// out by hand (not read from `CLOUD_SESSION_*_LITERAL`). If a constant drifts
// off its pinned string, the classifier no longer matches these inputs and
// falls back to the import-failed key, so the literal-matching assertions here
// catch the drift.
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

  it('maps cloud session cut not found to the retryable not-saved-yet key', () => {
    expect(resolveCloneImportFailureKey('cloud session cut not found')).toBe(
      'agentChat.newSession.forkCutNotSynced'
    );
  });

  it('maps every other delivered string to the import-failed key', () => {
    expect(resolveCloneImportFailureKey('some unrelated delivered error')).toBe(
      'agentChat.newSession.importFailed'
    );
  });
});

describe('resolveCloneCapabilityRefusal', () => {
  const clone = { cloneFromKiloSessionId: 'ses_source' };
  const fork = { ...clone, cloneUpToMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn' };

  it('allows a non-clone spawn on any instance', () => {
    expect(resolveCloneCapabilityRefusal({}, { capabilities: { sessionClone: false } })).toBeNull();
  });

  it('keeps a full clone optimistic: only an explicit sessionClone false refuses', () => {
    expect(resolveCloneCapabilityRefusal(clone, {})).toBeNull();
    expect(
      resolveCloneCapabilityRefusal(clone, { capabilities: { sessionClone: true } })
    ).toBeNull();
    expect(resolveCloneCapabilityRefusal(clone, { capabilities: { sessionClone: false } })).toBe(
      'agentChat.newSession.cliCannotContinue'
    );
  });

  it('fails a fork cut closed unless the CLI advertises sessionCloneAtMessage', () => {
    expect(resolveCloneCapabilityRefusal(fork, {})).toBe('agentChat.newSession.cliCannotFork');
    expect(resolveCloneCapabilityRefusal(fork, { capabilities: { sessionClone: true } })).toBe(
      'agentChat.newSession.cliCannotFork'
    );
    expect(
      resolveCloneCapabilityRefusal(fork, {
        capabilities: { sessionClone: true, sessionCloneAtMessage: false },
      })
    ).toBe('agentChat.newSession.cliCannotFork');
    expect(
      resolveCloneCapabilityRefusal(fork, {
        capabilities: { sessionClone: true, sessionCloneAtMessage: true },
      })
    ).toBeNull();
  });

  it('reports the missing clone capability before the missing cut capability', () => {
    expect(resolveCloneCapabilityRefusal(fork, { capabilities: { sessionClone: false } })).toBe(
      'agentChat.newSession.cliCannotContinue'
    );
  });
});

describe('buildCreateRemoteSessionInput clone cut', () => {
  it('sends the cut beside the clone source', () => {
    expect(
      buildCreateRemoteSessionInput({
        cloneFromKiloSessionId: 'ses_source',
        cloneUpToMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      })
    ).toEqual({
      cloneFromKiloSessionId: 'ses_source',
      cloneUpToMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });
  });

  it('drops a cut without a clone source', () => {
    expect(
      buildCreateRemoteSessionInput({ cloneUpToMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn' })
    ).toBeUndefined();
  });

  it('keeps a full clone without a cut field', () => {
    expect(buildCreateRemoteSessionInput({ cloneFromKiloSessionId: 'ses_source' })).toEqual({
      cloneFromKiloSessionId: 'ses_source',
    });
  });
});
