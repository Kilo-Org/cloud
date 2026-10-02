import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import {
  resolveComposerSendDisabledReason,
  resolveComposerSendDisabledReasonTone,
} from './session-composer-send-disabled-reason';

const readOnly = {
  canSend: false,
  isReadOnly: true,
  error: null,
  statusIndicator: null,
  cloudStatus: null,
} as const;

describe('resolveComposerSendDisabledReason — read-only session', () => {
  // A read-only session is a permanent fact the SDK latches `canSend` false
  // for. Without a read-only input the reason collapsed to the generic
  // "not ready yet" line, so the reader was told a session that can never send
  // would become ready. It must name read-only instead.
  it('names read-only instead of the not-ready line', () => {
    expect(resolveComposerSendDisabledReason(readOnly)).toBe(i18n.t('agentChat.session.readOnly'));
    expect(resolveComposerSendDisabledReasonTone(readOnly)).toBe('neutral');
  });

  it('does not override a load failure with read-only', () => {
    // The load-error state resolves read-only while its snapshot fetch fails,
    // so the reader must still be told to Retry, not merely that the session is
    // read-only.
    expect(resolveComposerSendDisabledReason({ ...readOnly, error: 'fetch failed' })).toBe(
      i18n.t('agentChat.composer.sessionLoadFailed')
    );
  });

  it('leaves a sendable session without a reason', () => {
    expect(resolveComposerSendDisabledReason({ ...readOnly, canSend: true })).toBeNull();
    expect(resolveComposerSendDisabledReasonTone({ ...readOnly, canSend: true })).toBeNull();
  });
});
