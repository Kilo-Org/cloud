import { describe, expect, it } from 'vitest';

import { type SdkStatusMessageCode } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

import {
  resolveComposerSendDisabledReason,
  resolveComposerSendDisabledReasonTone,
} from './session-composer-send-disabled-reason';
import { sessionStatusErrorMessage, statusCopyKeyForCode } from './session-terminal-error';

const idle = {
  canSend: false,
  error: null,
  statusIndicator: null,
  cloudStatus: null,
} as const;

/**
 * One representative message per `TerminalErrorClass`, paired with the catalog
 * key its class copy resolves to. `messageCount` is non-zero so the terminal
 * failure on a running session keeps its own reason instead of collapsing to
 * the load-failure line.
 */
const CLASS_CASES: [string, string, string][] = [
  [
    'permission',
    'You are not authorized to use the Cloud Agent.',
    'queryError.permissionDescription',
  ],
  [
    'credits',
    'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
    'agentChat.session.notEnoughCredits',
  ],
  [
    'busy',
    'Previous task is still finishing up. Please wait a moment.',
    'agentChat.session.previousTaskFinishing',
  ],
  [
    'model',
    'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.',
    'agentChat.session.modelUnavailable',
  ],
  ['gone', 'This session is no longer available.', 'queryError.notFoundDescription'],
  [
    'unavailable',
    'Service is unavailable right now. Please try again.',
    'agentChat.session.serviceUnavailable',
  ],
  [
    'transient',
    'Connection lost. Please retry in a moment.',
    'agentChat.session.connectionTrouble',
  ],
  ['unknown', 'some unexpected failure', 'agentChat.messageFailure.assistantFailed'],
];

/** One code per entry in `STATUS_COPY_KEY_BY_CODE`, with its catalog key. */
const STATUS_CASES: [SdkStatusMessageCode, string][] = [
  ['agent-connection-lost', 'agentChat.sessionConnection.connectionLost'],
  ['session-stopped', 'agentChat.session.stopped'],
  ['message-delivery-failed', 'agentChat.messageFailure.deliveryTitle'],
  ['setting-up-environment', 'agentChat.composer.preparingPlaceholder'],
  ['wrapping-up', 'agentChat.composer.finalizingPlaceholder'],
  ['committing', 'agentChat.session.committing'],
  ['committed', 'agentChat.session.committed'],
  ['commit-failed', 'agentChat.session.commitFailed'],
  ['failed-to-stop-execution', 'agentChat.session.failedToStopExecution'],
];

describe('resolveComposerSendDisabledReason', () => {
  it('pins the load-failure copy', () => {
    expect(i18n.t('agentChat.composer.sessionLoadFailed')).toBe(
      'The session could not be loaded. Retry first.'
    );
  });

  it('returns null only while the session can send', () => {
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        canSend: true,
        error: 'fetch failed',
        statusIndicator: { type: 'error', message: 'Service is unavailable right now.' },
      })
    ).toBeNull();
  });

  it('states the load failure for the error atom', () => {
    expect(resolveComposerSendDisabledReason({ ...idle, error: 'fetch failed' })).toBe(
      i18n.t('agentChat.composer.sessionLoadFailed')
    );
  });

  it('states the load failure for a terminal error on an empty transcript', () => {
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        messageCount: 0,
        statusIndicator: {
          type: 'error',
          message: 'Connection lost. Please retry in a moment.',
          code: 'connection-lost',
        },
      })
    ).toBe(i18n.t('agentChat.composer.sessionLoadFailed'));
  });

  it('states the load failure for a terminal error with no message', () => {
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        statusIndicator: { type: 'error', message: '' },
      })
    ).toBe(i18n.t('agentChat.composer.sessionLoadFailed'));
  });

  // A non-retryable class on an empty transcript is the full-screen error that
  // offers no Retry, so the reason beside send states the class instead of
  // telling the reader to Retry an action the screen does not provide.
  it.each([
    [
      'credits',
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
      'agentChat.session.notEnoughCredits',
    ],
    [
      'permission',
      'You are not authorized to use the Cloud Agent.',
      'queryError.permissionDescription',
    ],
    [
      'model',
      'Selected model is unavailable for Cloud Agent.',
      'agentChat.session.modelUnavailable',
    ],
    ['gone', 'This session is no longer available.', 'queryError.notFoundDescription'],
  ])('states the %s class for a non-retryable empty-transcript failure', (_cls, message, key) => {
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        messageCount: 0,
        statusIndicator: { type: 'error', message },
      })
    ).toBe(i18n.t(key));
  });

  it('states the coded class for a non-retryable empty-transcript failure', () => {
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        messageCount: 0,
        statusIndicator: { type: 'error', message: '', code: 'insufficient-credits' },
      })
    ).toBe(i18n.t('agentChat.session.notEnoughCredits'));
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        messageCount: 0,
        statusIndicator: { type: 'error', message: '', code: 'selected-model-unavailable' },
      })
    ).toBe(i18n.t('agentChat.session.modelUnavailable'));
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        messageCount: 0,
        statusIndicator: { type: 'error', message: '', code: 'not-authorized' },
      })
    ).toBe(i18n.t('queryError.permissionDescription'));
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        messageCount: 0,
        statusIndicator: { type: 'error', message: '', code: 'child-session-not-found' },
      })
    ).toBe(i18n.t('queryError.notFoundDescription'));
  });

  it('states the preparing phase for cloud setup', () => {
    expect(resolveComposerSendDisabledReason({ ...idle, cloudStatus: { type: 'preparing' } })).toBe(
      i18n.t('agentChat.composer.preparingPlaceholder')
    );
  });

  it('states the finalizing phase for cloud teardown', () => {
    expect(
      resolveComposerSendDisabledReason({ ...idle, cloudStatus: { type: 'finalizing' } })
    ).toBe(i18n.t('agentChat.composer.finalizingPlaceholder'));
  });

  it.each(CLASS_CASES)('renders the class copy for %s', (_cls, message, key) => {
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        messageCount: 5,
        statusIndicator: { type: 'error', message },
      })
    ).toBe(i18n.t(key));
  });

  it.each(STATUS_CASES)('renders the status copy for %s', (code, key) => {
    expect(statusCopyKeyForCode(code)).toBe(key);
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        statusIndicator: { type: 'progress', message: 'ignored', code },
      })
    ).toBe(i18n.t(key));
  });

  it('renders no line for an unresolved session', () => {
    expect(resolveComposerSendDisabledReason(idle)).toBeNull();
    expect(resolveComposerSendDisabledReasonTone(idle)).toBeNull();
  });

  it('never returns null for an actionable cannot-send state', () => {
    const classInputs = CLASS_CASES.map(([, message]) => ({
      canSend: false,
      error: null,
      statusIndicator: { type: 'error' as const, message },
      cloudStatus: null,
      messageCount: 5,
    }));
    const statusInputs = STATUS_CASES.map(([code]) => ({
      canSend: false,
      error: null,
      statusIndicator: { type: 'error' as const, message: 'x', code },
      cloudStatus: null,
    }));
    const inputs = [
      { canSend: false, error: 'fetch failed', statusIndicator: null, cloudStatus: null },
      {
        canSend: false,
        error: null,
        statusIndicator: null,
        cloudStatus: { type: 'preparing' as const },
      },
      {
        canSend: false,
        error: null,
        statusIndicator: null,
        cloudStatus: { type: 'finalizing' as const },
      },
      ...classInputs,
      ...statusInputs,
    ];
    for (const input of inputs) {
      expect(resolveComposerSendDisabledReason(input)).not.toBeNull();
    }
  });

  it('keeps a live error atom on a loaded transcript off the load-failure line', () => {
    // service-state.ts sets the error atom for live service failures too
    // ('Connection to agent lost'); a transcript means the session loaded, so
    // the reader gets its own cannot-send reason, not the load-failure copy.
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        error: 'Connection to agent lost',
        messageCount: 3,
        statusIndicator: {
          type: 'error',
          message: 'Connection lost. Please retry in a moment.',
          code: 'agent-connection-lost',
        },
      })
    ).toBe(i18n.t('agentChat.sessionConnection.connectionLost'));
    expect(
      resolveComposerSendDisabledReason({
        ...idle,
        error: 'Connection to agent lost',
        messageCount: 3,
        statusIndicator: { type: 'error', message: 'Something odd happened.' },
      })
    ).not.toBe(i18n.t('agentChat.composer.sessionLoadFailed'));
  });

  it('resolves the transcript status line, never a load-failure line', () => {
    // The transcript's status surface resolves the same indicator through
    // `sessionStatusErrorMessage`: an uncoded unknown failure is the
    // assistant-failure line (not the page-load line) and the Durable Object's
    // safe projection passes through, so the reason beside Send reads the same.
    const unknown = { type: 'error' as const, message: 'Something odd happened.' };
    const safe = { type: 'error' as const, message: 'Workspace setup failed' };
    for (const statusIndicator of [unknown, safe]) {
      expect(resolveComposerSendDisabledReason({ ...idle, messageCount: 5, statusIndicator })).toBe(
        sessionStatusErrorMessage(statusIndicator)
      );
    }
    expect(sessionStatusErrorMessage(unknown)).toBe(
      i18n.t('agentChat.messageFailure.assistantFailed')
    );
    expect(sessionStatusErrorMessage(safe)).toBe('Workspace setup failed');
  });

  it('paints the load failure and runtime classes in the error tone', () => {
    expect(
      resolveComposerSendDisabledReasonTone({ ...idle, error: 'fetch failed', messageCount: 0 })
    ).toBe('error');
    expect(
      resolveComposerSendDisabledReasonTone({
        ...idle,
        messageCount: 5,
        statusIndicator: {
          type: 'error',
          message: 'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
        },
      })
    ).toBe('error');
  });

  it('keeps progress phases in the neutral tone', () => {
    expect(
      resolveComposerSendDisabledReasonTone({ ...idle, cloudStatus: { type: 'preparing' } })
    ).toBe('neutral');
    expect(
      resolveComposerSendDisabledReasonTone({ ...idle, cloudStatus: { type: 'finalizing' } })
    ).toBe('neutral');
    expect(
      resolveComposerSendDisabledReasonTone({
        ...idle,
        statusIndicator: { type: 'progress', message: 'ignored', code: 'setting-up-environment' },
      })
    ).toBe('neutral');
  });

  it('returns no tone while the session can send', () => {
    expect(resolveComposerSendDisabledReasonTone({ ...idle, canSend: true })).toBeNull();
  });
});
