import { useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { Globe } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { chatFlagValueOf } from '@/lib/chat/chat-flag';
import { setChatFlag } from '@/lib/chat/registry';
import { type ChatPlace } from '@/lib/chat/scope';
import { snapshotOf, watch } from '@/lib/chat/state';
import { webSearchDefault } from '@/lib/chat/web-search-setting';

export type WebSearchSetting = {
  readonly enabled: boolean;
  readonly setEnabled: (next: boolean) => void;
};

/**
 * The chat's web search switch, drawn from the flag the registry owns.
 *
 * The flag carries the choice on disk and whether this session is on it, so this
 * reads it instead of holding a boolean beside it: a tap shows at once, the
 * stored choice replaces it when the write lands, and a refused write puts the
 * stored choice back and says why. Nothing here reads the store, so a read can
 * never land over a tap — the registry does the reading, inside the chat's own
 * order.
 *
 * The model is still part of the answer: a chat nobody chose for draws the
 * model's default until a choice exists.
 */
export function useWebSearchSetting(
  place: ChatPlace | null,
  sessionId: string,
  model: string
): WebSearchSetting {
  const { t } = useTranslation();
  const flag = useSyncExternalStore(
    useCallback(listener => watch(sessionId, listener), [sessionId]),
    useCallback(() => snapshotOf(sessionId).webSearch, [sessionId])
  );

  const setEnabled = useCallback(
    (next: boolean) => {
      void (async () => {
        try {
          await setChatFlag({ sessionId, place, flag: 'webSearch', next });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'));
        }
      })();
    },
    [place, sessionId, t]
  );

  return { enabled: chatFlagValueOf(flag, webSearchDefault(model)), setEnabled };
}

/** The tools-sheet switch for web search in this chat. */
export function WebSearchRow({ setting }: Readonly<{ setting: WebSearchSetting }>) {
  const { t } = useTranslation();
  return (
    <PreferenceRow
      icon={Globe}
      title={t('modelChat.webSearch.title')}
      subtitle={t('modelChat.webSearch.description')}
      value={setting.enabled}
      disabled={false}
      onValueChange={next => {
        setting.setEnabled(next);
      }}
    />
  );
}
