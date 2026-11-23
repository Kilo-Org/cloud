import { useTranslation } from 'react-i18next';

import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { useChatSyncGate } from '@/lib/chat/sync/use-chat-sync';
import { useChatPlace } from '@/lib/chat/use-chat';

/**
 * The "Sync chats across devices" switch: per account, off until the person
 * turns it on, and only drawn while the rollout flag is on for them.
 */
export function ChatSyncSettingRow() {
  const { t } = useTranslation();
  const place = useChatPlace();
  const gate = useChatSyncGate(place);
  if (!gate.flagOn) {
    return null;
  }
  return (
    <Section>
      <RowGroup>
        <PreferenceRow
          testID="chat-sync-setting"
          title={t('modelChat.sync.settingTitle')}
          subtitle={t('modelChat.sync.settingDescription')}
          value={gate.setting.kind === 'on'}
          disabled={place === null}
          onValueChange={next => {
            void gate.decide(next ? 'on' : 'off');
          }}
        />
      </RowGroup>
    </Section>
  );
}
