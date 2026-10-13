import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { Globe } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { setWebSearchEnabled } from '@/lib/chat/registry';
import { webSearchDefault, webSearchEnabledFor } from '@/lib/chat/web-search-setting';

export type WebSearchSetting = {
  readonly enabled: boolean;
  readonly setEnabled: (next: boolean) => void;
};

/**
 * The chat's web search choice, read per session and model.
 *
 * The model is part of the read because a chat whose person never chose takes
 * the model's default, so picking another model can flip the switch on screen.
 * The switch moves at once; a write or move that fails puts it back and says why.
 */
export function useWebSearchSetting(sessionId: string, model: string): WebSearchSetting {
  const { t } = useTranslation();
  const [enabled, setEnabledState] = useState(() => webSearchDefault(model));

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const stored = await webSearchEnabledFor(sessionId, model);
      if (!cancelled) {
        setEnabledState(stored);
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [sessionId, model]);

  const setEnabled = useCallback(
    (next: boolean) => {
      const previous = enabled;
      setEnabledState(next);
      void (async () => {
        try {
          await setWebSearchEnabled(sessionId, next);
        } catch (error) {
          setEnabledState(previous);
          toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'));
        }
      })();
    },
    [enabled, sessionId, t]
  );

  return { enabled, setEnabled };
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
