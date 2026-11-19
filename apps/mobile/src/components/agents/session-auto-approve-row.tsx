import { useTranslation } from 'react-i18next';

import { RowFrame } from '@/components/ui/row-frame';

import { type SessionAutoApproveState } from './session-auto-approve';

/**
 * Per-session auto-approve toggle: title + subtitle on the left, a native
 * `Switch` on the right, on the shared row frame inside the caller's
 * `RowGroup`. A selection haptic is a capability both iOS and Android have, so
 * there is one implementation: the trailing cell ticks it once per flip.
 * Disabled and labelled "unavailable" for a session that cannot receive
 * permission asks.
 *
 * The row carries no leading `IconTile`: it has never had one, and the session
 * header has no icon to give it.
 */
export function SessionAutoApproveRow({
  state,
  onValueChange,
}: Readonly<{
  state: SessionAutoApproveState;
  onValueChange: (value: boolean) => void;
}>) {
  const { t } = useTranslation();
  const title = t('agentChat.autoApprove.title');
  return (
    <RowFrame
      testID="session-auto-approve-row"
      title={title}
      subtitle={{
        text:
          state === 'unavailable'
            ? t('agentChat.autoApprove.unavailable')
            : t('agentChat.autoApprove.description'),
      }}
      trailing={{
        kind: 'switch',
        testID: 'session-auto-approve-switch',
        accessibilityLabel: title,
        value: state === 'on',
        disabled: state === 'unavailable',
        onValueChange,
      }}
    />
  );
}
