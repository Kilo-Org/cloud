import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { triggerSaveFailure } from '@/lib/cloud-triggers/trigger-save-failure';

/** The shape the tRPC client rejects with once it has a server answer. */
function serverRefusal(code: string, message: string, zodError: unknown = null): Error {
  return Object.assign(new Error(message), {
    name: 'TRPCClientError',
    data: { code, message, zodError },
  });
}

/** The serialized issue array a validation refusal carries as its message. */
const ZOD_MESSAGE = JSON.stringify([
  {
    code: 'too_small',
    path: ['name'],
    message: 'Too small: expected string to have >=8 characters',
  },
]);

const nameTakenCopy = (name: string) => i18n.t('cloudAgent.triggers.nameTaken', { name });
const RETRY_COPY = i18n.t('cloudAgent.triggers.saveFailedRetry');
const CHECK_COPY = i18n.t('cloudAgent.triggers.saveFailedCheck');

describe('triggerSaveFailure', () => {
  it('names the taken trigger instead of quoting the conflict on a create', () => {
    expect(
      triggerSaveFailure(serverRefusal('CONFLICT', 'Trigger Name "take-one" already exists'), {
        mode: 'create',
        name: 'take-one',
      })
    ).toEqual({ kind: 'rejected', message: nameTakenCopy('take-one') });
  });

  it('keeps the server sentence for a conflict on an edit, where the name cannot change', () => {
    const sentence = 'This trigger was changed by another request';
    expect(
      triggerSaveFailure(serverRefusal('CONFLICT', sentence), { mode: 'edit', name: 'take-one' })
    ).toEqual({ kind: 'rejected', message: sentence });
  });

  it('states its own line for a validation refusal rather than the issue array', () => {
    const failure = triggerSaveFailure(serverRefusal('BAD_REQUEST', ZOD_MESSAGE, { issues: [] }), {
      mode: 'create',
      name: 'take-one',
    });

    expect(failure).toEqual({ kind: 'rejected', message: CHECK_COPY });
    expect(failure.message).not.toContain('[');
    expect(failure.message).not.toContain('"path"');
  });

  it('offers the retry for a server failure', () => {
    expect(
      triggerSaveFailure(serverRefusal('INTERNAL_SERVER_ERROR', 'Internal server error'), {
        mode: 'edit',
        name: 'take-one',
      })
    ).toEqual({ kind: 'retryable', message: RETRY_COPY });
  });

  it('offers the retry for a transport failure with no server answer', () => {
    expect(
      triggerSaveFailure(new Error('fetch failed'), { mode: 'create', name: 'take-one' })
    ).toEqual({ kind: 'retryable', message: RETRY_COPY });
  });

  it('keeps an authored refusal sentence on a code without its own line', () => {
    const sentence = 'Your role cannot change this trigger';
    expect(
      triggerSaveFailure(serverRefusal('FORBIDDEN', sentence), { mode: 'edit', name: 'take-one' })
    ).toEqual({ kind: 'rejected', message: sentence });
  });
});
