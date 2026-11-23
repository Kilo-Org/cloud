import { useTranslation } from 'react-i18next';

import { ConfigureRow } from '@/components/ui/configure-row';
import { Smartphone } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { useChatSyncGate } from '@/lib/chat/sync/use-chat-sync';
import { useChatPlace } from '@/lib/chat/use-chat';

/**
 * The "Sync chats across devices" switch: per account, off until the person
 * turns it on. The row draws one of the setting's own states — reading,
 * unreadable (ask again), on, off — so a switch that cannot be read never
 * reads as off.
 */
export function ChatSyncSettingRow() {
  const { t } = useTranslation();
  const place = useChatPlace();
  const gate = useChatSyncGate(place);
  if (gate.state.kind === 'failed') {
    return (
      <Section>
        <RowGroup>
          <ConfigureRow
            icon={Smartphone}
            title={t('modelChat.sync.settingTitle')}
            subtitle={t('modelChat.sync.settingUnreadable')}
            subtitleNumberOfLines={2}
            onPress={gate.state.retryable ? gate.state.retry : undefined}
          />
        </RowGroup>
      </Section>
    );
  }
  return (
    <Section>
      <RowGroup>
        <PreferenceRow
          testID="chat-sync-setting"
          title={t('modelChat.sync.settingTitle')}
          subtitle={t('modelChat.sync.settingDescription')}
          value={gate.state.kind === 'on'}
          disabled={place === null || gate.state.kind === 'loading'}
          busy={gate.state.kind === 'loading'}
          onValueChange={next => {
            void gate.decide(next ? 'on' : 'off');
          }}
        />
      </RowGroup>
    </Section>
  );
}
